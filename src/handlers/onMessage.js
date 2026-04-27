//###################################################################################
// src/handlers/onMessage.js - BUSCA DINÂMICA VIA PROCESSO + CADEADO DE DEPARTAMENTOS
//###################################################################################
"use strict";

const audit = require("../services/audit");
const lockManager = require("../services/lockManager");
const humanizer = require("../utils/humanizer");
const { getRules, buildHumanizedResponse } = require("../services/responsesStore");
const { getAccessByChatId } = require("../services/bpLookup");
const { handleIntent } = require("./intentManager");
const { isSpamming, getDayGreetingPt } = require("./onMessageUtils");
const { getHistory, saveToHistory } = require("../services/memoryManager");
const { executeProcess } = require("./processDispatcher");
const { checkDepartmentAccess } = require("../utils/permissions");
const { handlePendingEscalaFlow_v1 } = require("../services/managerScaleFlow");

//###################################################################################
// Helpers de Formatação e Lógica de Negócio
//###################################################################################

function getFirstName(fullName) {
    return String(fullName || "").trim().split(/\s+/g)[0] || "Visitante";
}

function buildFinalReply(rawText, firstName, origem, aiData) {
    let reply = String(rawText || "")
        .replace(/\{nome\}/gi, firstName)
        .replace(/\{saudacao_tempo\}/gi, getDayGreetingPt());

    reply = buildHumanizedResponse(reply, firstName, getDayGreetingPt());

    const aiContext = String(aiData?.contexto || "").toUpperCase();
    const isGreeting =
        String(origem || "").includes("ID_1") ||
        String(origem || "").includes("GREET") ||
        aiContext.includes("SAUDACAO") ||
        String(aiData?.id_table || "") === "1";

    if (isGreeting && !reply.includes(firstName)) {
        const textoLimpo = reply.replace(/^(Olá|Oi|Ola|Oi!|Olá!)\s*,?\s*/i, "");
        reply = `Olá ${firstName}! ${textoLimpo}`;
    }

    return reply;
}

function hasDepartmentRestriction(rule) {
    const dept = String(rule?.DEPARTAMENTO || "").trim().toUpperCase();
    return !!dept && !["TODOS", "PUBLIC", "NENHUM"].includes(dept);
}

function getRuleContextText(rule) {
    return rule?.DEPARTAMENTO && String(rule.DEPARTAMENTO).trim() !== ""
        ? String(rule.DEPARTAMENTO).trim()
        : "[Sem Restrição]";
}

function getRuleIdText(rule, aiData) {
    return String(rule?.ID_TABLE || aiData?.id_table || "N/A");
}

function pickGreetingRule(allRules, isColab) {
    const key = isColab ? "GREET_COLAB" : "GREET_PUBLIC";
    return allRules.find(
        (r) => String(r.CHAVE || r.chave || "").trim().toUpperCase() === key
    ) || null;
}

function getCandidateRulesByProcess(allRules, procIA) {
    if (!procIA || procIA === "FAQ" || procIA === "NENHUM") return [];
    return allRules.filter(
        (r) => String(r.PROCESSO || "").trim().toUpperCase() === procIA
    );
}

function getCandidateRulesById(allRules, aiData) {
    if (!aiData?.id_table) return [];
    return allRules.filter(
        (r) => String(r.ID_TABLE || r.id_table || "").trim() === String(aiData.id_table)
    );
}

function resolveRuleByDepartment(candidateRules, deptsAtribuidos) {
    if (!candidateRules || candidateRules.length === 0) {
        return { matchedRule: null, isBlocked: false, blockingDept: "" };
    }

    const restrictedAllowed = [];
    const unrestricted = [];
    const restrictedBlocked = [];

    for (const rule of candidateRules) {
        if (!hasDepartmentRestriction(rule)) {
            unrestricted.push(rule);
            continue;
        }

        const perm = checkDepartmentAccess(deptsAtribuidos, rule.DEPARTAMENTO);
        if (perm.hasAccess) {
            restrictedAllowed.push(rule);
        } else {
            restrictedBlocked.push({
                rule,
                missingDept: perm.missingDept || rule.DEPARTAMENTO,
            });
        }
    }

    if (restrictedAllowed.length > 0) return { matchedRule: restrictedAllowed[0], isBlocked: false, blockingDept: "" };
    if (unrestricted.length > 0) return { matchedRule: unrestricted[0], isBlocked: false, blockingDept: "" };
    
    if (restrictedBlocked.length > 0) {
        return { matchedRule: restrictedBlocked[0].rule, isBlocked: true, blockingDept: restrictedBlocked[0].missingDept };
    }

    return { matchedRule: candidateRules[0], isBlocked: false, blockingDept: "" };
}

//###################################################################################
// Core Send & Audit (Humanização e Registo)
//###################################################################################

async function sendAndAuditReply({
    client,
    message,
    senderId,
    dbId,
    firstName,
    bodyRaw,
    rawText,
    origem,
    aiData,
    matchedRule,
    isColab,
    deptsAtribuidos,
    isManager,
    managerDepts,
    startTime,
    processLabel,
}) {
    const finalReply = buildFinalReply(rawText, firstName, origem, aiData || {});
    const chat = await message.getChat();

    // HUMANIZAÇÃO: Simular estado de digitação proporcional
    await chat.sendStateTyping();
    const typingTime = Math.min(Math.max(finalReply.length * 45, 2000), 7000);
    await new Promise((resolve) => setTimeout(resolve, typingTime));

    await client.sendMessage(senderId, finalReply);

    // Persistência em memória
    saveToHistory(dbId, "user", bodyRaw);
    saveToHistory(dbId, "assistant", finalReply);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    // AUDITORIA PROFISSIONAL
    audit.info("REPLY", `Resposta enviada para ${firstName}`, {
        chatId: dbId,
        origem,
        duration: `${duration}s`,
        process: processLabel,
        idTable: getRuleIdText(matchedRule, aiData)
    });
}

//###################################################################################
// Main Handler
//###################################################################################

function registerOnMessage_v5(client, cfg) {
    client.on("message", async (message) => {
        const startTime = Date.now();
        if (message.fromMe || message.isStatus) return;

        const contact = await message.getContact();
        const senderId = contact.id._serialized;
        const dbId = senderId.includes("@lid") ? `${contact.number}@c.us` : senderId;
        const bodyRaw = String(message.body || "").trim();

        if (!bodyRaw || isSpamming(dbId)) return;

        // LOCK SYSTEM: Evita execuções duplicadas para o mesmo utilizador
        const userLockKey = `msg_${dbId}`;
        if (!lockManager.acquire(userLockKey)) return;

        try {
            // HUMANIZAÇÃO: Confirmação visual de leitura
            const chat = await message.getChat();
            await chat.sendSeen();

            // Obter permissões e dados do utilizador
            const accData = await getAccessByChatId({
                spreadsheetId: cfg.spreadsheetId,
                sheetNameBp: cfg.sheetNameBp,
                chatId: dbId,
                cacheSeconds: 300, // Melhor prática: Cache ativado para evitar carga na Google API
            });

            const isColab = !!accData?.isColab;
            const fullName = accData?.fullName || "";
            const firstName = getFirstName(fullName);
            const deptsAtribuidos = accData?.deptsDetalhado || [];
            const isManager = !!accData?.isManager;
            const managerDepts = accData?.managerDepts || [];

            audit.info("TRACE", `Processando: "${bodyRaw.substring(0, 20)}..." de ${firstName}`, { dbId });

            const allRules = await getRules(cfg.spreadsheetId, cfg.sheetNameResp, 300);

            // 1. Intercetar fluxos pendentes (Prioridade de Estado)
            const pendingFlow = await handlePendingEscalaFlow_v1({
                chatId: dbId,
                bodyRaw,
                accData,
                cfg,
            });

            if (pendingFlow?.handled) {
                let matchedRuleOverride = null;
                if (pendingFlow.matchedRuleOverride) {
                    matchedRuleOverride = allRules.find(r => 
                        String(r.PROCESSO || "").toUpperCase() === String(pendingFlow.matchedRuleOverride).toUpperCase()
                    ) || null;
                }

                await sendAndAuditReply({
                    client, message, senderId, dbId, firstName, bodyRaw,
                    rawText: pendingFlow.rawText || "Não consegui concluir a operação.",
                    origem: pendingFlow.origem || "FLOW_PENDING",
                    aiData: { processo: pendingFlow.processTag || "FLOW", contexto: "FLOW" },
                    matchedRule: matchedRuleOverride,
                    isColab, deptsAtribuidos, isManager, managerDepts, startTime,
                    processLabel: pendingFlow.processTag || "FLOW"
                });
                return;
            }

            // 2. Inteligência Artificial / Intenção
            const history = getHistory(dbId);
            const intent = await handleIntent(client, senderId, dbId, bodyRaw, cfg, {
                firstName, allRules, isColab, history
            });

            if (!intent || intent.type !== "AI") return;

            const aiData = intent.result || {};
            const procIA = String(aiData?.processo || "").trim().toUpperCase();

            let rawText = "";
            let origem = "AI_GENERICA";
            let isBlocked = false;
            let blockingDept = "";
            let matchedRule = null;

            // 3. Seleção de Regra e Permissões
            if (procIA && procIA !== "FAQ" && procIA !== "NENHUM") {
                const processRules = getCandidateRulesByProcess(allRules, procIA);
                const resolved = resolveRuleByDepartment(processRules, deptsAtribuidos);
                matchedRule = resolved.matchedRule;
                isBlocked = resolved.isBlocked;
                blockingDept = resolved.blockingDept || "";
            } else if (String(aiData?.id_table || "") === "1" || String(aiData?.contexto || "") === "SAUDACAO") {
                matchedRule = pickGreetingRule(allRules, isColab);
            } else {
                const idRules = getCandidateRulesById(allRules, aiData);
                const resolved = resolveRuleByDepartment(idRules, deptsAtribuidos);
                matchedRule = resolved.matchedRule;
                isBlocked = resolved.isBlocked;
                blockingDept = resolved.blockingDept || "";
            }

            // 4. Tratamento de Bloqueio
            if (isBlocked) {
                rawText = `🔒 *Acesso Restrito*\n\nDesculpa ${firstName}, mas esta informação é exclusiva para o departamento: *${blockingDept}*.`;
                origem = "BLOQUEIO_DEPARTAMENTO";
            } else {
                // 5. Execução de Processos de Negócio
                if (aiData?.resposta && aiData.resposta !== "OK" && String(aiData.resposta).length > 2) {
                    rawText = aiData.resposta;
                    origem = "AI_CHAT";
                }

                if (procIA && procIA !== "FAQ" && procIA !== "NENHUM") {
                    const procResult = await executeProcess(aiData, bodyRaw, cfg, isColab, dbId, fullName, accData);
                    if (procResult?.rawText) {
                        rawText = (rawText && rawText !== "OK") ? `${rawText}\n\n${procResult.rawText}` : procResult.rawText;
                        origem = procResult.origem || origem;
                    }
                }

                if (!rawText && matchedRule) {
                    rawText = matchedRule.RESPOSTA || "";
                    origem = `SHEET_RULE_${matchedRule.CHAVE || matchedRule.ID_TABLE}`;
                }
            }

            // Fallback de segurança
            if (!rawText || String(rawText).trim() === "OK") {
                rawText = "Não consegui encontrar essa informação. Podes reformular a pergunta?";
                origem = "FALLBACK_SAFETY";
            }

            // 6. Envio Final
            await sendAndAuditReply({
                client, message, senderId, dbId, firstName, bodyRaw, rawText,
                origem, aiData, matchedRule, isColab, deptsAtribuidos, 
                isManager, managerDepts, startTime, processLabel: procIA || "IA"
            });

        } catch (e) {
            audit.error("ON_MESSAGE_FATAL", e.message, { dbId, stack: e.stack });
        } finally {
            // Libertar Lock independentemente do resultado
            lockManager.release(userLockKey);
        }
    });
}

module.exports = { registerOnMessage_v5 };