//###################################################################################
// src/handlers/onMessage.js
//###################################################################################
"use strict";

const { getRules, buildHumanizedResponse } = require("../services/responsesStore");
const { getAccessByChatId } = require("../services/bpLookup");
const { analisarComIA } = require("../services/aiAssistant");
const billing = require("../services/appBilling"); // 💰 Importado para faturação

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

// ==================================================================================
// 🛡️ SISTEMA ANTI-SPAM (Rate Limiting / Prevenção EDoS)
// ==================================================================================
const spamMonitor = new Map();
const SPAM_LIMIT = 10; // Máximo de mensagens permitidas
const SPAM_WINDOW_MS = 60 * 1000; // Num intervalo de 1 minuto
const BLOCK_DURATION_MS = 5 * 60 * 1000; // Tempo de castigo (5 minutos)

function isSpamming(chatId) {
    const now = Date.now();
    const user = spamMonitor.get(chatId);

    if (!user) {
        spamMonitor.set(chatId, { count: 1, startTime: now, blockedUntil: 0 });
        return false;
    }

    if (now < user.blockedUntil) return true;

    if (now - user.startTime > SPAM_WINDOW_MS) {
        user.count = 1;
        user.startTime = now;
        return false;
    }

    user.count++;

    if (user.count > SPAM_LIMIT) {
        user.blockedUntil = now + BLOCK_DURATION_MS;
        console.warn(`[ANTI-SPAM] 🚨 O número ${chatId} foi bloqueado por ${BLOCK_DURATION_MS / 60000} minutos devido a excesso de mensagens.`);
        return true;
    }

    return false;
}
// ==================================================================================

async function simulateTyping(client, chatId, delayMs = 1500) {
  try {
    const chat = await client.getChatById(chatId);
    if (chat && chat.sendStateTyping) await chat.sendStateTyping();
  } catch (e) {}
  await new Promise(resolve => setTimeout(resolve, delayMs));
}

function registerOnMessage_v5(client, cfg) {
  client.on("message", async (message) => {
    
    if (message.fromMe || message.isStatus) return;
    
    const chat = await message.getChat();
    if (chat.isGroup) return;

    const contact = await message.getContact();
    const chatId = contact.id._serialized;
    const bodyRaw = (message.body || "").trim();
    if (!bodyRaw) return;

    if (isSpamming(chatId)) {
        return; 
    }

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

      // 🚨 OVERRIDE DE SEGURANÇA LIVRARIA E ADMIN
      const msgLower = bodyRaw.toLowerCase();
      if (msgLower === "testar sistema" || msgLower === "task list" || msgLower === "saldo" || msgLower === "/saldo") {
          processoReal = "ADMIN"; contextoReal = "SISTEMA"; 
      } else if (msgLower.includes("quais as editoras") || msgLower.includes("lista de editoras")) {
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

      if (contextoReal === "LIVRARIA") {
          finalReply = finalReply.replace(/^\d+[\.\)].*$/gm, "").replace(/^[\s\t]*[\-\*•].*$/gm, "").replace(/\n\s*\n/g, '\n').trim();
      }

      // 4. EXECUÇÃO DE PROCESSOS
      if (processoReal) {
          const termoExtraido = (aiResult.termo || bodyRaw).trim();
          
          if (processoReal === "ADMIN" || processoReal === "ADMIM" || processoReal === "__ADMIN_TEST__") {
              const adminId = String(process.env.ADMIN_CHAT_ID || "").trim();

              if (chatId !== adminId) {
                  finalReply = "⛔ *Acesso Negado:* Este comando é restrito ao Administrador.";
              } else {
                  if (msgLower === "saldo" || msgLower === "/saldo") {
                      finalReply = await billing.getOpenAISaldo_v1({ spreadsheetId: cfg.spreadsheetId });
                  } 
                  else if (msgLower === "task list" || msgLower === "testar sistema") {
                      await client.sendMessage(chatId, "⚙️ *MODO DE TESTE ATIVADO* ⚙️\nVou simular as respostas da sheet [RESPONSES] onde a PRIORIDADE é maior que 0.\n\n_(Aguarde, enviarei com pausas para evitar bloqueios do WhatsApp)_");

                      const regrasParaTestar = allRules.filter(r => {
                          const prio = Number(r.PRIORIDADE || r.prioridade || 0);
                          return !isNaN(prio) && prio > 0;
                      }).sort((a, b) => Number(a.ID_TABLE || a.id_table || 0) - Number(b.ID_TABLE || b.id_table || 0));

                      if (regrasParaTestar.length === 0) {
                          await client.sendMessage(chatId, "🤷‍♂️ Não encontrei nenhuma regra com a coluna PRIORIDADE configurada maior que zero.");
                          return;
                      }

                      for (const regra of regrasParaTestar) {
                          const idTable = regra.ID_TABLE || regra.id_table || "?";
                          const chave = String(regra.CHAVE || regra.chave || "(Sem Pergunta)").trim();
                          const proc = String(regra.PROCESSO || regra.processo || "").trim();
                          const repBase = String(regra.REPLY || regra.reply || regra.RESPOSTA || regra.resposta || "").trim();

                          let resParcial = repBase;

                          if (proc) {
                              try {
                                  if (proc === "__APP_ENSAIO__") {
                                      const modEnsaio = require("../services/appEnsaio");
                                      if (typeof modEnsaio.appEnsaio === "function") resParcial = await modEnsaio.appEnsaio({ pushname: "Admin" });
                                      else {
                                          const out = await modEnsaio.getLatestEnsaio_v1({ spreadsheetId: cfg.spreadsheetId, sheetNameEnsaio: cfg.sheetNameEnsaio });
                                          resParcial = out && out.DATA ? `[Simulação] Ensaio: *${out.DATA}* às *${out.HORARIO}*` : "[Simulação] Sem dados de ensaio.";
                                      }
                                  } else if (proc === "__AUSENCIAS__" || proc === "__APP_AUSENCIAS__") {
                                      const modAusencias = require("../services/appAusencias");
                                      resParcial = await modAusencias.getMinhasAusencias_v1({ chatId, fullName: "Admin" });
                                  } else if (proc === "__APP_AGENDA__" || proc === "__APP_AGENDA_FULL__") {
                                      const modAgenda = require("../services/appAgenda");
                                      const payload = await modAgenda.getAgendaDepartamentos_v1({
                                          spreadsheetId: cfg.spreadsheetId, sheetNameAgenda: cfg.sheetNameAgenda,
                                          cacheSeconds: cfg.cacheAgendaSeconds, timeZone: "Europe/Lisbon", onlyCurrentMonth: proc !== "__APP_AGENDA_FULL__"
                                      });
                                      resParcial = modAgenda.formatAgendaDepartamentosText_v1(payload, "Europe/Lisbon");
                                  } else if (proc.includes("__APP_LIVRARIA")) {
                                      const modLivraria = require("../services/appLivraria");
                                      const sInfo = { spreadsheetId: "10UDDJdlTuPs65gdPnN7fcDQm6cfNCWp8gqlTqE3lUp4", sheetName: "DB_STOCK" };
                                      if (proc === "__APP_LIVRARIA__") resParcial = await modLivraria.getLivrosEmStock_v1({ ...sInfo, searchTerm: "" });
                                      else if (proc === "__APP_LIVRARIA_AUTORES__") resParcial = await modLivraria.getListasLivraria_v1({ ...sInfo, tipo: "AUTORES" });
                                      else if (proc === "__APP_LIVRARIA_EDITORAS__") resParcial = await modLivraria.getListasLivraria_v1({ ...sInfo, tipo: "EDITORAS" });
                                  }
                              } catch (e) {
                                  resParcial = `❌ [Erro a simular processo ${proc}]: ${e.message}`;
                              }
                          }
                          const testMsg = `📝 *[ID: ${idTable}]*\n🗣️ *Pergunta:* "${chave}"\n🤖 *Bot responde:*\n${resParcial}`;
                          await simulateTyping(client, chatId, 1500);
                          await client.sendMessage(chatId, testMsg);
                          await new Promise(resolve => setTimeout(resolve, 3000));
                      }
                      await simulateTyping(client, chatId, 1000);
                      await client.sendMessage(chatId, "✅ *Task List Finalizada!*");
                      return;
                  }
              }
          }
          else {
              try {
                  if (processoReal === "__APP_ENSAIO__") {
                      // 🚨 CORREÇÃO FEITA AQUI: Agora usamos as funções corretas de appEnsaio.js
                      let mod = require("../services/appEnsaio");
                      if (typeof mod.appEnsaio === "function") {
                          finalReply = await mod.appEnsaio({ pushname: fullName });
                      } else if (typeof mod.getLatestEnsaio_v1 === "function") {
                          const out = await mod.getLatestEnsaio_v1({ spreadsheetId: cfg.spreadsheetId, sheetNameEnsaio: cfg.sheetNameEnsaio });
                          if (out && out.DATA) finalReply += `\n\nO próximo ensaio está marcado para *${out.DATA}* às *${out.HORARIO}*. Responsável: ${out.RESPONSAVEL || "Não definido"}.`;
                          else finalReply += "\n\nNão encontrei a data do próximo ensaio.";
                      } else {
                          finalReply += "\n\n[Sistema] Erro: Função do Ensaio não encontrada no módulo.";
                      }
                  } else if (processoReal === "__AUSENCIAS__" || processoReal === "__APP_AUSENCIAS__") {
                      let mod = require("../services/appAusencias");
                      finalReply += "\n\n" + await mod.getMinhasAusencias_v1({ chatId, fullName });
                  } else if (processoReal === "__APP_AGENDA__" || processoReal === "__APP_AGENDA_FULL__") {
                      let mod = require("../services/appAgenda");
                      const isFull = (processoReal === "__APP_AGENDA_FULL__");
                      const payload = await mod.getAgendaDepartamentos_v1({ 
                          spreadsheetId: cfg.spreadsheetId, sheetNameAgenda: cfg.sheetNameAgenda, 
                          cacheSeconds: cfg.cacheAgendaSeconds, timeZone: "Europe/Lisbon", onlyCurrentMonth: !isFull 
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
      }

      // 5. ENVIO DAS MENSAGENS NO FLUXO NORMAL
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
          if (!["ADMIN", "Bloqueio_Duplicado", "FALHA", "ERR"].includes(usedIdTable)) {
              await billing.registrarGasto_v1({ spreadsheetId: cfg.spreadsheetId, chatId, mensagem: bodyRaw });
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

function registerOnMessage_v4(client, cfg) { return registerOnMessage_v5(client, cfg); }
module.exports = { registerOnMessage_v4, registerOnMessage_v5 };