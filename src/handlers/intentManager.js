//###################################################################################
// src/handlers/intentManager.js - AGORA COM SUPORTE A HISTÓRICO
//###################################################################################
"use strict";

const { handleSchedulingFlow } = require("./schedulingFlow");
const { analisarComIA } = require("../services/aiAssistant");
const { normalizeText } = require("../services/router");

async function handleIntent(client, senderId, dbId, bodyRaw, cfg, userContext) {
    const textNorm = normalizeText(bodyRaw);

    // 1. PRIORIDADE MÁXIMA: Fluxo de Agendamento
    const isSchedulingKeywords = ["confirmar", "recusar", "sim", "nao", "não", "ok"].includes(textNorm);
    const isNumericId = /^\d+$/.test(bodyRaw.trim());

    if (isSchedulingKeywords || isNumericId) {
        const handled = await handleSchedulingFlow(client, senderId, dbId, bodyRaw, cfg);
        if (handled) return { type: "SCHEDULING" };
    }

    // 2. PRIORIDADE: Inteligência Artificial com Contexto
    const aiResult = await analisarComIA(
        bodyRaw, 
        userContext.firstName, 
        userContext.history || [], // <-- Histórico real passado aqui
        userContext.allRules, 
        userContext.agendaIA || ""
    );
    
    return { 
        type: "AI", 
        result: aiResult 
    };
}

module.exports = { handleIntent };