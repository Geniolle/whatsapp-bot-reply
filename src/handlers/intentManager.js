//###################################################################################
// src/handlers/intentManager.js - VERSÃO COM DETEÇÃO INTELIGENTE DE AGENDAMENTOS
//###################################################################################
"use strict";

const { handleSchedulingFlow } = require("./schedulingFlow");
const { analisarComIA } = require("../services/aiAssistant");
const { normalizeText } = require("../services/router");

async function handleIntent(client, senderId, dbId, bodyRaw, cfg, userContext) {
    const textNorm = normalizeText(bodyRaw);

    // 1. PRIORIDADE MÁXIMA: Fluxo de Agendamento
    // Usamos Expressões Regulares (Regex) para detetar qualquer variação (confirma, confirmo, confirmar 34, etc.)
    const isSchedulingKeywords = /^(confirmar|confirma|confirmo|aceitar|aceito|recusar|recuso|sim|nao|ok)(\s+\d+)?$/i.test(textNorm);
    const isNumericId = /^\d+$/.test(textNorm);

    if (isSchedulingKeywords || isNumericId) {
        const handled = await handleSchedulingFlow(client, senderId, dbId, bodyRaw, cfg);
        if (handled) return { type: "SCHEDULING" };
    }

    // 2. PRIORIDADE: Inteligência Artificial com Contexto
    const aiResult = await analisarComIA(
        bodyRaw, 
        userContext.firstName, 
        userContext.history || [], 
        userContext.allRules, 
        userContext.agendaIA || ""
    );
    
    return { 
        type: "AI", 
        result: aiResult 
    };
}

module.exports = { handleIntent };