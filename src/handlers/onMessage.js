//###################################################################################
// src/handlers/onMessage.js - VERSÃO CLEAN CODE + TYPING SIMULATOR + BLINDAGEM IA
//###################################################################################
"use strict";

const { getRules, buildHumanizedResponse } = require("../services/responsesStore");
const { getAccessByChatId } = require("../services/bpLookup");
const { logAudit } = require("../services/auditLogger");
const { handleIntent } = require("./intentManager");
const { isSpamming, getDayGreetingPt } = require("./onMessageUtils");
const { getHistory, saveToHistory } = require("../services/memoryManager");

// ============================================================================
// FUNÇÕES AUXILIARES
// ============================================================================

function getFirstName(fullName) {
    return String(fullName || "").trim().split(/\s+/g)[0] || "Visitante";
}

async function executeProcess(aiData, bodyRaw, cfg, isColab, dbId, fullName) {
    let rawText = "";
    let origem = "AI_GENERICA";

    // 1. PESQUISA GERAL DE LIVRARIA (Título, Misto, ou invenções da IA)
    if (
        aiData?.processo === "LIVRARIA" || 
        (aiData?.processo?.includes("LIVRARIA") && !aiData?.processo?.includes("AUTORES") && !aiData?.processo?.includes("EDITORAS") && !aiData?.processo?.includes("PESQUISA_"))
    ) {
        try {
            const libService = require("../services/appLivraria");
            const targetSheet = (cfg.sheetNameLivraria || process.env.SHEET_NAME_LIVRARIA || "DB_STOCK").trim();
            const livrariaSpreadsheetId = process.env.SPREADSHEET_LIVRARIA_ID || cfg.spreadsheetLivrariaId;

            if (!livrariaSpreadsheetId) throw new Error("SPREADSHEET_LIVRARIA_ID não configurado no .env");

            // CORREÇÃO DO BUG DO CATÁLOGO VAZIO:
            // Se aiData.termo existir (mesmo que seja ""), usa-o. Só usa o bodyRaw se for null/undefined.
            const termoFinal = (aiData.termo !== undefined && aiData.termo !== null) ? aiData.termo : bodyRaw;

            rawText = await libService.getLivrosEmStock_v1({
                spreadsheetId: livrariaSpreadsheetId,
                sheetName: targetSheet,
                searchTerm: termoFinal
            });
            origem = "DB_LIVRARIA";
        } catch (e) {
            logAudit({ type: "ERRO", error: `Proc Livraria: ${e.message}`, isColab });
        }
    } 
    // 2. LISTAGEM DE AUTORES OU EDITORAS
    else if (aiData?.processo === "__APP_LIVRARIA_AUTORES__" || aiData?.processo === "__APP_LIVRARIA_EDITORAS__") {
        try {
            const libService = require("../services/appLivraria");
            const targetSheet = (cfg.sheetNameLivraria || process.env.SHEET_NAME_LIVRARIA || "DB_STOCK").trim();
            const livrariaSpreadsheetId = process.env.SPREADSHEET_LIVRARIA_ID || cfg.spreadsheetLivrariaId;

            if (!livrariaSpreadsheetId) throw new Error("SPREADSHEET_LIVRARIA_ID não configurado no .env");

            const tipoLista = aiData.processo === "__APP_LIVRARIA_AUTORES__" ? "AUTORES" : "EDITORAS";

            rawText = await libService.getListasLivraria_v1({
                spreadsheetId: livrariaSpreadsheetId,
                sheetName: targetSheet,
                tipo: tipoLista
            });
            origem = `DB_LIVRARIA_${tipoLista}`;
        } catch (e) {
            logAudit({ type: "ERRO", error: `Proc Livraria Listas: ${e.message}`, isColab });
        }
    }
    // 3. PESQUISA EXCLUSIVA POR AUTOR OU EDITORA
    else if (aiData?.processo === "__APP_LIVRARIA_PESQUISA_AUTOR__" || aiData?.processo === "__APP_LIVRARIA_PESQUISA_EDITORA__") {
        try {
            const libService = require("../services/appLivraria");
            const targetSheet = (cfg.sheetNameLivraria || process.env.SHEET_NAME_LIVRARIA || "DB_STOCK").trim();
            const livrariaSpreadsheetId = process.env.SPREADSHEET_LIVRARIA_ID || cfg.spreadsheetLivrariaId;

            if (!livrariaSpreadsheetId) throw new Error("SPREADSHEET_LIVRARIA_ID não configurado no .env");

            const tipoFiltro = aiData.processo === "__APP_LIVRARIA_PESQUISA_AUTOR__" ? "AUTOR" : "EDITORA";
            const termoFinalExclusivo = (aiData.termo !== undefined && aiData.termo !== null) ? aiData.termo : bodyRaw;

            rawText = await libService.getLivrosExclusivos_v1({
                spreadsheetId: livrariaSpreadsheetId,
                sheetName: targetSheet,
                tipoFiltro: tipoFiltro,
                termoPesquisa: termoFinalExclusivo
            });
            origem = `DB_LIVRARIA_EXCLUSIVO_${tipoFiltro}`;
        } catch (e) {
            logAudit({ type: "ERRO", error: `Proc Livraria Exclusiva: ${e.message}`, isColab });
        }
    }
    // 4. AUSÊNCIAS / FÉRIAS
    else if (aiData?.processo === "__AUSENCIAS__") {
        try {
            const ausenciasService = require("../services/appAusencias");
            rawText = await ausenciasService.getMinhasAusencias_v1({ 
                chatId: dbId, 
                fullName: fullName 
            });
            origem = "DB_AUSENCIAS";
        } catch (e) {
            logAudit({ type: "ERRO", error: `Proc Ausências: ${e.message}`, isColab });
            rawText = "Desculpa, ocorreu um erro ao consultar as tuas ausências na base de dados.";
        }
    }
    
    return { rawText, origem };
}

function buildFinalReply(rawText, firstName, origem, aiData) {
    let reply = rawText
        .replace(/\{nome\}/gi, firstName)
        .replace(/\{saudacao_tempo\}/gi, getDayGreetingPt());

    reply = buildHumanizedResponse(reply, firstName, getDayGreetingPt());
    
    const isGreeting = origem.includes("ID_1") || origem.includes("GREET") || aiData.contexto?.toUpperCase().includes("SAUDACAO") || aiData.id_table == "1";
    
    if (isGreeting && !reply.includes(firstName)) {
        const textoLimpo = reply.replace(/^(Olá|Oi|Ola|Oi!|Olá!)\s*,?\s*/i, "");
        reply = `Olá ${firstName}! ${textoLimpo}`;
    }

    return reply;
}

// ============================================================================
// ORQUESTRADOR PRINCIPAL
// ============================================================================

function registerOnMessage_v5(client, cfg) {
    client.on("message", async (message) => {
        const startTime = Date.now();
        if (message.fromMe || message.isStatus) return;

        const contact = await message.getContact();
        const senderId = contact.id._serialized;
        const dbId = senderId.includes("@lid") ? `${contact.number}@c.us` : senderId;
        const bodyRaw = (message.body || "").trim();

        if (!bodyRaw || isSpamming(dbId)) return;

        try {
            const accData = await getAccessByChatId({ 
                spreadsheetId: cfg.spreadsheetId, 
                sheetNameBp: cfg.sheetNameBp, 
                chatId: dbId 
            });

            const isColab = !!accData?.isColab;
            const fullName = accData?.fullName;
            const firstName = getFirstName(fullName);
            const allRules = await getRules(cfg.spreadsheetId, cfg.sheetNameResp, cfg.cacheSeconds);
            const history = getHistory(dbId); 
            
            logAudit({ type: "TRACE_RX", chatId: dbId, msg: bodyRaw, isColab });

            const intent = await handleIntent(client, senderId, dbId, bodyRaw, cfg, { 
                firstName, allRules, isColab, history, agendaIA: "" 
            });

            if (intent && intent.type === "AI") {
                const aiData = intent.result;
                let rawText = "";
                let origem = "AI_GENERICA";

                // --- FASE 1: Resposta Fluida da IA ---
                if (aiData?.resposta && aiData.resposta !== "OK" && aiData.resposta.length > 2) {
                    rawText = aiData.resposta;
                    origem = "AI_CHAT";
                }

                // --- FASE 2: Processos Dinâmicos (Livraria, Listas, Ausências) ---
                if (aiData?.processo && aiData.processo !== "FAQ" && aiData.processo !== "NENHUM") {
                    const procResult = await executeProcess(aiData, bodyRaw, cfg, isColab, dbId, fullName); 
                    
                    if (procResult.rawText) {
                        if (rawText && rawText !== "OK") {
                            rawText = `${rawText}\n\n${procResult.rawText}`;
                        } else {
                            rawText = procResult.rawText;
                        }
                        origem = procResult.origem;
                    }
                }

                // --- FASE 3: Fallback da Planilha Estática ---
                if (!rawText && aiData?.id_table) {
                    let rule;
                    if (aiData.id_table == "1" || aiData.contexto === "SAUDACAO") {
                        const key = isColab ? "GREET_COLAB" : "GREET_PUBLIC";
                        rule = allRules.find(r => (r.CHAVE || r.chave) === key);
                    }
                    if (!rule) {
                        rule = allRules.find(r => String(r.ID_TABLE || r.id_table) === String(aiData.id_table));
                    }

                    if (rule) {
                        rawText = rule.RESPOSTA || rule.reply || "";
                        origem = `SHEET_RULE_${rule.CHAVE || aiData.id_table}`;
                    }
                }

                // 👇 FASE 3.5: REDE DE SEGURANÇA (Prevenção de bot mudo) 👇
                if (!rawText || rawText.trim() === "OK") {
                    rawText = "Desculpa, não entendi bem. Podes tentar perguntar de outra forma?";
                    origem = "FALLBACK_SEGURANCA";
                }

                // --- FASE 4: Finalização e Envio ---
                if (rawText) {
                    const finalReply = buildFinalReply(rawText, firstName, origem, aiData);

                    // --- SIMULADOR DE DIGITAÇÃO HUMANA ---
                    const chat = await message.getChat();
                    await chat.sendStateTyping(); 

                    let delayMs = 6000; 
                    if (finalReply.length > 60) {
                        delayMs = Math.floor(Math.random() * (20000 - 15000 + 1)) + 15000;
                    }

                    await new Promise(resolve => setTimeout(resolve, delayMs));
                    // -------------------------------------

                    await client.sendMessage(senderId, finalReply);
                    
                    saveToHistory(dbId, "user", bodyRaw);
                    saveToHistory(dbId, "assistant", finalReply);
                    
                    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
                    logAudit({ 
                        type: "AUDITORIA", 
                        chatId: firstName, 
                        isColab,
                        msg: bodyRaw, 
                        response: finalReply,
                        idTable: aiData?.id_table, 
                        context: aiData?.contexto, 
                        origem: origem,
                        process: `${aiData?.processo || 'IA'} (${duration}s)` 
                    });
                }
            }
        } catch (e) { 
            logAudit({ type: "ERRO_SISTEMA", chatId: dbId, error: e.message });
        }
    });
}

module.exports = { registerOnMessage_v5 };