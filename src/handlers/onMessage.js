//###################################################################################
// src/handlers/onMessage.js - VERSÃO CLEAN ARCHITECTURE COM BUSCA 100% DINÂMICA
//###################################################################################
"use strict";

const { getRules } = require("../services/responsesStore");
const { getAccessByChatId } = require("../services/bpLookup");
const { logAudit } = require("../services/auditLogger");
const { handleIntent } = require("./intentManager");
const { isSpamming } = require("./onMessageUtils");
const { getHistory, saveToHistory } = require("../services/memoryManager");

const { executeProcess } = require("./processDispatcher");
const { buildFinalReply, simulateTyping } = require("../utils/humanizer");
const { checkDepartmentAccess } = require("../utils/permissions");

function getFirstName(fullName) {
    return String(fullName || "").trim().split(/\s+/g)[0] || "Visitante";
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

            // Lê as regras da planilha (Garantir que usa a versão nova do responsesStore.js)
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
                
                // ====================================================================
                // >>> BUSCA DINÂMICA DA REGRA NA PLANILHA <<<
                // ====================================================================
                
                // 1. Prioridade para Saudação
                if (aiData?.id_table == "1" || aiData?.contexto === "SAUDACAO") {
                    const key = isColab ? "GREET_COLAB" : "GREET_PUBLIC";
                    matchedRule = allRules.find(r => String(r.CHAVE || r.chave).toUpperCase() === key);
                } 
                // 2. BUSCA PELO PROCESSO (A FORMA CORRETA E DINÂMICA)
                // Se a IA disse __APP_ENSAIO__, ele procura na coluna PROCESSO por __APP_ENSAIO__
                else if (procIA && procIA !== "FAQ" && procIA !== "NENHUM") {
                    matchedRule = allRules.find(r => String(r.PROCESSO || "").trim().toUpperCase() === procIA);
                } 
                // 3. Fallback: ID da IA (Usado apenas para respostas estáticas)
                else if (aiData?.id_table) {
                    matchedRule = allRules.find(r => String(r.ID_TABLE || r.id_table) === String(aiData.id_table));
                }

                // ====================================================================
                // >>> FASE 0: VALIDAÇÃO DE ACESSO (O CADEADO) <<<
                // ====================================================================
                if (matchedRule && matchedRule.DEPARTAMENTO) {
                    const perm = checkDepartmentAccess(deptsAtribuidos, matchedRule.DEPARTAMENTO);
                    
                    if (!perm.hasAccess) {
                        rawText = `🔒 *Acesso Restrito*\n\nDesculpa, mas não tens permissão para ver isto. Esta informação é exclusiva para o departamento: *${perm.missingDept}*.`;
                        origem = "BLOQUEIO_DEPARTAMENTO";
                        isBlocked = true; 
                    }
                }

                // ====================================================================
                // >>> FASE 1 e 2: EXECUÇÃO DO PROCESSO <<<
                // ====================================================================
                if (!isBlocked) {
                    if (aiData?.resposta && aiData.resposta !== "OK" && aiData.resposta.length > 2) {
                        rawText = aiData.resposta;
                        origem = "AI_CHAT";
                    }

                    // Se for um processo dinâmico (ex: __APP_ENSAIO__), executa a função de ir buscar os dados
                    if (procIA && procIA !== "FAQ" && procIA !== "NENHUM") {
                        const procResult = await executeProcess(aiData, bodyRaw, cfg, isColab, dbId, fullName); 
                        if (procResult.rawText) {
                            rawText = (rawText && rawText !== "OK") ? `${rawText}\n\n${procResult.rawText}` : procResult.rawText;
                            origem = procResult.origem;
                        }
                    }

                    // Se for apenas uma resposta estática da planilha
                    if (!rawText && matchedRule) {
                        rawText = matchedRule.RESPOSTA || matchedRule.reply || "";
                        origem = `SHEET_RULE_${matchedRule.CHAVE || matchedRule.ID_TABLE}`;
                    }
                }

                if (!rawText || rawText.trim() === "OK") {
                    rawText = "Desculpa, não entendi bem. Podes tentar perguntar de outra forma?";
                    origem = "FALLBACK_SEGURANCA";
                }

                // ====================================================================
                // >>> FASE FINAL: ENVIO E LOGGER <<<
                // ====================================================================
                if (rawText) {
                    const finalReply = buildFinalReply(rawText, firstName, origem, aiData);
                    const chat = await message.getChat();
                    await simulateTyping(chat, finalReply);
                    await client.sendMessage(senderId, finalReply);
                    
                    saveToHistory(dbId, "user", bodyRaw);
                    saveToHistory(dbId, "assistant", finalReply);
                    
                    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
                    
                    // Extrai o ID real encontrado na planilha (se não achar, avisa com N/A)
                    const logIdTable = matchedRule?.ID_TABLE || aiData?.id_table || "N/A";
                    
                    // Extrai o departamento real da planilha
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

function registerOnMessage_v4(client, cfg) { return registerOnMessage_v5(client, cfg); }
module.exports = { registerOnMessage_v4, registerOnMessage_v5 };