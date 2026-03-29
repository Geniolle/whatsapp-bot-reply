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
const { handlePendingEscalaFlow_v1 } = require("../services/managerScaleFlow");

//###################################################################################
// Helpers
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
        return {
            matchedRule: null,
            isBlocked: false,
            blockingDept: "",
        };
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

    if (restrictedAllowed.length > 0) {
        return {
            matchedRule: restrictedAllowed[0],
            isBlocked: false,
            blockingDept: "",
        };
    }

    if (unrestricted.length > 0) {
        return {
            matchedRule: unrestricted[0],
            isBlocked: false,
            blockingDept: "",
        };
    }

    if (restrictedBlocked.length > 0) {
        return {
            matchedRule: restrictedBlocked[0].rule,
            isBlocked: true,
            blockingDept: restrictedBlocked[0].missingDept,
        };
    }

    return {
        matchedRule: candidateRules[0],
        isBlocked: false,
        blockingDept: "",
    };
}

function logRuleSelection(bodyRaw, procIA, aiData, matchedRule, isBlocked, blockingDept) {
    const logIdTableSelecao = getRuleIdText(matchedRule, aiData);
    const logContextoSelecao = getRuleContextText(matchedRule);

    console.log(`\n---------------------------------------------------------`);
    console.log(`[RAIO-X] REGRA SELECIONADA`);
    console.log(` > PERGUNTA:  "${bodyRaw}"`);
    console.log(` > PROCESSO:  ${procIA || "NENHUM"}`);
    console.log(` > ORIGEM_IA: ${aiData?.contexto || "N/A"}`);
    console.log(` > ID:        ${logIdTableSelecao}`);
    console.log(` > CTX:       ${logContextoSelecao}`);
    console.log(
        ` > REGRA:     ${
            matchedRule
                ? (matchedRule.CHAVE || matchedRule.PROCESSO || matchedRule.ID_TABLE || "N/A")
                : "NENHUMA"
        }`
    );
    console.log(` > BLOQUEIO:  ${isBlocked ? "SIM" : "NÃO"}`);
    if (isBlocked && blockingDept) {
        console.log(` > RESTRIÇÃO: ${blockingDept}`);
    }
    console.log(`---------------------------------------------------------\n`);
}

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
    await chat.sendStateTyping();

    const delayMs = finalReply.length > 60
        ? Math.floor(Math.random() * 5000) + 15000
        : 6000;

    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await client.sendMessage(senderId, finalReply);

    saveToHistory(dbId, "user", bodyRaw);
    saveToHistory(dbId, "assistant", finalReply);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const logIdTable = getRuleIdText(matchedRule, aiData);
    const logContexto = getRuleContextText(matchedRule);

    logAudit({
        type: "AUDITORIA",
        chatId: firstName,
        isColab,
        depts: deptsAtribuidos,
        isManager,
        managerDepts,
        msg: bodyRaw,
        response: finalReply,
        idTable: logIdTable,
        context: logContexto,
        origem,
        process: `${processLabel || "IA"} (${duration}s)`,
    });
}

//###################################################################################
// Main
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

        try {
            const accData = await getAccessByChatId({
                spreadsheetId: cfg.spreadsheetId,
                sheetNameBp: cfg.sheetNameBp,
                chatId: dbId,
                cacheSeconds: 0,
            });

            const isColab = !!accData?.isColab;
            const fullName = accData?.fullName || "";
            const firstName = getFirstName(fullName);
            const deptsAtribuidos = accData?.deptsDetalhado || [];
            const isManager = !!accData?.isManager;
            const managerDepts = accData?.managerDepts || [];

            logAudit({
                type: "TRACE_RX",
                chatId: dbId,
                msg: bodyRaw,
                isColab,
                depts: deptsAtribuidos,
                isManager,
                managerDepts,
            });

            const allRules = await getRules(cfg.spreadsheetId, cfg.sheetNameResp, 0);

            //#########################################################################
            // 1. Interceta fluxos pendentes de escala manager
            //#########################################################################
            const pendingFlow = await handlePendingEscalaFlow_v1({
                chatId: dbId,
                bodyRaw,
                accData,
                cfg,
            });

            if (pendingFlow?.handled) {
                let matchedRule = null;

                if (pendingFlow.matchedRuleOverride) {
                    matchedRule = allRules.find(
                        (r) => String(r.PROCESSO || "").trim().toUpperCase() === String(pendingFlow.matchedRuleOverride).trim().toUpperCase()
                    ) || null;
                }

                await sendAndAuditReply({
                    client,
                    message,
                    senderId,
                    dbId,
                    firstName,
                    bodyRaw,
                    rawText: pendingFlow.rawText || "Não consegui concluir a operação.",
                    origem: pendingFlow.origem || "FLOW_ESCALA_MANAGER",
                    aiData: { processo: pendingFlow.processTag || "__ESCALAS__", contexto: "FLOW" },
                    matchedRule,
                    isColab,
                    deptsAtribuidos,
                    isManager,
                    managerDepts,
                    startTime,
                    processLabel: pendingFlow.processTag || "__ESCALAS__",
                });
                return;
            }

            const history = getHistory(dbId);

            const intent = await handleIntent(client, senderId, dbId, bodyRaw, cfg, {
                firstName,
                allRules,
                isColab,
                history,
                agendaIA: "",
            });

            if (!intent || intent.type !== "AI") return;

            const aiData = intent.result || {};
            const procIA = String(aiData?.processo || "").trim().toUpperCase();

            let rawText = "";
            let origem = "AI_GENERICA";
            let isBlocked = false;
            let blockingDept = "";
            let matchedRule = null;

            //###################################################################################
            // Seleção da regra
            // PRIORIDADE MÁXIMA: PROCESSO
            //###################################################################################
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

            logRuleSelection(bodyRaw, procIA, aiData, matchedRule, isBlocked, blockingDept);

            //###################################################################################
            // Bloqueio de acesso
            //###################################################################################
            if (isBlocked) {
                rawText =
                    `🔒 *Acesso Restrito*\n\n` +
                    `Desculpa, mas não tens permissão para ver isto. ` +
                    `Esta informação é exclusiva para o departamento: *${blockingDept}*.`;
                origem = "BLOQUEIO_DEPARTAMENTO";
            }

            //###################################################################################
            // Execução do fluxo
            //###################################################################################
            if (!isBlocked) {
                if (aiData?.resposta && aiData.resposta !== "OK" && String(aiData.resposta).trim().length > 2) {
                    rawText = aiData.resposta;
                    origem = "AI_CHAT";
                }

                if (procIA && procIA !== "FAQ" && procIA !== "NENHUM") {
                    const procResult = await executeProcess(aiData, bodyRaw, cfg, isColab, dbId, fullName, accData);

                    if (procResult?.rawText) {
                        rawText = (rawText && rawText !== "OK")
                            ? `${rawText}\n\n${procResult.rawText}`
                            : procResult.rawText;
                        origem = procResult.origem || origem;
                    }
                }

                if (!rawText && matchedRule) {
                    rawText = matchedRule.RESPOSTA || "";
                    origem = `SHEET_RULE_${matchedRule.CHAVE || matchedRule.ID_TABLE}`;
                }
            }

            //###################################################################################
            // Fallback
            //###################################################################################
            if (!rawText || String(rawText).trim() === "OK") {
                rawText = "Desculpa, não entendi bem. Podes tentar perguntar de outra forma?";
                origem = "FALLBACK_SEGURANCA";
            }

            //###################################################################################
            // Envio
            //###################################################################################
            await sendAndAuditReply({
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
                processLabel: procIA || "IA",
            });
        } catch (e) {
            logAudit({
                type: "ERRO_SISTEMA",
                chatId: dbId,
                error: e.message,
            });
        }
    });
}

module.exports = { registerOnMessage_v5 };