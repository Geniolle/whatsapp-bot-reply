//###################################################################################
// src/handlers/onMessage.js - VERSÃO CONSOLIDADA (Livraria, Agenda, Ensaio, Ausências)
//###################################################################################
"use strict";

const { getRules, buildHumanizedResponse } = require("../services/responsesStore");
const { getAccessByChatId } = require("../services/bpLookup");
const { analisarComIA } = require("../services/aiAssistant");

const FALLBACK_DEFAULT = "Ups, a minha ligação falhou por um instante. Podes repetir a pergunta?";

const MENU_TRIGGER_TEXTS = ["menu", "menu de informacoes", "informacoes"];
function shouldSendMenuNow(text) {
  const t = String(text || "").toLowerCase().trim();
  return MENU_TRIGGER_TEXTS.some(x => t.includes(x));
}

function getDayGreetingPt() {
  const h = new Date().getHours();
  if (h >= 5 && h <= 11) return "bom dia";
  if (h >= 12 && h <= 17) return "boa tarde";
  return "boa noite";
}

function getFirstName(fullName) {
  return String(fullName || "").trim().split(/\s+/g)[0] || "";
}

const greeted = new Set();

async function simulateTyping(client, chatId, delayMs = 1500) {
  try {
    const chat = await client.getChatById(chatId);
    if (chat && chat.sendStateTyping) await chat.sendStateTyping();
  } catch (e) {}
  await new Promise(resolve => setTimeout(resolve, delayMs));
}

async function fetchAgendaDepartamentos_v1({ cfg }) {
  try {
    let mod = require("../services/appAgenda");
    const payload = await mod.getAgendaDepartamentos_v1({ spreadsheetId: cfg.spreadsheetId, sheetNameAgenda: cfg.sheetNameAgenda, cacheSeconds: cfg.cacheAgendaSeconds, timeZone: "Europe/Lisbon" });
    return mod.formatAgendaDepartamentosText_v1(payload, "Europe/Lisbon") || "";
  } catch (e) { return ""; }
}

function registerOnMessage_v5(client, cfg) {
  client.on("message_create", async (message) => {
    if (message.fromMe) return;
    
    const contact = await message.getContact();
    const chatId = contact.id._serialized;
    const bodyRaw = (message.body || "").trim();
    if (!bodyRaw) return;

    try {
      const allRules = await getRules(cfg.spreadsheetId, cfg.sheetNameResp, cfg.cacheSeconds);
      
      let fullName = "", isColab = false;
      try {
        const acc = await getAccessByChatId({ spreadsheetId: cfg.spreadsheetId, sheetNameBp: cfg.sheetNameBp, chatId, cacheSeconds: cfg.cacheBpSeconds });
        fullName = acc?.fullName || "";
        isColab = !!acc?.isColab;
      } catch (e) {}

      console.log("[TRACE_RX]", `chat=${chatId}`, `raw="${bodyRaw}"`);

      // 1. GESTÃO DE SAUDAÇÃO INICIAL
      let greetingText = "";
      if (!greeted.has(chatId)) {
        greeted.add(chatId);
        const key = isColab ? "GREET_COLAB" : "GREET_PUBLIC";
        const ruleGreet = allRules.find(r => (r.CHAVE || r.chave) === key) || allRules.find(r => (r.CHAVE || r.chave) === "GREET");
        if (ruleGreet) {
          greetingText = buildHumanizedResponse(ruleGreet.reply || ruleGreet.RESPOSTA, getFirstName(fullName), getDayGreetingPt());
        }
      }

      if (shouldSendMenuNow(bodyRaw)) {
        const ruleMenu = allRules.find(r => (r.CHAVE || r.chave) === "MENU");
        if (ruleMenu) return await client.sendMessage(chatId, ruleMenu.reply || ruleMenu.RESPOSTA);
      }

      // 2. CHAMADA DA IA
      console.log("[IA] Analisando intenção...");
      let aiResult = { id_table: "ERR", resposta: FALLBACK_DEFAULT };
      try {
        const agendaParaIA = await fetchAgendaDepartamentos_v1({ cfg });
        aiResult = await analisarComIA(bodyRaw, getFirstName(fullName), [], allRules, agendaParaIA);
      } catch (err) { aiResult = { id_table: "FALHA", resposta: "" }; }

      let finalReply = String(aiResult.resposta || "").trim();
      let usedIdTable = String(aiResult.id_table || "").trim();
      let processoReal = "";

      // 3. RADAR DE PROCESSOS (Livraria, Agenda, Colab)
      if (usedIdTable && usedIdTable !== "IA_GENERICA" && usedIdTable !== "ERR") {
          const regraExata = allRules.find(r => String(r.ID_TABLE || r.id_table) === usedIdTable);
          if (regraExata) {
              processoReal = String(regraExata.PROCESSO || regraExata.processo || "").trim();
              
              // Se a coluna processo estiver vazia na planilha, tenta ler do texto (fallback)
              if (!processoReal) {
                  const textoOri = String(regraExata.reply || regraExata.RESPOSTA || "");
                  if (textoOri.includes("__APP_LIVRARIA_FILTRO_AUTOR__")) processoReal = "__APP_LIVRARIA_FILTRO_AUTOR__";
                  else if (textoOri.includes("__APP_LIVRARIA_FILTRO_EDITORA__")) processoReal = "__APP_LIVRARIA_FILTRO_EDITORA__";
                  else if (textoOri.includes("__APP_LIVRARIA_AUTORES__")) processoReal = "__APP_LIVRARIA_AUTORES__";
                  else if (textoOri.includes("__APP_LIVRARIA_EDITORAS__")) processoReal = "__APP_LIVRARIA_EDITORAS__";
                  else if (textoOri.includes("__APP_LIVRARIA_SEARCH__")) processoReal = "__APP_LIVRARIA_SEARCH__";
                  else if (textoOri.includes("__APP_LIVRARIA__")) processoReal = "__APP_LIVRARIA__";
                  else if (textoOri.includes("__APP_AGENDA_FULL__")) processoReal = "__APP_AGENDA_FULL__";
                  else if (textoOri.includes("__APP_ENSAIO__")) processoReal = "__APP_ENSAIO__";
                  else if (textoOri.includes("__AUSENCIAS__") || textoOri.includes("__APP_AUSENCIAS__")) processoReal = "__APP_AUSENCIAS__";
              }

              // Limpeza de etiquetas do texto final para o usuário
              finalReply = finalReply
                  .replace(/__APP_LIVRARIA_FILTRO_AUTOR__/g, "").replace(/__APP_LIVRARIA_FILTRO_EDITORA__/g, "")
                  .replace(/__APP_LIVRARIA_AUTORES__/g, "").replace(/__APP_LIVRARIA_EDITORAS__/g, "")
                  .replace(/__APP_LIVRARIA_SEARCH__/g, "").replace(/__APP_LIVRARIA__/g, "")
                  .replace(/__APP_AGENDA_FULL__/g, "").replace(/__APP_ENSAIO__/g, "")
                  .replace(/__APP_AUSENCIAS__/g, "").replace(/__AUSENCIAS__/g, "");
          }
      }

      // 4. BLOQUEIO DE SAUDAÇÃO DUPLA
      if (finalReply === "SAUDACAO_DUPLA" || usedIdTable === "SAUDACAO_DUPLA") {
        if (greetingText) {
            finalReply = ""; usedIdTable = "Bloqueado_Duplicado";
        } else {
            finalReply = "Olá! Graça e paz. Como posso ajudar?"; usedIdTable = "Saudacao_IA";
        }
      }

      // 5. EXECUÇÃO LÓGICA DOS PROCESSOS
      if (processoReal) {
          console.log(`[SISTEMA] Executando processo: ${processoReal}`);
          try {
              // --- COLABORADORES (Ensaio e Ausência) ---
              if (processoReal === "__APP_ENSAIO__") {
                  let mod = require("../services/appEnsaio");
                  if (typeof mod.getEscalaEnsaios_v1 === "function") {
                      const dados = await mod.getEscalaEnsaios_v1({ chatId, fullName });
                      finalReply += "\n\n" + dados;
                  }
              } else if (processoReal === "__AUSENCIAS__" || processoReal === "__APP_AUSENCIAS__") {
                  let mod = require("../services/appAusencias");
                  if (typeof mod.getMinhasAusencias_v1 === "function") {
                      const dados = await mod.getMinhasAusencias_v1({ chatId, fullName });
                      finalReply += "\n\n" + dados;
                  }
              } 
              // --- AGENDAS ---
              else if (processoReal === "__APP_AGENDA_FULL__") {
                  let mod = require("../services/appAgenda");
                  const payload = await mod.getAgendaDepartamentos_v1({ spreadsheetId: cfg.spreadsheetId, sheetNameAgenda: cfg.sheetNameAgenda, cacheSeconds: cfg.cacheAgendaSeconds, timeZone: "Europe/Lisbon" });
                  finalReply += "\n\n" + mod.formatAgendaDepartamentosText_v1(payload, "Europe/Lisbon");
              }
              // --- LIVRARIA ---
              else if (processoReal.includes("__APP_LIVRARIA")) {
                  let mod = require("../services/appLivraria");
                  let resLivraria = "";
                  const sheetInfo = { spreadsheetId: "10UDDJdlTuPs65gdPnN7fcDQm6cfNCWp8gqlTqE3lUp4", sheetName: "DB_STOCK" };

                  if (processoReal === "__APP_LIVRARIA__") resLivraria = await mod.getLivrosEmStock_v1({ ...sheetInfo, searchTerm: "" });
                  else if (processoReal === "__APP_LIVRARIA_SEARCH__") resLivraria = await mod.getLivrosEmStock_v1({ ...sheetInfo, searchTerm: bodyRaw });
                  else if (processoReal === "__APP_LIVRARIA_AUTORES__") resLivraria = await mod.getListasLivraria_v1({ ...sheetInfo, tipo: "AUTORES" });
                  else if (processoReal === "__APP_LIVRARIA_EDITORAS__") resLivraria = await mod.getListasLivraria_v1({ ...sheetInfo, tipo: "EDITORAS" });
                  else if (processoReal === "__APP_LIVRARIA_FILTRO_AUTOR__") resLivraria = await mod.getLivrosExclusivos_v1({ ...sheetInfo, tipoFiltro: "AUTOR", termoPesquisa: bodyRaw });
                  else if (processoReal === "__APP_LIVRARIA_FILTRO_EDITORA__") resLivraria = await mod.getLivrosExclusivos_v1({ ...sheetInfo, tipoFiltro: "EDITORA", termoPesquisa: bodyRaw });

                  finalReply += "\n\n" + resLivraria;
              }
          } catch (err) { console.error("[ERRO_PROCESSO]", err.message); }
      }

      // 6. ENVIO FINAL (BOLHAS)
      let textToSend = (greetingText && finalReply) ? `${greetingText}\n\n${finalReply}` : (greetingText || finalReply);
      if (textToSend) {
        const humanReply = buildHumanizedResponse(textToSend, getFirstName(fullName), getDayGreetingPt());
        const mensagens = humanReply.split("|||");
        
        for (const bolha of mensagens) {
          if (bolha.trim()) {
            await simulateTyping(client, chatId, 1500);
            await client.sendMessage(chatId, bolha.trim());
          }
        }
        console.log(`[AUDITORIA] chat: ${chatId} | ID: ${usedIdTable} | Proc: ${processoReal || 'Nenhum'}`);
      }
    } catch (e) { console.error("[CRITICAL_ERR]", e); }
  });
}

module.exports = { registerOnMessage_v5 };