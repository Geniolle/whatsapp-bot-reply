//###################################################################################
// src/handlers/onMessage.js - VERSÃO COMPLETA (IA, AGENDAMENTO, COLAB FIX, LOGS)
//###################################################################################
"use strict";

const { getRules, buildHumanizedResponse } = require("../services/responsesStore");
const { getAccessByChatId, desativarMensagensWS } = require("../services/bpLookup");
const { analisarComIA } = require("../services/aiAssistant");
const { findAllPendingByLeader, updateStatusById } = require("../services/appScheduling");
const { normalizeText } = require("../services/router");
const billing = require("../services/appBilling");
const { logFallback } = require("../services/fallbackLog");

const greeted = new Set();
const spamMonitor = new Map();
const schedulingContexts = new Map();

const SPAM_LIMIT = 10;
const SPAM_WINDOW_MS = 60 * 1000;
const BLOCK_DURATION_MS = 5 * 60 * 1000;

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
        console.warn(`[ANTI-SPAM] 🚨 Bloqueado temporariamente: ${chatId}`);
        return true;
    }
    return false;
}

async function simulateTyping(client, chatId, delayMs = 1500) {
    try {
        const chat = await client.getChatById(chatId);
        if (chat && chat.sendStateTyping) await chat.sendStateTyping();
    } catch (e) {}
    await new Promise(resolve => setTimeout(resolve, delayMs));
}

async function safeSend(client, chatId, text) {
    try { await client.sendMessage(chatId, text); return true; } catch (e) { return false; }
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

// ==============================================================================
// FLUXO DE AGENDAMENTO (PRIORIDADE SOBRE A IA)
// ==============================================================================
async function handleSchedulingFlow(client, senderId, dbId, bodyRaw, cfg) {
    const textRaw = bodyRaw.trim();
    const textNorm = normalizeText(textRaw);

    if (textNorm.includes("confirmacao de solicitacao")) return true;

    if (schedulingContexts.has(dbId)) {
        const context = schedulingContexts.get(dbId);
        const requestId = textRaw.replace(/\D/g, "");
        if (requestId) {
            const success = await executeFinalAction(client, senderId, dbId, requestId, context.action, cfg);
            if (success) {
                schedulingContexts.delete(dbId);
                greeted.add(dbId);
                return true;
            }
        }
    }

    const isConfirm = ["confirmar", "confirmo", "confirmado", "aceito", "ok", "sim"].includes(textNorm);
    const isReject = ["recusar", "recuso", "recusado", "nao", "não"].includes(textNorm);

    if (!isConfirm && !isReject) return false;

    try {
        const pendings = await findAllPendingByLeader({ spreadsheetId: cfg.spreadsheetId, leaderChatId: dbId });

        if (pendings.length === 0) {
            const generic = ["aceito", "ok", "sim", "nao", "não"];
            if (generic.includes(textNorm)) return false; // Deixa a IA responder a um simples "Sim" ou "Não"

            await safeSend(client, senderId, "⚠️ *Aviso do Sistema*\n\nEntendi o comando, mas não encontrei solicitações de apoio pendentes.");
            greeted.add(dbId);
            return true;
        }

        const actionStatus = isConfirm ? "Confirmado ✅" : "Recusado ❌";

        if (pendings.length === 1) {
            await executeFinalAction(client, senderId, dbId, pendings[0].id, actionStatus, cfg);
            greeted.add(dbId);
            return true;
        }

        let listMsg = `Olá! Encontrei *${pendings.length} solicitações*.\n\nQual deseja marcar como *${actionStatus}*?\n\n`;
        pendings.forEach(p => { listMsg += `🆔 *ID: ${p.id}*\n👤 De: ${p.solicitante}\n📝 Detalhes: ${p.detalhes}\n--------------------------\n`; });
        listMsg += `\nResponda apenas com o número do ID.`;

        await simulateTyping(client, senderId, 1500);
        await safeSend(client, senderId, listMsg);
        schedulingContexts.set(dbId, { action: actionStatus });
        greeted.add(dbId);
        return true;
    } catch (e) {
        console.error("[SCHEDULING_ERR]", e);
        return false;
    }
}

async function executeFinalAction(client, senderId, dbId, requestId, newStatus, cfg) {
    const data = await updateStatusById({ spreadsheetId: cfg.spreadsheetId, requestId, newStatus });
    if (data) {
        await safeSend(client, senderId, `✅ Feito! O pedido *#${requestId}* foi marcado como *${newStatus.toUpperCase()}*.`);
        const reqNum = String(data.numeroSolicitante || "").replace(/\D/g, "");
        if (reqNum) {
            const notification = `📢 *FEEDBACK DE APOIO*\n\nO pedido de apoio (#${requestId}) enviado ao responsável *${data.apoioData.liderNome}*, do departamento *${data.apoioData.departamento}*, foi *${newStatus.toUpperCase()}*.\n\nPara qualquer dúvida ou questão, por favor, entre em contacto direto com o mesmo.`;
            await safeSend(client, `${reqNum}@c.us`, notification);
        }
        return true;
    }
    return false;
}

// ==============================================================================
// HANDLER PRINCIPAL DO BOT
// ==============================================================================
function registerOnMessage_v5(client, cfg) {
    client.on("message", async (message) => {
        if (message.fromMe || message.isStatus) return;

        const chat = await message.getChat();
        if (chat.isGroup) return;

        const contact = await message.getContact();
        const senderId = contact.id._serialized;
        let dbId = senderId;

        // 1. RESOLVER LID (Para buscar na Base de Dados)
        if (senderId.includes("@lid")) {
            if (contact.number) dbId = `${contact.number}@c.us`;
        }

        const bodyRaw = (message.body || "").trim();
        if (!bodyRaw) return;

        if (isSpamming(dbId)) return;

        // 2. BUSCAR IDENTIDADE (COLAB) *ANTES* DE QUALQUER COISA
        let fullName = "", isColab = false, accData = null;
        try {
            accData = await getAccessByChatId({
                spreadsheetId: cfg.spreadsheetId,
                sheetNameBp: cfg.sheetNameBp,
                chatId: dbId,
                cacheSeconds: cfg.cacheBpSeconds
            });
            fullName = accData?.fullName || "";
            isColab = !!accData?.isColab;
        } catch (e) {}

        const firstName = getFirstName(fullName) || "Visitante";

        // LOG DE ENTRADA (Como pediste!)
        console.log(`[TRACE_RX] chat=${dbId} | Colab=${isColab ? "Sim" : "Não"} | Msg: "${bodyRaw}"`);

        // 3. OPT-OUT
        if (bodyRaw.toUpperCase() === "SAIR") {
            const telefone = dbId.split("@")[0];
            const removido = await desativarMensagensWS(cfg.spreadsheetId, cfg.sheetNameBp, telefone);
            await safeSend(client, senderId, removido ? "✅ Removido com sucesso." : "⚠️ Erro ao processar.");
            return;
        }

        // 4. AGENDAMENTOS (Confirma/Recusa)
        if (await handleSchedulingFlow(client, senderId, dbId, bodyRaw, cfg)) return;

        // 5. FLUXO NORMAL DA IA E REGRAS
        try {
            const allRules = await getRules(cfg.spreadsheetId, cfg.sheetNameResp, cfg.cacheSeconds);

            // SAUDAÇÃO
            let greetingText = "";
            let greetIds = ["SAUDACAO_DUPLA"];

            const r1 = allRules.find(r => (r.CHAVE || r.chave) === "GREET_COLAB");
            const r2 = allRules.find(r => (r.CHAVE || r.chave) === "GREET_PUBLIC");
            const r3 = allRules.find(r => (r.CHAVE || r.chave) === "GREET");

            if (r1) greetIds.push(String(r1.ID_TABLE || r1.id_table));
            if (r2) greetIds.push(String(r2.ID_TABLE || r2.id_table));
            if (r3) greetIds.push(String(r3.ID_TABLE || r3.id_table));

            if (!greeted.has(dbId)) {
                greeted.add(dbId);
                const key = isColab ? "GREET_COLAB" : "GREET_PUBLIC";
                const ruleGreet = allRules.find(r => (r.CHAVE || r.chave) === key) || r3;
                if (ruleGreet) greetingText = buildHumanizedResponse(ruleGreet.reply || ruleGreet.RESPOSTA, firstName, getDayGreetingPt());
            }

            // IA ANALISA A INTENÇÃO
            let aiResult = { id_table: "ERR", resposta: "", termo: "", contexto: "" };
            try {
                let mod = require("../services/appAgenda");
                const payloadIA = await mod.getAgendaDepartamentos_v1({ spreadsheetId: cfg.spreadsheetId, sheetNameAgenda: cfg.sheetNameAgenda, cacheSeconds: cfg.cacheAgendaSeconds, timeZone: "Europe/Lisbon", onlyCurrentMonth: false });
                const agendaParaIA = mod.formatAgendaDepartamentosText_v1(payloadIA, "Europe/Lisbon");
                aiResult = await analisarComIA(bodyRaw, firstName, [], allRules, agendaParaIA);
            } catch (err) { aiResult = { id_table: "FALHA", resposta: "" }; }

            let finalReply = String(aiResult.resposta || "").trim();
            let usedIdTable = String(aiResult.id_table || "").trim();
            let processoReal = String(aiResult.processo || "").trim();
            let contextoReal = String(aiResult.contexto || "Nenhum").trim();

            if (greetIds.includes(usedIdTable) || finalReply.includes("SAUDACAO_DUPLA")) {
                if (greetingText) {
                    finalReply = ""; usedIdTable = "Bloqueio_Duplicado"; contextoReal = "Sistema";
                } else {
                    const regraSecundaria = allRules.find(r => String(r.ID_TABLE || r.id_table) === usedIdTable);
                    if (regraSecundaria && regraSecundaria.reply) {
                        finalReply = buildHumanizedResponse(regraSecundaria.reply, firstName, getDayGreetingPt());
                    } else { finalReply = "Olá! Como posso ajudar?"; }
                    usedIdTable = "Saudacao_IA"; contextoReal = "Sistema";
                }
            }

            if (usedIdTable.includes("APP_")) {
                processoReal = usedIdTable;
                if (!processoReal.startsWith("__")) processoReal = "__" + processoReal;
                if (!processoReal.endsWith("__")) processoReal = processoReal + "__";
                contextoReal = "LIVRARIA";
            } else if (usedIdTable && usedIdTable !== "Bloqueio_Duplicado" && usedIdTable !== "Saudacao_IA" && usedIdTable !== "IA_GENERICA" && usedIdTable !== "ERR") {
                const regra = allRules.find(r => String(r.ID_TABLE || r.id_table) === usedIdTable);
                if (regra) {
                    if (!processoReal) processoReal = String(regra.PROCESSO || regra.processo || "").trim();
                    if (regra.CONTEXTO || regra.contexto) contextoReal = String(regra.CONTEXTO || regra.contexto).trim();
                }
            }

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
            } else if (aiResult.termo && processoReal !== "SEARCH_GOOGLE_PLACES" && (!processoReal || processoReal === "__APP_LIVRARIA__" || processoReal.includes("SEARCH"))) {
                processoReal = "__APP_LIVRARIA_SEARCH__"; contextoReal = "LIVRARIA";
            }

            if (contextoReal === "LIVRARIA") {
                finalReply = finalReply.replace(/^\d+[\.\)].*$/gm, "").replace(/^[\s\t]*[\-\*•].*$/gm, "").replace(/\n\s*\n/g, '\n').trim();
            }

            if (processoReal) {
                const termoExtraido = (aiResult.termo || bodyRaw).trim();

                if (processoReal === "ADMIN" || processoReal === "ADMIM" || processoReal === "__ADMIN_TEST__") {
                    const adminId = String(process.env.ADMIN_CHAT_ID || "").trim();
                    if (dbId !== adminId) {
                        finalReply = "⛔ *Acesso Negado:* Este comando é restrito ao Administrador.";
                    } else {
                        if (msgLower === "saldo" || msgLower === "/saldo") {
                            finalReply = await billing.getOpenAISaldo_v1({ spreadsheetId: cfg.spreadsheetId });
                        }
                    }
                } else {
                    try {
                        if (processoReal === "__APP_ENSAIO__") {
                            let mod = require("../services/appEnsaio");
                            if (typeof mod.appEnsaio === "function") {
                                finalReply = await mod.appEnsaio({ pushname: fullName });
                            } else if (typeof mod.getLatestEnsaio_v1 === "function") {
                                const out = await mod.getLatestEnsaio_v1({ spreadsheetId: cfg.spreadsheetId, sheetNameEnsaio: cfg.sheetNameEnsaio });
                                if (out && out.DATA) finalReply += `\n\nO próximo ensaio está marcado para *${out.DATA}* às *${out.HORARIO}*.`;
                            }
                        } else if (processoReal === "__AUSENCIAS__" || processoReal === "__APP_AUSENCIAS__") {
                            let mod = require("../services/appAusencias");
                            finalReply += "\n\n" + await mod.getMinhasAusencias_v1({ chatId: dbId, fullName });
                        } else if (processoReal === "__APP_AGENDA__" || processoReal === "__APP_AGENDA_FULL__") {
                            let mod = require("../services/appAgenda");
                            const isFull = (processoReal === "__APP_AGENDA_FULL__");
                            const payload = await mod.getAgendaDepartamentos_v1({ spreadsheetId: cfg.spreadsheetId, sheetNameAgenda: cfg.sheetNameAgenda, cacheSeconds: cfg.cacheAgendaSeconds, timeZone: "Europe/Lisbon", onlyCurrentMonth: !isFull });
                            const agendaText = mod.formatAgendaDepartamentosText_v1(payload, "Europe/Lisbon");
                            if (agendaText) finalReply += "\n\n" + agendaText;
                        } else if (processoReal === "SEARCH_GOOGLE_PLACES") {
                            if (process.env.GOOGLE_PLACES_KEY) {
                                await safeSend(client, senderId, `Vou procurar *${termoExtraido}* no Google Maps...`);
                                const placesMod = require("../services/googlePlaces");
                                const placesText = await placesMod.getNearbyPlacesFormated_v1({ apiKey: process.env.GOOGLE_PLACES_KEY, centralAddress: "Praceta Beato Inácio de Azevedo, 7, Braga", searchTerm: termoExtraido, maxResults: 4 });
                                finalReply = placesText || `Não encontrei *${termoExtraido}* perto da igreja.`;
                            }
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

            let textToSend = (greetingText && finalReply) ? `${greetingText}\n\n${finalReply}` : (greetingText || finalReply);
            if (textToSend && usedIdTable !== "Bloqueio_Duplicado") {
                const humanReply = buildHumanizedResponse(textToSend, firstName, getDayGreetingPt());
                const mensagens = humanReply.split("|||");
                for (const bolha of mensagens) {
                    if (bolha.trim()) {
                        await simulateTyping(client, senderId, 1000);
                        await client.sendMessage(senderId, bolha.trim());
                    }
                }
                if (!["ADMIN", "Bloqueio_Duplicado", "FALHA", "ERR"].includes(usedIdTable)) {
                    await billing.registrarGasto_v1({ spreadsheetId: cfg.spreadsheetId, chatId: dbId, mensagem: bodyRaw });
                }
            } else if (greetingText && usedIdTable === "Bloqueio_Duplicado") {
                await safeSend(client, senderId, greetingText);
            }

            // REGISTO DE FALLBACK (AUDITORIA NO GOOGLE SHEETS SE A IA NÃO SOUBER)
            if (usedIdTable === "ERR" || usedIdTable === "FALHA" || (!finalReply && !greetingText)) {
                await logFallback({ spreadsheetId: cfg.spreadsheetId, chatId: dbId, rawMsg: bodyRaw, normMsg: normalizeText(bodyRaw) });
            }

            // LOG DE SAÍDA E AUDITORIA COMPLETA
            console.log("---------------------------------------------------------");
            console.log(`[AUDITORIA] DATA: ${new Date().toLocaleString("pt-PT")}`);
            console.log(` > USUÁRIO: ${firstName} | STATUS: ${isColab ? "🟢 Colab" : "⚪ Público"}`);
            console.log(` > ID_TABLE: ${usedIdTable} | CONTEXTO: ${contextoReal} | PROCESSO: ${processoReal || 'Nenhum'}`);
            console.log("---------------------------------------------------------");

        } catch (e) { console.error("[CRITICAL]", e); }
    });
}

function registerOnMessage_v4(client, cfg) { return registerOnMessage_v5(client, cfg); }
module.exports = { registerOnMessage_v4, registerOnMessage_v5 };