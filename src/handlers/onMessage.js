//###################################################################################
// src/handlers/onMessage.js
//###################################################################################
"use strict";

const { getRules, buildHumanizedResponse } = require("../services/responsesStore");
const { decideReply, getSpecial, normalizeText } = require("../services/router");
const { logFallback } = require("../services/fallbackLog");
const { getAccessByChatId } = require("../services/bpLookup");
const { analisarComIA } = require("../services/aiAssistant"); // <--- A NOSSA IA

//###################################################################################
// Config
//###################################################################################
const CLOSE_AFTER_MS = 30 * 60 * 1000; 
const FALLBACK_DEFAULT = "Ups, não consegui entender. Podes tentar perguntar de outra forma?";
const DEBUG_BP_ROW = String(process.env.DEBUG_BP_ROW || "false").toLowerCase() === "true";

const AGENDA_FOLLOWUP_TEXT =
  "Gostavas de conhecer a programação de algum departamento em específico?\n\n" +
  "Se sim, escreve '*Agenda Departamentos*'. Se preferires, podes também fazer outra pergunta.";

//###################################################################################
// Menu triggers
//###################################################################################
const MENU_TRIGGER_TEXTS = ["menu", "menu de informacoes", "menu de informações", "informacoes", "informações", "informação"];

function shouldSendMenuNow_v1(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;
  if (MENU_TRIGGER_TEXTS.includes(t)) return true;
  return MENU_TRIGGER_TEXTS.some((x) => t.includes(x));
}

function getDayGreetingPt_v1() {
  const h = new Date().getHours();
  if (h >= 5 && h <= 11) return "bom dia";
  if (h >= 12 && h <= 17) return "boa tarde";
  return "boa noite";
}

function getFirstName_v1(fullName) {
  const s = String(fullName || "").trim();
  if (!s) return "";
  return s.split(/\s+/g)[0] || s;
}

function isIgnoredChat(from, cfg) {
  if (!from || from === "status@broadcast" || from.endsWith("@g.us")) return true;
  if (from.endsWith("@lid") && cfg?.ignoreLid) return true;
  return false;
}

function validateCfgOrThrow(cfg) {
  cfg.cacheSeconds = Number(cfg.cacheSeconds || 60);
  cfg.cacheBpSeconds = Number(cfg.cacheBpSeconds || 300);
  cfg.ignoreLid = Boolean(cfg.ignoreLid);
  cfg.cacheAgendaSeconds = Number(cfg.cacheAgendaSeconds || 300);
}

//###################################################################################
// Estado em memória
//###################################################################################
const greeted = new Set();
const closeTimers = new Map();
const closedChats = new Set();
const userContexts = new Map(); 

function resetChatState(chatId) {
  greeted.delete(chatId);
  userContexts.delete(chatId); 
}

//###################################################################################
// Envio seguro e Simulação
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
    } catch (e) {}
  }, CLOSE_AFTER_MS);
  closeTimers.set(chatId, t);
}

function tryDecideReply(bodyRaw, msgN, rules) {
  const r1 = decideReply(msgN, rules);
  if (r1) return r1;
  const r2 = decideReply(bodyRaw, rules);
  if (r2) return r2;
  return "";
}

function getReplyFromRule_v1(rule) {
  if (!rule || typeof rule !== "object") return "";
  const v = rule.reply ?? rule.REPLY ?? rule.resposta ?? rule.RESPOSTA ?? rule.text ?? rule.TEXTO ?? "";
  return String(v || "").trim();
}

//###################################################################################
// Tokens de Ação
//###################################################################################
function isActionToken_v1(reply) {
  return /^__.+__$/.test(String(reply || "").trim());
}

async function resolveActionToken_v1({ cfg, token, fullName, msgN, rawMsg }) {
  const t = String(token || "").trim();

  if (t === "__APP_AGENDA_FULL__") {
    let mod = require("../services/appAgenda");
    const payload = await mod.getAgendaDepartamentos_v1({ spreadsheetId: cfg.spreadsheetId, sheetNameAgenda: cfg.sheetNameAgenda, cacheSeconds: cfg.cacheAgendaSeconds, timeZone: "Europe/Lisbon" });
    return mod.formatAgendaDepartamentosText_v1(payload, "Europe/Lisbon");
  }

  if (t === "__APP_LIVRARIA__" || t === "__APP_LIVRARIA_SEARCH__") {
    let mod = require("../services/appLivraria");
    return await mod.getLivrosEmStock_v1({
      spreadsheetId: "10UDDJdlTuPs65gdPnN7fcDQm6cfNCWp8gqlTqE3lUp4",
      sheetName: "DB_STOCK",
      searchTerm: t === "__APP_LIVRARIA_SEARCH__" ? String(rawMsg || "").trim() : ""
    });
  }

  if (t === "__APP_LIVRARIA_AUTORES__" || t === "__APP_LIVRARIA_EDITORAS__") {
    let mod = require("../services/appLivraria");
    return await mod.getListasLivraria_v1({
      spreadsheetId: "10UDDJdlTuPs65gdPnN7fcDQm6cfNCWp8gqlTqE3lUp4",
      sheetName: "DB_STOCK",
      tipo: t === "__APP_LIVRARIA_AUTORES__" ? "AUTORES" : "EDITORAS"
    });
  }

  return "Não consegui processar o teu pedido neste momento.";
}

async function enrichAgendaReply_v1({ cfg, baseText }) {
  try {
    let mod = require("../services/appAgenda");
    const events = await mod.getAgendaEventosMes_v1({ spreadsheetId: cfg.spreadsheetId, sheetNameAgenda: cfg.sheetNameAgenda, cacheSeconds: cfg.cacheAgendaSeconds, timeZone: "Europe/Lisbon" });
    const agendaLines = (events || []).map((ev) => mod.formatEventoLine_v1(ev, "Europe/Lisbon")).filter(Boolean);
    const safeAgendaLines = agendaLines.length ? agendaLines : ["(Sem eventos registados até ao fim do mês.)"];
    return baseText.replace("_APP_AGENDA_", safeAgendaLines.join("\n"));
  } catch (e) { return baseText; }
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
    }

    try {
      const allRules = await getRules(cfg.spreadsheetId, cfg.sheetNameResp, cfg.cacheSeconds);
      const closeText = String(getSpecial(allRules, "CLOSE_TEXT") || "").trim();
      resetCloseTimer(client, chatId, closeText);

      const msgN = normalizeText(bodyRaw);
      let fullName = "";
      let isColab = false;

      try {
        const acc = await getAccessByChatId({ spreadsheetId: cfg.spreadsheetId, sheetNameBp: cfg.sheetNameBp, chatId, cacheSeconds: cfg.cacheBpSeconds, debugRowLog: DEBUG_BP_ROW });
        fullName = String(acc?.fullName || "").trim();
        isColab = Boolean(acc?.isColab);
      } catch (e) {}

      console.log("[TRACE_RX]", `chat=${chatId}`, `raw=${JSON.stringify(bodyRaw)}`);
      console.log("[ACCESS]", `chat=${chatId}`, `isColab=${isColab}`);

      // 1. Menu Direto
      if (shouldSendMenuNow_v1(msgN) || shouldSendMenuNow_v1(bodyRaw)) {
        const menuText = getSpecial(allRules, "MENU") || "Menu não configurado.";
        await simulateTyping(client, chatId, 1000); 
        await safeSend(client, chatId, menuText);
        console.log("[TRACE_TX]", `chat=${chatId}`, `send=Menu`);
        return;
      }

      // 2. Saudação Inicial
      if (!greeted.has(chatId)) {
        greeted.add(chatId);
        const rawGreet = getSpecial(allRules, isColab ? "GREET_COLAB" : "GREET_PUBLIC") || "Olá!";
        const humanizedGreeting = buildHumanizedResponse(rawGreet, getFirstName_v1(fullName), getDayGreetingPt_v1());
        await simulateTyping(client, chatId, 2500);
        await safeSend(client, chatId, humanizedGreeting);
        console.log("[GREET]", chatId, fullName ? `(${fullName})` : "");
        console.log("[TRACE_TX]", `chat=${chatId}`, `send=${JSON.stringify(humanizedGreeting)}`);
        return;
      }

      const rules = (allRules || []).filter(r => {
        const a = String(r.access || r.ACCESS || "PUBLIC").trim().toUpperCase();
        return a === "COLAB" ? isColab : true;
      });

      // 3. Verifica Correspondência na Folha de Cálculo
      let reply = tryDecideReply(bodyRaw, msgN, rules);

      // --- BLOQUEIO FORÇADO DAS REGRAS ANTIGAS ---
      // Se a folha de cálculo tentar responder com o texto antigo, nós bloqueamos e atiramos para a IA!
      if (reply && (reply.includes("Verbo Shop") || reply.includes("__APP_LIVRARIA"))) {
         reply = ""; 
         console.log("[FORCED BYPASS] Regra antiga da livraria ignorada. Passando para a IA.");
      }

      // SE ENCONTROU REGRA VÁLIDA NA FOLHA, RESPONDE E ACABA AQUI
      if (reply) {
         if (isActionToken_v1(reply)) {
            reply = await resolveActionToken_v1({ cfg, token: reply, fullName, msgN, rawMsg: bodyRaw });
         } else if (reply.includes("_APP_AGENDA_")) {
            reply = await enrichAgendaReply_v1({ cfg, baseText: reply });
         }
         reply = buildHumanizedResponse(reply, getFirstName_v1(fullName), getDayGreetingPt_v1());
         
         await simulateTyping(client, chatId, 2500);
         await safeSend(client, chatId, reply);
         console.log("[MATCH FOLHA]", `chat=${chatId}`);
         console.log("[TRACE_TX]", `chat=${chatId}`, `send=${JSON.stringify(reply)}`);
         return;
      }

      // =======================================================================
      // 4. A MAGIA DA IA (Entra aqui de certeza agora)
      // =======================================================================
      console.log("[IA] A chamar o ChatGPT para analisar a intenção...");
      await simulateTyping(client, chatId, 2500);
      
      const firstName = getFirstName_v1(fullName);
      const aiResult = await analisarComIA(bodyRaw, firstName);

      if (aiResult.acao === "LIVRARIA") {
          console.log(`[IA DECIDIU] Pesquisar livros pelo termo exato: "${aiResult.termo}"`);
          reply = await resolveActionToken_v1({ cfg, token: "__APP_LIVRARIA_SEARCH__", fullName, msgN, rawMsg: aiResult.termo });

      } else if (aiResult.acao === "AGENDA_MENSAL") {
          console.log(`[IA DECIDIU] Ver agenda mensal.`);
          reply = await enrichAgendaReply_v1({ cfg, baseText: "Conheça a nossa programação mensal:\n\n_APP_AGENDA_" });

      } else if (aiResult.acao === "AGENDA_DEPT") {
          console.log(`[IA DECIDIU] Ver agenda de departamentos.`);
          reply = await resolveActionToken_v1({ cfg, token: "__APP_AGENDA_FULL__", fullName, msgN, rawMsg: "" });

      } else if (aiResult.acao === "TEXTO") {
          console.log(`[IA DECIDIU] Conversar naturalmente.`);
          reply = aiResult.resposta;
      }

      if (reply) {
          await simulateTyping(client, chatId, 2500);
          await safeSend(client, chatId, reply);
          console.log("[TRACE_TX_IA]", `chat=${chatId}`, `send=${JSON.stringify(reply)}`);
      } else {
          try { await logFallback({ spreadsheetId: cfg.spreadsheetId, chatId, rawMsg: bodyRaw, normMsg: msgN }); } catch (e) {}
          await safeSend(client, chatId, FALLBACK_DEFAULT);
      }

    } catch (e) {
      console.log("[CRITICAL_ERR]", e);
    }
  });
}

function registerOnMessage_v4(client, cfg) { return registerOnMessage_v5(client, cfg); }
module.exports = { registerOnMessage_v4, registerOnMessage_v5 };