//###################################################################################
// src/handlers/onMessage.js
//###################################################################################
"use strict";

const { getRules, buildHumanizedResponse } = require("../services/responsesStore");
const { getAccessByChatId } = require("../services/bpLookup");
const { analisarComIA } = require("../services/aiAssistant");

const FALLBACK_DEFAULT = "Ups, a minha ligação falhou por um instante.";

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

function registerOnMessage_v5(client, cfg) {
  client.on("message_create", async (message) => {
    if (message.fromMe) return;
    
    const contact = await message.getContact();
    const chatId = contact.id._serialized;
    const bodyRaw = (message.body || "").trim();
    if (!bodyRaw) return;

    try {
      const allRules = await getRules(cfg.spreadsheetId, cfg.sheetNameResp, cfg.cacheSeconds);
      
      let fullName = "", isColab = false, accData = null;
      try {
        accData = await getAccessByChatId({ spreadsheetId: cfg.spreadsheetId, sheetNameBp: cfg.sheetNameBp, chatId, cacheSeconds: cfg.cacheBpSeconds });
        fullName = accData?.fullName || "";
        isColab = !!accData?.isColab;
      } catch (e) {}

      // 1. MAPEAMENTO DE SAUDAÇÕES
      let greetingText = "";
      let greetIds = ["SAUDACAO_DUPLA"];
      
      const r1 = allRules.find(r => (r.CHAVE || r.chave) === "GREET_COLAB");
      const r2 = allRules.find(r => (r.CHAVE || r.chave) === "GREET_PUBLIC");
      const r3 = allRules.find(r => (r.CHAVE || r.chave) === "GREET");
      
      if (r1) greetIds.push(String(r1.ID_TABLE || r1.id_table));
      if (r2) greetIds.push(String(r2.ID_TABLE || r2.id_table));
      if (r3) greetIds.push(String(r3.ID_TABLE || r3.id_table));

      if (!greeted.has(chatId)) {
        greeted.add(chatId);
        const key = isColab ? "GREET_COLAB" : "GREET_PUBLIC";
        const ruleGreet = allRules.find(r => (r.CHAVE || r.chave) === key) || r3;
        if (ruleGreet) greetingText = buildHumanizedResponse(ruleGreet.reply || ruleGreet.RESPOSTA, getFirstName(fullName), getDayGreetingPt());
      }

      // 2. IA ANALISA INTENÇÃO
      let aiResult = { id_table: "ERR", resposta: "", termo: "", contexto: "" };
      try {
        let mod = require("../services/appAgenda");
        // A IA recebe a agenda completa (onlyCurrentMonth: false) para ter todo o contexto da igreja
        const payloadIA = await mod.getAgendaDepartamentos_v1({ spreadsheetId: cfg.spreadsheetId, sheetNameAgenda: cfg.sheetNameAgenda, cacheSeconds: cfg.cacheAgendaSeconds, timeZone: "Europe/Lisbon", onlyCurrentMonth: false });
        const agendaParaIA = mod.formatAgendaDepartamentosText_v1(payloadIA, "Europe/Lisbon");
        aiResult = await analisarComIA(bodyRaw, getFirstName(fullName), [], allRules, agendaParaIA);
      } catch (err) { aiResult = { id_table: "FALHA", resposta: "" }; }

      let finalReply = String(aiResult.resposta || "").trim();
      let usedIdTable = String(aiResult.id_table || "").trim();
      let processoReal = "";
      let contextoReal = String(aiResult.contexto || "Nenhum").trim();

      // 🛡️ CONTROLE DE DUPLICAÇÃO
      if (greetIds.includes(usedIdTable) || finalReply.includes("SAUDACAO_DUPLA")) {
          if (greetingText) { 
              finalReply = ""; usedIdTable = "Bloqueio_Duplicado"; contextoReal = "Sistema";
          } else { 
              const regraSecundaria = allRules.find(r => String(r.ID_TABLE || r.id_table) === usedIdTable);
              if (regraSecundaria && regraSecundaria.reply) {
                  finalReply = buildHumanizedResponse(regraSecundaria.reply, getFirstName(fullName), getDayGreetingPt());
              } else { finalReply = "Olá! Como posso ajudar?"; }
              usedIdTable = "Saudacao_IA"; contextoReal = "Sistema";
          }
      }

      // 3. IDENTIFICA PROCESSO E CONTEXTO EXATO
      if (usedIdTable.includes("APP_")) {
          processoReal = usedIdTable;
          if (!processoReal.startsWith("__")) processoReal = "__" + processoReal;
          if (!processoReal.endsWith("__")) processoReal = processoReal + "__";
          contextoReal = "LIVRARIA";
      } else if (usedIdTable && usedIdTable !== "Bloqueio_Duplicado" && usedIdTable !== "Saudacao_IA" && usedIdTable !== "IA_GENERICA" && usedIdTable !== "ERR") {
          const regra = allRules.find(r => String(r.ID_TABLE || r.id_table) === usedIdTable);
          if (regra) {
              processoReal = String(regra.PROCESSO || regra.processo || "").trim();
              if (regra.CONTEXTO || regra.contexto) contextoReal = String(regra.CONTEXTO || regra.contexto).trim();
          }
      }

      // 🚨 OVERRIDE DE SEGURANÇA LIVRARIA
      const msgLower = bodyRaw.toLowerCase();
      if (msgLower.includes("quais as editoras") || msgLower.includes("lista de editoras")) {
          processoReal = "__APP_LIVRARIA_EDITORAS__"; contextoReal = "LIVRARIA";
      } else if (msgLower.includes("quais os autores") || msgLower.includes("lista de autores")) {
          processoReal = "__APP_LIVRARIA_AUTORES__"; contextoReal = "LIVRARIA";
      } else if ((msgLower.includes("editora") || msgLower.includes("editoras")) && aiResult.termo) {
          processoReal = "__APP_LIVRARIA_FILTRO_EDITORA__"; contextoReal = "LIVRARIA";
      } else if ((msgLower.includes("autor") || msgLower.includes("autores")) && aiResult.termo) {
          processoReal = "__APP_LIVRARIA_FILTRO_AUTOR__"; contextoReal = "LIVRARIA";
      } else if (aiResult.termo && (!processoReal || processoReal === "__APP_LIVRARIA__" || processoReal.includes("SEARCH"))) {
          processoReal = "__APP_LIVRARIA_SEARCH__"; contextoReal = "LIVRARIA";
      }

      // Limpeza de texto
      finalReply = finalReply.replace(/^\d+[\.\)].*$/gm, "").replace(/^[\s\t]*[\-\*•].*$/gm, "").replace(/\n\s*\n/g, '\n').trim();

      // 4. EXECUÇÃO DE PROCESSOS
      if (processoReal) {
          const termoExtraido = (aiResult.termo || bodyRaw).trim();
          try {
              if (processoReal === "__APP_ENSAIO__") {
                  let mod = require("../services/appEnsaio");
                  finalReply += "\n\n" + await mod.getEscalaEnsaios_v1({ chatId, fullName });
              } else if (processoReal === "__AUSENCIAS__" || processoReal === "__APP_AUSENCIAS__") {
                  let mod = require("../services/appAusencias");
                  finalReply += "\n\n" + await mod.getMinhasAusencias_v1({ chatId, fullName });
              } else if (processoReal === "__APP_AGENDA__" || processoReal === "__APP_AGENDA_FULL__") {
                  // 🚨 AQUI ESTÁ A MAGIA DO INTERRUPTOR!
                  let mod = require("../services/appAgenda");
                  const isFull = (processoReal === "__APP_AGENDA_FULL__");
                  
                  const payload = await mod.getAgendaDepartamentos_v1({ 
                      spreadsheetId: cfg.spreadsheetId, 
                      sheetNameAgenda: cfg.sheetNameAgenda, 
                      cacheSeconds: cfg.cacheAgendaSeconds, 
                      timeZone: "Europe/Lisbon",
                      onlyCurrentMonth: !isFull // Se não for FULL, acende o interruptor para barrar meses futuros!
                  });
                  
                  const agendaText = mod.formatAgendaDepartamentosText_v1(payload, "Europe/Lisbon");
                  if (agendaText) finalReply += "\n\n" + agendaText;
                  
              } else if (processoReal.includes("__APP_LIVRARIA")) {
                  let mod = require("../services/appLivraria");
                  const sInfo = { spreadsheetId: "10UDDJdlTuPs65gdPnN7fcDQm6cfNCWp8gqlTqE3lUp4", sheetName: "DB_STOCK" };
                  let res = "";
                  
                  if (processoReal === "__APP_LIVRARIA__") res = await mod.getLivrosEmStock_v1({ ...sInfo, searchTerm: "" });
                  else if (processoReal === "__APP_LIVRARIA_SEARCH__") res = await mod.getLivrosEmStock_v1({ ...sInfo, searchTerm: termoExtraido });
                  else if (processoReal === "__APP_LIVRARIA_AUTORES__") res = await mod.getListasLivraria_v1({ ...sInfo, tipo: "AUTORES" });
                  else if (processoReal === "__APP_LIVRARIA_EDITORAS__") res = await mod.getListasLivraria_v1({ ...sInfo, tipo: "EDITORAS" });
                  else if (processoReal === "__APP_LIVRARIA_FILTRO_AUTOR__") res = await mod.getLivrosExclusivos_v1({ ...sInfo, tipoFiltro: "AUTOR", termoPesquisa: termoExtraido });
                  else if (processoReal === "__APP_LIVRARIA_FILTRO_EDITORA__") res = await mod.getLivrosExclusivos_v1({ ...sInfo, tipoFiltro: "EDITORA", termoPesquisa: termoExtraido });
                  
                  finalReply += "\n\n" + res;
              }
          } catch (e) { console.error("[ERRO_EXEC]", e); }
      }

      // 5. ENVIO DAS MENSAGENS
      let textToSend = (greetingText && finalReply) ? `${greetingText}\n\n${finalReply}` : (greetingText || finalReply);
      if (textToSend && usedIdTable !== "Bloqueio_Duplicado") {
          const humanReply = buildHumanizedResponse(textToSend, getFirstName(fullName), getDayGreetingPt());
          const mensagens = humanReply.split("|||");
          for (const bolha of mensagens) {
              if (bolha.trim()) {
                  await simulateTyping(client, chatId, 1000);
                  await client.sendMessage(chatId, bolha.trim());
              }
          }
      } else if (greetingText && usedIdTable === "Bloqueio_Duplicado") {
          await client.sendMessage(chatId, greetingText);
      }

      // 🌟 LOGGER DE AUDITORIA
      let termoImpresso = aiResult.termo ? aiResult.termo : "Nenhum";
      const listaDepts = (accData?.depts && accData.depts.length > 0) ? accData.depts.join(", ") : "Nenhum";
      console.log("---------------------------------------------------------");
      console.log(`[AUDITORIA] DATA: ${new Date().toLocaleString("pt-PT")}`);
      console.log(` > USUÁRIO: ${fullName || "Visitante"} | STATUS: ${isColab ? "🟢 Colab" : "⚪ Público"}`);
      console.log(` > DEPTOS: ${listaDepts}`);
      console.log(` > MENSAGEM: ${bodyRaw}`);
      console.log(` > CONTEXTO: ${contextoReal}`);
      console.log(` > ID_TABLE: ${usedIdTable} | PROCESSO: ${processoReal || 'Nenhum'}`);
      console.log(` > TERMO_IA: ${termoImpresso}`);
      console.log("---------------------------------------------------------");

    } catch (e) { console.error("[CRITICAL]", e); }
  });
}

module.exports = { registerOnMessage_v5 };