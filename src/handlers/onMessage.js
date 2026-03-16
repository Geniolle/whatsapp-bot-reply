//###################################################################################
// src/handlers/onMessage.js
//###################################################################################
"use strict";

const { getRules, buildHumanizedResponse } = require("../services/responsesStore");
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

function isIgnoredChat(from, cfg) {
  if (!from) return true;
  if (from === "status@broadcast") return true;
  if (from.endsWith("@g.us")) return true;
  if (from.endsWith("@lid") && cfg?.ignoreLid) return true;
  return false;
}

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
const userContexts = new Map(); 
const fallbackCount = new Map(); // <--- NOVO: Contador de falhas (2 perguntas sem resposta = Menu)

function resetChatState(chatId) {
  greeted.delete(chatId);
  userContexts.delete(chatId); 
  fallbackCount.delete(chatId);
}

//###################################################################################
// Envio seguro e Simulação de Digitação
//###################################################################################
async function safeSend(client, chatId, text) {
  const msg = String(text || "").trim();
  if (!msg) return false;
  await client.sendMessage(chatId, msg);
  return true;
}

async function simulateTyping(client, chatId, delayMs = 1500) {
  try {
    if (typeof client.getChatById === 'function') {
      const chat = await client.getChatById(chatId);
      if (chat && typeof chat.sendStateTyping === 'function') await chat.sendStateTyping();
    } else if (typeof client.startTyping === 'function') {
      await client.startTyping(chatId);
    } else if (typeof client.sendPresenceUpdate === 'function') {
      await client.sendPresenceUpdate('composing', chatId);
    }
  } catch (e) {}
  await new Promise(resolve => setTimeout(resolve, delayMs));
  try {
    if (typeof client.getChatById === 'function') {
      const chat = await client.getChatById(chatId);
      if (chat && typeof chat.clearState === 'function') await chat.clearState();
    } else if (typeof client.stopTyping === 'function') {
      await client.stopTyping(chatId);
    } else if (typeof client.sendPresenceUpdate === 'function') {
      await client.sendPresenceUpdate('available', chatId);
    }
  } catch (e) {}
}

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
      if (closeMsg) {
        await simulateTyping(client, chatId, 1000); 
        await safeSend(client, chatId, closeMsg);
      }
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

function filterRulesByAccess(rules, isColab) {
  const colab = Boolean(isColab);
  return (rules || []).filter((r) => {
    const a = String(r.access || r.ACCESS || "PUBLIC").trim().toUpperCase();
    if (a === "COLAB") return colab;
    return true;
  });
}

function tryDecideReply(bodyRaw, msgN, rules) {
  const r1 = decideReply(msgN, rules);
  if (r1) return r1;
  const r2 = decideReply(bodyRaw, rules);
  if (r2) return r2;
  return "";
}

function normForCompare_v1(s) {
  return String(s || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
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
  const idTable = rule ? (rule.ID_TABLE || rule.idTable || "") : "";

  console.log("[MATCH]", `chat=${chatId}`, idTable ? `idTable=${idTable}` : "idTable=", `reply=${JSON.stringify(repRaw)}`);
}

function getGreetFromSheet_v1(allRules, isColab) {
  const key = isColab ? "GREET_COLAB" : "GREET_PUBLIC";
  const fromSheet = String(getSpecial(allRules, key) || "").trim();
  if (fromSheet) return fromSheet;
  return "Configuração em falta: saudação inicial não encontrada na sheet RESPONSES.";
}

function getMenuText_v1(allRules, isColab) {
  const menuFromSheet = String(getSpecial(allRules, "MENU") || "").trim();
  if (menuFromSheet) return menuFromSheet;
  return "Configuração em falta: menu não encontrado na sheet RESPONSES.";
}

//###################################################################################
// Tokens de Ação
//###################################################################################
function isActionToken_v1(reply) {
  const t = String(reply || "").trim();
  return /^__.+__$/.test(t);
}

async function resolveActionToken_v1({ cfg, token, fullName, msgN, rawMsg }) {
  const t = String(token || "").trim();

  if (t === "__AUSENCIAS__") {
    const sheetNameAusencias = String(cfg?.sheetNameAusencias || process.env.SHEET_NAME_AUSENCIAS || "").trim();
    if (!sheetNameAusencias) return "Não consegui consultar as tuas férias/ausências neste momento.";
    let mod = null;
    try { mod = require("../services/appAusencias"); } catch (e) { return "Não consegui consultar as tuas férias/ausências neste momento."; }
    if (typeof mod?.getAusenciasByFullName_v1 !== "function") return "Não consegui consultar as tuas férias/ausências neste momento.";
    try {
      const data = await mod.getAusenciasByFullName_v1({ spreadsheetId: cfg.spreadsheetId, sheetNameAusencias, fullName });
      const upcoming = Array.isArray(data?.upcoming) ? data.upcoming : [];
      const last = data?.last || null;
      if (!upcoming.length && !last) return "Não encontrei férias/ausências registadas para ti.";
      const lines = [];
      if (upcoming.length) {
        lines.push("Próximas férias/ausências:");
        for (const x of upcoming) {
          const ini = x?.ini || ""; const fim = x?.fim || ""; const motivo = x?.motivo ? ` — ${x.motivo}` : "";
          lines.push(`- ${fim ? `${ini} a ${fim}` : ini}${motivo}`);
        }
      } else { lines.push("Não encontrei férias/ausências futuras."); }
      if (last) {
        const ini = last?.ini || ""; const fim = last?.fim || ""; const motivo = last?.motivo ? ` — ${last.motivo}` : "";
        lines.push(`\nÚltima ausência registada: ${fim ? `${ini} a ${fim}` : ini}${motivo}`);
      }
      return lines.join("\n");
    } catch (e) { return "Não consegui consultar as tuas férias/ausências neste momento."; }
  }

  if (t === "__APP_ENSAIO__") {
    const sheetNameEnsaio = String(cfg?.sheetNameEnsaio || process.env.SHEET_NAME_ENSAIO || "").trim();
    if (!sheetNameEnsaio) return "Não consegui consultar o ensaio neste momento.";
    let mod = null;
    try { mod = require("../services/appEnsaio"); } catch (e) { return "Não consegui consultar o ensaio neste momento."; }
    if (typeof mod?.getLatestEnsaio_v1 !== "function") return "Não consegui consultar o ensaio neste momento.";
    try {
      const out = await mod.getLatestEnsaio_v1({ spreadsheetId: cfg.spreadsheetId, sheetNameEnsaio });
      if (typeof out === "string" && out.trim()) return out.trim();
      const data = String(out?.ENSAIO || out?.data || out?.DATA || "").trim();
      const horarioRaw = String(out?.HORARIO || out?.horario || out?.HORA || out?.["HORÁRIO"] || "").trim();
      const responsavel = String(out?.["RESPONSÁVEL"] || out?.RESPONSAVEL || out?.responsavel || "").trim();
      let horario = horarioRaw;
      const m = horarioRaw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
      if (m) horario = `${m[1].padStart(2, "0")}:${m[2]}`;
      if (data || horario || responsavel) return `A data do último ensaio no sistema é no dia ${data || "—"} às ${horario || "—"} horas e o responsável é o vocal líder ${responsavel || "—"}.`;
      return "Não encontrei informações de ensaio neste momento.";
    } catch (e) { return "Não consegui consultar o ensaio neste momento."; }
  }

  if (t === "__APP_AGENDA_FULL__") {
    const sheetNameAgenda = String(cfg?.sheetNameAgenda || process.env.SHEET_NAME_AGENDA || "").trim();
    if (!sheetNameAgenda) return "Não consegui consultar a agenda dos departamentos neste momento.";
    let mod = null;
    try { mod = require("../services/appAgenda"); } catch (e) { return "Não consegui consultar a agenda dos departamentos neste momento."; }
    if (typeof mod?.getAgendaDepartamentos_v1 !== "function") return "Não consegui consultar a agenda dos departamentos neste momento.";
    try {
      const payload = await mod.getAgendaDepartamentos_v1({ spreadsheetId: cfg.spreadsheetId, sheetNameAgenda, cacheSeconds: cfg.cacheAgendaSeconds, timeZone: "Europe/Lisbon" });
      return mod.formatAgendaDepartamentosText_v1(payload, "Europe/Lisbon");
    } catch (e) { return "Não consegui consultar a agenda dos departamentos neste momento."; }
  }

  if (t === "__APP_LIVRARIA__" || t === "__APP_LIVRARIA_SEARCH__") {
    let mod = null;
    try { mod = require("../services/appLivraria"); } catch (e) { return "Falha ao aceder ao módulo de livros."; }
    
    try {
      const spreadsheetIdLivraria = "10UDDJdlTuPs65gdPnN7fcDQm6cfNCWp8gqlTqE3lUp4";
      const sheetNameDBStock = "DB_STOCK";
      const termoPesquisa = t === "__APP_LIVRARIA_SEARCH__" ? String(rawMsg || "").trim() : "";

      return await mod.getLivrosEmStock_v1({
        spreadsheetId: spreadsheetIdLivraria,
        sheetName: sheetNameDBStock,
        searchTerm: termoPesquisa
      });
    } catch (e) { return "Não consegui consultar o stock. Verifica se a Service Account tem permissão de Leitor na folha de cálculo."; }
  }

  if (t === "__APP_LIVRARIA_AUTORES__" || t === "__APP_LIVRARIA_EDITORAS__") {
    let mod = null;
    try { mod = require("../services/appLivraria"); } catch (e) { return "Falha ao aceder ao módulo."; }
    
    try {
      const spreadsheetIdLivraria = "10UDDJdlTuPs65gdPnN7fcDQm6cfNCWp8gqlTqE3lUp4";
      const sheetNameDBStock = "DB_STOCK";
      const tipo = t === "__APP_LIVRARIA_AUTORES__" ? "AUTORES" : "EDITORAS";

      return await mod.getListasLivraria_v1({
        spreadsheetId: spreadsheetIdLivraria,
        sheetName: sheetNameDBStock,
        tipo
      });
    } catch (e) { return "Não consegui consultar o stock. Verifica se a Service Account tem permissão de Leitor na folha de cálculo."; }
  }

  return "Não consegui processar o teu pedido neste momento.";
}

function normalizeForFind_v1(s) {
  return String(s || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function removeAgendaTokenLines_v1(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out = lines.filter((l) => {
    const t = String(l || "").trim();
    if (!t) return true;
    return (t !== "_APP_AGENDA_" && t !== "__APP_AGENDA__");
  });
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function replaceAgendaPlaceholder_v1(baseText, agendaLines) {
  const base = String(baseText || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = base.split("\n");
  const placeholderIdx = lines.findIndex((l) => normalizeForFind_v1(l).includes('"""aqui vai as datas que o codigo encontrou"""'));
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
  try { mod = require("../services/appAgenda"); } catch (e) { return baseText; }
  if (typeof mod?.getAgendaEventosMes_v1 !== "function") return baseText;
  try {
    const events = await mod.getAgendaEventosMes_v1({ spreadsheetId: cfg.spreadsheetId, sheetNameAgenda, cacheSeconds: cfg.cacheAgendaSeconds, timeZone: "Europe/Lisbon" });
    const agendaLines = (events || []).map((ev) => mod.formatEventoLine_v1(ev, "Europe/Lisbon")).filter(Boolean);
    const safeAgendaLines = agendaLines.length ? agendaLines : ["(Sem eventos registados até ao fim do mês.)"];
    const cleanedBase = removeAgendaTokenLines_v1(baseText);
    return replaceAgendaPlaceholder_v1(cleanedBase, safeAgendaLines);
  } catch (e) { return baseText; }
}

function shouldEnrichAgendaByTemplate_v1(replyText) {
  const n = normalizeForFind_v1(replyText);
  if (n.includes("__app_agenda_full__")) return false;
  return n.includes("aqui vai as datas que o codigo encontrou") || n.includes("_app_agenda_");
}

function shouldSendAgendaFollowup_v1(originalReplyText) {
  const orig = String(originalReplyText || "").trim();
  if (!orig || orig === "__APP_AGENDA_FULL__" || orig.startsWith("__APP_LIVRARIA")) return false;
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
        const acc = await getAccessByChatId({ spreadsheetId: cfg.spreadsheetId, sheetNameBp: cfg.sheetNameBp, chatId, cacheSeconds: cfg.cacheBpSeconds, debugRowLog: DEBUG_BP_ROW });
        fullName = String(acc?.fullName || "").trim();
        isColab = Boolean(acc?.isColab);
        depts = Array.isArray(acc?.depts) ? acc.depts : [];
      } catch (e) {}

      console.log("[TRACE_RX]", `chat=${chatId}`, `raw=${JSON.stringify(bodyRaw)}`, `norm=${JSON.stringify(msgN)}`);
      console.log("[ACCESS]", `chat=${chatId}`, `isColab=${isColab}`, depts.length ? `depts=${depts.join(",")}` : "depts=");

      if (shouldSendMenuNow_v1(msgN) || shouldSendMenuNow_v1(bodyRaw)) {
        const menuText = getMenuText_v1(allRules, isColab);
        await simulateTyping(client, chatId, 1000); 
        await safeSend(client, chatId, menuText);
        userContexts.delete(chatId); 
        fallbackCount.delete(chatId); // Sucesso! Limpa o contador de falhas
        console.log("[MENU_DIRECT]", chatId);
        console.log("[TRACE_TX]", `chat=${chatId}`, `send=${JSON.stringify(menuText)}`);
        return;
      }

      const rules = filterRulesByAccess(allRules, isColab);

      if (!greeted.has(chatId)) {
        greeted.add(chatId);
        const dia = getDayGreetingPt_v1();
        const firstName = getFirstName_v1(fullName);
        const rawGreetTemplate = getGreetFromSheet_v1(allRules, isColab);
        const humanizedGreeting = buildHumanizedResponse(rawGreetTemplate, firstName, dia);
        
        await simulateTyping(client, chatId, 2500);
        await safeSend(client, chatId, humanizedGreeting);
        console.log("[GREET]", chatId, fullName ? `(${fullName})` : "");
        console.log("[TRACE_TX]", `chat=${chatId}`, `send=${JSON.stringify(humanizedGreeting)}`);
        return;
      }

      let reply = "";
      let matchedRule = null;
      const currentContext = userContexts.get(chatId);

      if (currentContext) {
        const contextRules = rules.filter(r => String(r.PROCESSO || "").trim().toUpperCase() === currentContext.toUpperCase());
        reply = tryDecideReply(bodyRaw, msgN, contextRules);
        
        if (reply) {
          matchedRule = findMatchedRuleByReply_v1(contextRules, reply);
          console.log(`[CONTEXT MATCH] Respondeu dentro do fluxo: ${currentContext}`);
        } 
        else if (currentContext.toUpperCase() === "FLUXO_LIVRARIA_BUSCA") {
          reply = "__APP_LIVRARIA_SEARCH__";
          matchedRule = { PROCESSO: "FLUXO_LIVRARIA_BUSCA" }; 
          console.log(`[CONTEXT SEARCH] Bot deduziu que '${bodyRaw}' é o texto da pesquisa!`);
        }
      }

      if (!reply) {
        reply = tryDecideReply(bodyRaw, msgN, rules);
        if (reply) matchedRule = findMatchedRuleByReply_v1(rules, reply);
      }

      if (matchedRule) {
        logMatchedRule_v1({ chatId, rulesBase: allRules, reply });
        const novoProcesso = String(matchedRule.PROCESSO || "").trim();
        if (novoProcesso) {
          userContexts.set(chatId, novoProcesso); 
        } else {
          userContexts.delete(chatId); 
        }
      }

      const originalReply = String(reply || "").trim();

      if (isActionToken_v1(reply)) {
        reply = await resolveActionToken_v1({ cfg, token: reply, fullName, msgN, rawMsg: bodyRaw });
      }

      if (reply && shouldEnrichAgendaByTemplate_v1(originalReply)) {
        reply = await enrichAgendaReply_v1({ cfg, baseText: reply });
      }

      if (reply && !isActionToken_v1(originalReply)) {
        const dia = getDayGreetingPt_v1();
        const firstName = getFirstName_v1(fullName);
        reply = buildHumanizedResponse(reply, firstName, dia);
      }

      // SUCESSO! SE ENCONTROU RESPOSTA, ENVIA E ZERA O CONTADOR DE FALHAS
      if (reply) {
        fallbackCount.delete(chatId); // Sucesso! Reseta o contador
        
        await simulateTyping(client, chatId, 3000); 
        await safeSend(client, chatId, reply);
        console.log("[TRACE_TX]", `chat=${chatId}`, `send=${JSON.stringify(reply)}`);

        if (shouldSendAgendaFollowup_v1(originalReply)) {
          await simulateTyping(client, chatId, 2500); 
          await safeSend(client, chatId, AGENDA_FOLLOWUP_TEXT);
          console.log("[TRACE_TX]", `chat=${chatId}`, `send=${JSON.stringify(AGENDA_FOLLOWUP_TEXT)}`);
        }

        if (closeText && String(reply).trim() === closeText) {
          closedChats.add(chatId);
          resetChatState(chatId);
          clearCloseTimer(chatId);
        }
        return;
      }

      // FALHA: Se chegou aqui, o bot não percebeu a mensagem (Fallback)
      try { await logFallback({ spreadsheetId: cfg.spreadsheetId, chatId, rawMsg: bodyRaw, normMsg: msgN }); } catch (e) {}

      // Lógica do Contador de Falhas
      const fails = (fallbackCount.get(chatId) || 0) + 1;
      fallbackCount.set(chatId, fails);

      // Se falhou 2 vezes seguidas, envia o Menu para ajudar
      if (fails >= 2) {
        const menuText = getMenuText_v1(allRules, isColab);
        const menuFallback = "Parece que não estou a conseguir entender-te. 😔\nPara facilitar, aqui estão as principais informações que podes consultar no nosso menu:\n\n" + menuText;
        
        await simulateTyping(client, chatId, 2500);
        await safeSend(client, chatId, menuFallback);
        console.log("[TRACE_TX]", `chat=${chatId}`, `send=Menu Auxiliar Ativado por Falhas`);
        
        fallbackCount.delete(chatId); // Zera para não mandar o menu a toda a hora se a pessoa continuar a falhar
      } else {
        // Falhou apenas a 1ª vez, manda a mensagem padrão de erro
        await simulateTyping(client, chatId, 2000);
        await safeSend(client, chatId, fallback);
        console.log("[TRACE_TX]", `chat=${chatId}`, `send=${JSON.stringify(fallback)}`);
      }
      
      userContexts.delete(chatId); // Limpa o fluxo para evitar bloqueios
      
    } catch (e) {
      try {
        await simulateTyping(client, chatId, 1000);
        await safeSend(client, chatId, FALLBACK_DEFAULT);
      } catch (_) {}
    }
  });
}

function registerOnMessage_v4(client, cfg) { return registerOnMessage_v5(client, cfg); }
module.exports = { registerOnMessage_v4, registerOnMessage_v5 };