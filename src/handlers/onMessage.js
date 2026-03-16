//###################################################################################
// src/handlers/onMessage.js
//###################################################################################
"use strict";

const { getRules } = require("../services/responsesStore");
const { decideReply, getSpecial, normalizeText } = require("../services/router");
const { logFallback } = require("../services/fallbackLog");
const { getAccessByChatId } = require("../services/bpLookup");

//###################################################################################
// Config
//###################################################################################
const CLOSE_AFTER_MS = 30 * 60 * 1000; // 30 minutos
const FALLBACK_DEFAULT =
  "Ups, não percebi o que me perguntaste!\n\nTenta perguntar de outra forma, por favor.";

const DEBUG_BP_ROW = String(process.env.DEBUG_BP_ROW || "false").toLowerCase() === "true";

const AGENDA_FOLLOWUP_TEXT =
  "Gostavas de conhecer a programação de algum departamento em específico?\n\n" +
  "Se sim, escreve '*Agenda Departamentos*'. Se preferires, podes também fazer outra pergunta sobre qualquer outro assunto que te interesse.";

//###################################################################################
// Menu triggers
//###################################################################################
const MENU_TRIGGER_TEXTS = [
  "menu",
  "menu de informacoes",
  "menu de informações",
  "informacoes",
  "informações",
  "informação",
];

function shouldSendMenuNow_v1(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;
  if (MENU_TRIGGER_TEXTS.includes(t)) return true;
  return MENU_TRIGGER_TEXTS.some((x) => t.includes(x));
}

//###################################################################################
// Saudação conforme horário local (Europe/Lisbon)
//###################################################################################
function getDayGreetingPt_v1() {
  try {
    const parts = new Intl.DateTimeFormat("pt-PT", {
      timeZone: "Europe/Lisbon",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(new Date());

    const hourStr = parts.find((p) => p.type === "hour")?.value || "12";
    const h = Number(hourStr);

    if (h >= 5 && h <= 11) return "bom dia";
    if (h >= 12 && h <= 17) return "boa tarde";
    return "boa noite";
  } catch (_) {
    const h = new Date().getHours();
    if (h >= 5 && h <= 11) return "bom dia";
    if (h >= 12 && h <= 17) return "boa tarde";
    return "boa noite";
  }
}

function getFirstName_v1(fullName) {
  const s = String(fullName || "").trim();
  if (!s) return "";
  return s.split(/\s+/g)[0] || s;
}

//###################################################################################
// Filtros
//###################################################################################
function isIgnoredChat(from, cfg) {
  if (!from) return true;
  if (from === "status@broadcast") return true;
  if (from.endsWith("@g.us")) return true;
  if (from.endsWith("@lid") && cfg?.ignoreLid) return true;
  return false;
}

//###################################################################################
// Validação cfg
//###################################################################################
function validateCfgOrThrow(cfg) {
  const missing = [];

  if (!cfg?.spreadsheetId) missing.push("spreadsheetId");
  if (!cfg?.sheetNameResp) missing.push("sheetNameResp");
  if (cfg?.cacheSeconds === undefined || cfg?.cacheSeconds === null) missing.push("cacheSeconds");

  if (!cfg?.sheetNameBp) missing.push("sheetNameBp");
  if (cfg?.cacheBpSeconds === undefined || cfg?.cacheBpSeconds === null) missing.push("cacheBpSeconds");

  cfg.sheetNameAusencias = String(cfg?.sheetNameAusencias || process.env.SHEET_NAME_AUSENCIAS || "").trim();
  cfg.sheetNameEnsaio = String(cfg?.sheetNameEnsaio || process.env.SHEET_NAME_ENSAIO || "").trim();
  cfg.sheetNameAgenda = String(cfg?.sheetNameAgenda || process.env.SHEET_NAME_AGENDA || "").trim();

  if (missing.length) throw new Error(`[CFG_ERR] Campos em falta: ${missing.join(", ")}`);

  cfg.cacheSeconds = Number(cfg.cacheSeconds || 60);
  cfg.cacheBpSeconds = Number(cfg.cacheBpSeconds || 300);
  cfg.ignoreLid = Boolean(cfg.ignoreLid);

  cfg.cacheAusenciasSeconds = Number(cfg.cacheAusenciasSeconds || process.env.CACHE_AUSENCIAS_SECONDS || 300);
  cfg.cacheEnsaioSeconds = Number(cfg.cacheEnsaioSeconds || process.env.CACHE_ENSAIO_SECONDS || 300);
  cfg.cacheAgendaSeconds = Number(cfg.cacheAgendaSeconds || process.env.CACHE_AGENDA_SECONDS || 300);
}

//###################################################################################
// Estado em memória
//###################################################################################
const greeted = new Set();
const closeTimers = new Map();
const closedChats = new Set();

//###################################################################################
// Reset do estado do chat
//###################################################################################
function resetChatState(chatId) {
  greeted.delete(chatId);
}

//###################################################################################
// Envio seguro
//###################################################################################
async function safeSend(client, chatId, text) {
  const msg = String(text || "").trim();
  if (!msg) return false;
  await client.sendMessage(chatId, msg);
  return true;
}

//###################################################################################
// Timer (CLOSE_TEXT vem da sheet RESPONSES: SPECIAL/CLOSE_TEXT)
//###################################################################################
function clearCloseTimer(chatId) {
  const t = closeTimers.get(chatId);
  if (t) clearTimeout(t);
  closeTimers.delete(chatId);
}

function resetCloseTimer(client, chatId, closeText) {
  if (closedChats.has(chatId)) return;

  clearCloseTimer(chatId);

  const closeMsg = String(closeText || "").trim();

  const t = setTimeout(async () => {
    try {
      if (closedChats.has(chatId)) return;

      if (closeMsg) await safeSend(client, chatId, closeMsg);

      closedChats.add(chatId);
      resetChatState(chatId);
      clearCloseTimer(chatId);

      console.log("[CLOSE_AUTO]", chatId, closeMsg ? "" : "(sem CLOSE_TEXT na sheet)");
    } catch (e) {
      console.log("[CLOSE_ERR]", e?.message || e);
    }
  }, CLOSE_AFTER_MS);

  closeTimers.set(chatId, t);
}

//###################################################################################
// Filtrar regras por ACCESS
//###################################################################################
function filterRulesByAccess(rules, isColab) {
  const colab = Boolean(isColab);
  return (rules || []).filter((r) => {
    const a = String(r.access || r.ACCESS || "PUBLIC").trim().toUpperCase();
    if (a === "COLAB") return colab;
    return true;
  });
}

//###################################################################################
// Helper matching
//###################################################################################
function tryDecideReply(bodyRaw, msgN, rules) {
  const r1 = decideReply(msgN, rules);
  if (r1) return r1;

  const r2 = decideReply(bodyRaw, rules);
  if (r2) return r2;

  return "";
}

//###################################################################################
// Utils p/ headers dinâmicos (sheet -> objeto)
//###################################################################################
function stripBomKey_v1(s) {
  return String(s || "").replace(/^\uFEFF/, "");
}

function normKey_v1(k) {
  return stripBomKey_v1(k)
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]/g, "");
}

function getValByNormKey_v1(obj, wantedNormKey) {
  if (!obj || typeof obj !== "object") return "";
  const wanted = String(wantedNormKey || "").toUpperCase();
  for (const k of Object.keys(obj)) {
    if (normKey_v1(k) === wanted) return obj[k];
  }
  return "";
}

//###################################################################################
// MATCH LOG: ID_TABLE
//###################################################################################
function normForCompare_v1(s) {
  return String(s || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function getIdTableFromRule_v1(rule) {
  if (!rule || typeof rule !== "object") return "";

  const direct =
    rule.ID_TABLE ??
    rule.id_table ??
    rule.idTable ??
    rule.IDTABLE ??
    rule.idtable ??
    rule.id ??
    rule.ID ??
    null;

  if (direct !== null && direct !== undefined && String(direct).trim() !== "") {
    return String(direct).trim();
  }

  const v = getValByNormKey_v1(rule, "IDTABLE");
  if (v !== null && v !== undefined && String(v).trim() !== "") {
    return String(v).trim();
  }

  return "";
}

function getReplyFromRule_v1(rule) {
  if (!rule || typeof rule !== "object") return "";
  const v = rule.reply ?? rule.REPLY ?? rule.resposta ?? rule.RESPOSTA ?? rule.text ?? rule.TEXTO ?? "";
  return String(v || "").trim();
}

function findMatchedRuleByReply_v1(rules, reply) {
  const rep = normForCompare_v1(reply);
  if (!rep) return null;

  for (const r of rules || []) {
    const rr = normForCompare_v1(getReplyFromRule_v1(r));
    if (rr && rr === rep) return r;
  }

  let best = null;
  let bestScore = 0;

  for (const r of rules || []) {
    const rr = normForCompare_v1(getReplyFromRule_v1(r));
    if (!rr) continue;

    if (rr.includes(rep) || rep.includes(rr)) {
      const score = Math.min(rr.length, rep.length);
      if (score > bestScore) {
        best = r;
        bestScore = score;
      }
    }
  }

  return best;
}

function logMatchedRule_v1({ chatId, rulesBase, reply }) {
  const repRaw = String(reply || "").trim();
  if (!repRaw) return;

  const rule = findMatchedRuleByReply_v1(rulesBase, repRaw);
  const idTable = rule ? getIdTableFromRule_v1(rule) : "";

  console.log(
    "[MATCH]",
    `chat=${chatId}`,
    idTable ? `idTable=${idTable}` : "idTable=",
    `reply=${JSON.stringify(repRaw)}`
  );
}

//###################################################################################
// Saudação via sheet RESPONSES (SPECIAL / CHAVE)
//###################################################################################
function getGreetFromSheet_v1(allRules, isColab) {
  const key = isColab ? "GREET_COLAB" : "GREET_PUBLIC";
  const fromSheet = String(getSpecial(allRules, key) || "").trim();

  if (fromSheet) return fromSheet;

  console.log("[GREET_MISSING]", `key=${key}`);
  return "Configuração em falta: saudação inicial não encontrada na sheet RESPONSES.";
}

//###################################################################################
// MENU
//###################################################################################
function parseBool_v1(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return false;
  return s === "true" || s === "1" || s === "sim" || s === "yes";
}

function buildColabMenu_AZ_Enumerated_v1(allRules) {
  const rules = Array.isArray(allRules) ? allRules : [];

  const rows = [];
  for (const r of rules) {
    const processo = String(getValByNormKey_v1(r, "PROCESSO") || "").trim();
    if (!processo) continue;

    const ativoVal = getValByNormKey_v1(r, "ATIVO");
    const hasAtivo = ativoVal !== "" && ativoVal !== null && ativoVal !== undefined;
    if (hasAtivo && !parseBool_v1(ativoVal)) continue;

    rows.push(processo);
  }

  const seen = new Set();
  const uniq = [];
  for (const p of rows) {
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(p);
  }

  uniq.sort((a, b) => a.localeCompare(b, "pt-PT", { sensitivity: "base" }));

  const lines = ["Menu:"];
  for (let i = 0; i < uniq.length; i++) lines.push(`${i + 1}- ${uniq[i]}`);
  lines.push("");
  lines.push("Escreve um número.");

  return lines.join("\n");
}

function getMenuText_v1(allRules, isColab) {
  if (isColab) return buildColabMenu_AZ_Enumerated_v1(allRules);

  const menuFromSheet = String(getSpecial(allRules, "MENU") || "").trim();
  if (menuFromSheet) return menuFromSheet;

  console.log("[MENU_MISSING]", "key=MENU");
  return "Configuração em falta: menu não encontrado na sheet RESPONSES.";
}

//###################################################################################
// Tokens (__AUSENCIAS__, __APP_ENSAIO__, __APP_AGENDA_FULL__) — RESOLVIDOS AQUI
//###################################################################################
function isActionToken_v1(reply) {
  const t = String(reply || "").trim();
  return /^__.+__$/.test(t);
}

async function resolveActionToken_v1({ cfg, token, fullName }) {
  const t = String(token || "").trim();

  // ---------------- AUSÊNCIAS ----------------
  if (t === "__AUSENCIAS__") {
    const sheetNameAusencias = String(cfg?.sheetNameAusencias || process.env.SHEET_NAME_AUSENCIAS || "").trim();
    if (!sheetNameAusencias) return "Não consegui consultar as tuas férias/ausências neste momento.";

    let mod = null;
    try {
      mod = require("../services/appAusencias");
    } catch (e) {
      console.log("[AUSENCIAS_ERR]", "module_not_found", e?.message || e);
      return "Não consegui consultar as tuas férias/ausências neste momento.";
    }

    if (typeof mod?.getAusenciasByFullName_v1 !== "function") {
      console.log("[AUSENCIAS_ERR]", "no_handler_found", Object.keys(mod || {}).join(","));
      return "Não consegui consultar as tuas férias/ausências neste momento.";
    }

    try {
      const data = await mod.getAusenciasByFullName_v1({
        spreadsheetId: cfg.spreadsheetId,
        sheetNameAusencias,
        fullName,
      });

      const upcoming = Array.isArray(data?.upcoming) ? data.upcoming : [];
      const last = data?.last || null;

      if (!upcoming.length && !last) return "Não encontrei férias/ausências registadas para ti.";

      const lines = [];

      if (upcoming.length) {
        lines.push("Próximas férias/ausências:");
        for (const x of upcoming) {
          const ini = x?.ini || "";
          const fim = x?.fim || "";
          const motivo = x?.motivo ? ` — ${x.motivo}` : "";
          const periodo = fim ? `${ini} a ${fim}` : ini;
          lines.push(`- ${periodo}${motivo}`);
        }
      } else {
        lines.push("Não encontrei férias/ausências futuras.");
      }

      if (last) {
        const ini = last?.ini || "";
        const fim = last?.fim || "";
        const motivo = last?.motivo ? ` — ${last.motivo}` : "";
        const periodo = fim ? `${ini} a ${fim}` : ini;
        lines.push("");
        lines.push(`Última ausência registada: ${periodo}${motivo}`);
      }

      return lines.join("\n");
    } catch (e) {
      console.log("[AUSENCIAS_ERR]", "getAusenciasByFullName_v1", e?.message || e);
      return "Não consegui consultar as tuas férias/ausências neste momento.";
    }
  }

  // ---------------- ENSAIO ----------------
  if (t === "__APP_ENSAIO__") {
    const sheetNameEnsaio = String(cfg?.sheetNameEnsaio || process.env.SHEET_NAME_ENSAIO || "").trim();
    if (!sheetNameEnsaio) return "Não consegui consultar o ensaio neste momento.";

    let mod = null;
    try {
      mod = require("../services/appEnsaio");
    } catch (e) {
      console.log("[ENSAIO_ERR]", "module_not_found", e?.message || e);
      return "Não consegui consultar o ensaio neste momento.";
    }

    if (typeof mod?.getLatestEnsaio_v1 !== "function") {
      console.log("[ENSAIO_ERR]", "no_handler_found", Object.keys(mod || {}).join(","));
      return "Não consegui consultar o ensaio neste momento.";
    }

    try {
      const out = await mod.getLatestEnsaio_v1({
        spreadsheetId: cfg.spreadsheetId,
        sheetNameEnsaio,
      });

      if (typeof out === "string" && out.trim()) return out.trim();

      const data = String(out?.ENSAIO || out?.data || out?.DATA || "").trim();
      const horarioRaw = String(out?.HORARIO || out?.horario || out?.HORA || out?.["HORÁRIO"] || "").trim();
      const responsavel = String(out?.["RESPONSÁVEL"] || out?.RESPONSAVEL || out?.responsavel || "").trim();

      let horario = horarioRaw;
      const m = horarioRaw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
      if (m) horario = `${m[1].padStart(2, "0")}:${m[2]}`;

      if (data || horario || responsavel) {
        const d = data || "—";
        const h = horario || "—";
        const n = responsavel || "—";
        return `A data do último ensaio no sistema é no dia ${d} às ${h} horas e o responsável é o vocal líder ${n}.`;
      }

      return "Não encontrei informações de ensaio neste momento.";
    } catch (e) {
      console.log("[ENSAIO_ERR]", "getLatestEnsaio_v1", e?.message || e);
      return "Não consegui consultar o ensaio neste momento.";
    }
  }

  // ---------------- AGENDA DEPARTAMENTOS (FULL) ----------------
  if (t === "__APP_AGENDA_FULL__") {
    const sheetNameAgenda = String(cfg?.sheetNameAgenda || process.env.SHEET_NAME_AGENDA || "").trim();
    if (!sheetNameAgenda) return "Não consegui consultar a agenda dos departamentos neste momento.";

    let mod = null;
    try {
      mod = require("../services/appAgenda");
    } catch (e) {
      console.log("[AGENDA_FULL_ERR]", "module_not_found", e?.message || e);
      return "Não consegui consultar a agenda dos departamentos neste momento.";
    }

    if (
      typeof mod?.getAgendaDepartamentos_v1 !== "function" ||
      typeof mod?.formatAgendaDepartamentosText_v1 !== "function"
    ) {
      console.log("[AGENDA_FULL_ERR]", "no_handler_found", Object.keys(mod || {}).join(","));
      return "Não consegui consultar a agenda dos departamentos neste momento.";
    }

    try {
      const payload = await mod.getAgendaDepartamentos_v1({
        spreadsheetId: cfg.spreadsheetId,
        sheetNameAgenda,
        cacheSeconds: cfg.cacheAgendaSeconds,
        timeZone: "Europe/Lisbon",
      });

      return mod.formatAgendaDepartamentosText_v1(payload, "Europe/Lisbon");
    } catch (e) {
      console.log("[AGENDA_FULL_ERR]", "getAgendaDepartamentos_v1", e?.message || e);
      return "Não consegui consultar a agenda dos departamentos neste momento.";
    }
  }

  return "Não consegui processar o teu pedido neste momento.";
}

//###################################################################################
// Agenda NORMAL (dinâmica) + follow-up
//###################################################################################
function normalizeForFind_v1(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function removeAgendaTokenLines_v1(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out = lines.filter((l) => {
    const t = String(l || "").trim();
    if (!t) return true;
    if (t === "_APP_AGENDA_" || t === "__APP_AGENDA__") return false;
    return true;
  });
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function replaceAgendaPlaceholder_v1(baseText, agendaLines) {
  const base = String(baseText || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = base.split("\n");

  const placeholderIdx = lines.findIndex((l) => {
    const n = normalizeForFind_v1(l);
    return n.includes('"""aqui vai as datas que o codigo encontrou"""');
  });

  if (placeholderIdx >= 0) {
    const head = lines.slice(0, placeholderIdx);
    const tail = lines.slice(placeholderIdx + 1);
    return [...head, ...agendaLines, ...tail].join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  const anchorIdx = lines.findIndex((l) => normalizeForFind_v1(l).includes("conheca a nossa agenda semanal"));
  if (anchorIdx >= 0) {
    const head = lines.slice(0, anchorIdx + 1);
    const tail = lines.slice(anchorIdx + 1);
    return [...head, "", ...agendaLines, "", ...tail].join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  return [...lines, "", ...agendaLines].join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function enrichAgendaReply_v1({ cfg, baseText }) {
  const sheetNameAgenda = String(cfg?.sheetNameAgenda || process.env.SHEET_NAME_AGENDA || "").trim();
  if (!sheetNameAgenda) return baseText;

  let mod = null;
  try {
    mod = require("../services/appAgenda");
  } catch (e) {
    console.log("[AGENDA_ERR]", "module_not_found", e?.message || e);
    return baseText;
  }

  if (typeof mod?.getAgendaEventosMes_v1 !== "function" || typeof mod?.formatEventoLine_v1 !== "function") {
    console.log("[AGENDA_ERR]", "no_handler_found", Object.keys(mod || {}).join(","));
    return baseText;
  }

  try {
    const events = await mod.getAgendaEventosMes_v1({
      spreadsheetId: cfg.spreadsheetId,
      sheetNameAgenda,
      cacheSeconds: cfg.cacheAgendaSeconds,
      timeZone: "Europe/Lisbon",
    });

    const agendaLines = (events || [])
      .map((ev) => mod.formatEventoLine_v1(ev, "Europe/Lisbon"))
      .filter(Boolean);

    const safeAgendaLines = agendaLines.length ? agendaLines : ["(Sem eventos registados até ao fim do mês.)"];

    const cleanedBase = removeAgendaTokenLines_v1(baseText);
    return replaceAgendaPlaceholder_v1(cleanedBase, safeAgendaLines);
  } catch (e) {
    console.log("[AGENDA_ERR]", "getAgendaEventosMes_v1", e?.message || e);
    return baseText;
  }
}

function shouldEnrichAgendaByTemplate_v1(replyText) {
  const n = normalizeForFind_v1(replyText);
  return n.includes("aqui vai as datas que o codigo encontrou") || n.includes("_app_agenda_");
}

// ✅ Follow-up só para agenda normal (template) e NUNCA para agenda departamentos token
function shouldSendAgendaFollowup_v1(originalReplyText) {
  const orig = String(originalReplyText || "").trim();
  if (!orig) return false;

  // Se veio do token do comando "Agenda Departamentos", não enviar follow-up.
  if (orig === "__APP_AGENDA_FULL__") return false;

  // Enviar follow-up apenas quando era template/placeholder da agenda normal
  return shouldEnrichAgendaByTemplate_v1(orig);
}

//###################################################################################
// Handler principal
//###################################################################################
function registerOnMessage_v5(client, cfg) {
  validateCfgOrThrow(cfg);

  client.on("message_create", async (message) => {
    if (message.fromMe) return;
    if (isIgnoredChat(message.from, cfg)) return;

    const bodyRaw = (message.body || "").trim();
    if (!bodyRaw) return;

    const chatId = message.from;

    if (closedChats.has(chatId)) {
      closedChats.delete(chatId);
      clearCloseTimer(chatId);
      resetChatState(chatId);
      console.log("[REOPEN_RESET]", chatId);
    }

    try {
      const allRules = await getRules(cfg.spreadsheetId, cfg.sheetNameResp, cfg.cacheSeconds);

      const fallback = String(getSpecial(allRules, "FALLBACK") || "").trim() || FALLBACK_DEFAULT;
      const closeText = String(getSpecial(allRules, "CLOSE_TEXT") || "").trim();

      resetCloseTimer(client, chatId, closeText);

      const msgN = normalizeText(bodyRaw);

      let fullName = "";
      let isColab = false;
      let depts = [];

      try {
        const acc = await getAccessByChatId({
          spreadsheetId: cfg.spreadsheetId,
          sheetNameBp: cfg.sheetNameBp,
          chatId,
          cacheSeconds: cfg.cacheBpSeconds,
          debugRowLog: DEBUG_BP_ROW,
        });

        fullName = String(acc?.fullName || "").trim();
        isColab = Boolean(acc?.isColab);
        depts = Array.isArray(acc?.depts) ? acc.depts : [];
      } catch (e) {
        console.log("[BP_LOOKUP_ERR]", e?.message || e);
      }

      if (shouldSendMenuNow_v1(msgN) || shouldSendMenuNow_v1(bodyRaw)) {
        const menuText = getMenuText_v1(allRules, isColab);
        await safeSend(client, chatId, menuText);

        console.log("[MENU_DIRECT]", chatId);
        console.log(
          "[ACCESS]",
          `chat=${chatId}`,
          `isColab=${isColab}`,
          depts.length ? `depts=${depts.join(",")}` : "depts="
        );
        console.log("[TRACE_RX]", `chat=${chatId}`, `raw=${JSON.stringify(bodyRaw)}`, `norm=${JSON.stringify(msgN)}`);
        return;
      }

      const rules = filterRulesByAccess(allRules, isColab);

      if (!greeted.has(chatId)) {
        greeted.add(chatId);

        const dia = getDayGreetingPt_v1();
        const firstName = getFirstName_v1(fullName);

        const line1 = firstName ? `Olá! Graça e paz ${firstName}, ${dia}!` : `Olá! Graça e paz, ${dia}!`;
        const greetBase = getGreetFromSheet_v1(allRules, isColab);
        const line2 = isColab ? `${greetBase}\n\n${getMenuText_v1(allRules, true)}` : greetBase;

        await safeSend(client, chatId, line1);
        await safeSend(client, chatId, line2);

        console.log("[GREET]", chatId, fullName ? `(${fullName})` : "");
        console.log(
          "[ACCESS]",
          `chat=${chatId}`,
          `isColab=${isColab}`,
          depts.length ? `depts=${depts.join(",")}` : "depts="
        );
        console.log("[TRACE_RX]", `chat=${chatId}`, `raw=${JSON.stringify(bodyRaw)}`, `norm=${JSON.stringify(msgN)}`);
        return;
      }

      console.log(
        "[ACCESS]",
        `chat=${chatId}`,
        `isColab=${isColab}`,
        depts.length ? `depts=${depts.join(",")}` : "depts="
      );
      console.log("[TRACE_RX]", `chat=${chatId}`, `raw=${JSON.stringify(bodyRaw)}`, `norm=${JSON.stringify(msgN)}`);

      let reply = tryDecideReply(bodyRaw, msgN, rules);
      if (reply) logMatchedRule_v1({ chatId, rulesBase: allRules, reply });

      const originalReply = String(reply || "").trim();

      // 1) Tokens de apps primeiro (inclui __APP_AGENDA_FULL__)
      if (isActionToken_v1(reply)) {
        reply = await resolveActionToken_v1({ cfg, token: reply, fullName });
      }

      // 2) Agenda normal dinâmica (template)
      if (reply && shouldEnrichAgendaByTemplate_v1(originalReply)) {
        reply = await enrichAgendaReply_v1({ cfg, baseText: reply });
      }

      if (reply) {
        await safeSend(client, chatId, reply);
        console.log("[TRACE_TX]", `chat=${chatId}`, `send=${JSON.stringify(reply)}`);

        // ✅ Follow-up apenas para agenda normal (template), nunca para __APP_AGENDA_FULL__
        if (shouldSendAgendaFollowup_v1(originalReply)) {
          await safeSend(client, chatId, AGENDA_FOLLOWUP_TEXT);
          console.log("[TRACE_TX]", `chat=${chatId}`, `send=${JSON.stringify(AGENDA_FOLLOWUP_TEXT)}`);
        }

        if (closeText && String(reply).trim() === closeText) {
          closedChats.add(chatId);
          resetChatState(chatId);
          clearCloseTimer(chatId);
          console.log("[CLOSE_BY_RULE]", chatId);
        }
        return;
      }

      // Fallback
      try {
        await logFallback({
          spreadsheetId: cfg.spreadsheetId,
          chatId,
          rawMsg: bodyRaw,
          normMsg: msgN,
        });
      } catch (e) {
        console.log("[LOG_FALLBACK_ERR]", e?.message || e);
      }

      await safeSend(client, chatId, fallback);
      console.log("[TRACE_TX]", `chat=${chatId}`, `send=${JSON.stringify(fallback)}`);
      console.log("[FALLBACK]", chatId);
    } catch (e) {
      console.log("[ERR]", e?.message || e);
      try {
        await safeSend(client, chatId, FALLBACK_DEFAULT);
        console.log("[TRACE_TX]", `chat=${chatId}`, `send=${JSON.stringify(FALLBACK_DEFAULT)}`);
      } catch (_) {}
    }
  });
}

function registerOnMessage_v4(client, cfg) {
  return registerOnMessage_v5(client, cfg);
}

module.exports = {
  registerOnMessage_v4,
  registerOnMessage_v5,
};