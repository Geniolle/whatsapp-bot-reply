//###################################################################################
// src/handlers/onMessage.js - BUSCA DINÂMICA VIA PROCESSO + CADEADO DE DEPARTAMENTOS
//###################################################################################
"use strict";

const { getRules, buildHumanizedResponse } = require("../services/responsesStore");
const { getAccessByChatId } = require("../services/bpLookup");
const { logAudit } = require("../services/auditLogger");
const { handleIntent } = require("./intentManager");
const { isSpamming, getDayGreetingPt } = require("./onMessageUtils");
const { getHistory, saveToHistory } = require("../services/memoryManager");

const { executeProcess } = require("./processDispatcher");
const { checkDepartmentAccess } = require("../utils/permissions"); 

function getFirstName(fullName) {
    return String(fullName || "").trim().split(/\s+/g)[0] || "Visitante";
}

function buildFinalReply(rawText, firstName, origem, aiData) {
    let reply = rawText.replace(/\{nome\}/gi, firstName).replace(/\{saudacao_tempo\}/gi, getDayGreetingPt());
    reply = buildHumanizedResponse(reply, firstName, getDayGreetingPt());
    
    const isGreeting = origem.includes("ID_1") || origem.includes("GREET") || aiData?.contexto?.toUpperCase().includes("SAUDACAO") || aiData?.id_table == "1";
    if (isGreeting && !reply.includes(firstName)) {
        const textoLimpo = reply.replace(/^(Olá|Oi|Ola|Oi!|Olá!)\s*,?\s*/i, "");
        reply = `Olá ${firstName}! ${textoLimpo}`;
    }
    return reply;
}

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
                chatId: dbId,
                cacheSeconds: 0 
            });

            const isColab = !!accData?.isColab;
            const fullName = accData?.fullName;
            const firstName = getFirstName(fullName);
            const deptsAtribuidos = accData?.deptsDetalhado || []; 

            // Força a leitura imediata das regras (sem cache temporário)
            const allRules = await getRules(cfg.spreadsheetId, cfg.sheetNameResp, 0);
            const history = getHistory(dbId); 
            
            logAudit({ type: "TRACE_RX", chatId: dbId, msg: bodyRaw, isColab });

            const intent = await handleIntent(client, senderId, dbId, bodyRaw, cfg, { 
                firstName, allRules, isColab, history, agendaIA: "" 
            });

            if (intent && intent.type === "AI") {
                const aiData = intent.result;
                let rawText = "";
                let origem = "AI_GENERICA";
                let isBlocked = false;
                let matchedRule = null;

                const procIA = String(aiData?.processo || "").trim().toUpperCase();

                // >>> BUSCA DA REGRA <<<
                if (aiData?.id_table == "1" || aiData?.contexto === "SAUDACAO") {
                    const key = isColab ? "GREET_COLAB" : "GREET_PUBLIC";
                    matchedRule = allRules.find(r => String(r.CHAVE || r.chave).toUpperCase() === key);
                } 
                // A BUSCA DINÂMICA: Procura a linha cujo PROCESSO corresponde ao detetado pela IA
                else if (procIA && procIA !== "FAQ" && procIA !== "NENHUM") {
                    matchedRule = allRules.find(r => String(r.PROCESSO).toUpperCase() === procIA);
                } 
                else if (aiData?.id_table) {
                    matchedRule = allRules.find(r => String(r.ID_TABLE || r.id_table) === String(aiData.id_table));
                }

                // >>> CADEADO DE ACESSO (DEPARTAMENTOS) <<<
                if (matchedRule && matchedRule.DEPARTAMENTO) {
                    const perm = checkDepartmentAccess(deptsAtribuidos, matchedRule.DEPARTAMENTO);
                    if (!perm.hasAccess) {
                        rawText = `🔒 *Acesso Restrito*\n\nDesculpa, mas não tens permissão para ver isto. Esta informação é exclusiva para o departamento: *${perm.missingDept}*.`;
                        origem = "BLOQUEIO_DEPARTAMENTO";
                        isBlocked = true; 
                    }
                }

                if (!isBlocked) {
                    if (aiData?.resposta && aiData.resposta !== "OK" && aiData.resposta.length > 2) {
                        rawText = aiData.resposta;
                        origem = "AI_CHAT";
                    }

                    if (procIA && procIA !== "FAQ" && procIA !== "NENHUM") {
                        const procResult = await executeProcess(aiData, bodyRaw, cfg, isColab, dbId, fullName); 
                        if (procResult.rawText) {
                            rawText = (rawText && rawText !== "OK") ? `${rawText}\n\n${procResult.rawText}` : procResult.rawText;
                            origem = procResult.origem;
                        }
                    }

                    if (!rawText && matchedRule) {
                        rawText = matchedRule.RESPOSTA || "";
                        origem = `SHEET_RULE_${matchedRule.CHAVE || matchedRule.ID_TABLE}`;
                    }
                }

                if (!rawText || rawText.trim() === "OK") {
                    rawText = "Desculpa, não entendi bem. Podes tentar perguntar de outra forma?";
                    origem = "FALLBACK_SEGURANCA";
                }

                if (rawText) {
                    const finalReply = buildFinalReply(rawText, firstName, origem, aiData);

                    const chat = await message.getChat();
                    await chat.sendStateTyping(); 
                    let delayMs = finalReply.length > 60 ? Math.floor(Math.random() * 5000) + 15000 : 6000;
                    await new Promise(resolve => setTimeout(resolve, delayMs));

                    await client.sendMessage(senderId, finalReply);
                    
                    saveToHistory(dbId, "user", bodyRaw);
                    saveToHistory(dbId, "assistant", finalReply);
                    
                    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
                    
                    // >>> LOGGER EXATO <<<
                    const logIdTable = matchedRule?.ID_TABLE || aiData?.id_table || "N/A";
                    let logContexto = "[Sem Restrição]";
                    if (matchedRule && matchedRule.DEPARTAMENTO && String(matchedRule.DEPARTAMENTO).trim() !== "") {
                        logContexto = String(matchedRule.DEPARTAMENTO).trim();
                    }

                    logAudit({ 
                        type: "AUDITORIA", 
                        chatId: firstName, 
                        isColab,
                        depts: deptsAtribuidos,
                        msg: bodyRaw, 
                        response: finalReply,
                        idTable: logIdTable, 
                        context: logContexto, 
                        origem: origem,
                        process: `${procIA || 'IA'} (${duration}s)` 
                    });
                }
            }
        } catch (e) { 
            logAudit({ type: "ERRO_SISTEMA", chatId: dbId, error: e.message });
        }
    });
}

module.exports = { registerOnMessage_v5 };