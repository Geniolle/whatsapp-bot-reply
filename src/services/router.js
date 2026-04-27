//###################################################################################
// src/services/router.js - GESTOR DE ROTEAMENTO E RESILIÊNCIA
//###################################################################################
"use strict";

const audit = require("./audit");
const { handleIntent } = require("../handlers/intentManager");
const { getRules } = require("./responsesStore");
const { getHistory } = require("./memoryManager");

/**
 * Processa a mensagem, identifica a intenção via IA e encaminha para o fluxo correto.
 * Implementa cache de regras e tratamento de exceções para estabilidade do Event Loop.
 */
async function processMessage(msg, cfg, client) {
    const contact = await msg.getContact();
    const senderId = contact.id._serialized;
    const dbId = senderId.includes("@lid") ? `${contact.number}@c.us` : senderId;
    const bodyRaw = String(msg.body || "").trim();

    try {
        audit.info("ROUTER", `Iniciando processamento para ${dbId}`);

        // 1. Obter Regras da Planilha com Cache de 300s (5 minutos)
        // Reduz drasticamente as chamadas HTTP à Google API
        const allRules = await getRules(cfg.spreadsheetId, cfg.sheetNameResp, 300);

        // 2. Recuperar Histórico para contexto
        const history = getHistory(dbId);

        // 3. Detetar Intenção via IA
        const intent = await handleIntent(client, senderId, dbId, bodyRaw, cfg, {
            firstName: contact.pushname || "Utilizador",
            allRules,
            isColab: false,
            history
        });

        if (!intent) {
            audit.warn("ROUTER", "IA não retornou uma intenção válida.");
            return { 
                type: "AI", 
                result: { resposta: "Peço desculpa, tive uma pequena falha técnica. Pode repetir?" }, 
                origem: "INTENT_NULL" 
            };
        }

        return intent;

    } catch (error) {
        audit.error("ROUTER_FATAL", `Erro crítico no roteamento: ${error.message}`, {
            dbId,
            stack: error.stack
        });

        return { 
            type: "AI", 
            result: { resposta: "Estou a processar muita informação de momento. Pode tentar de novo?" }, 
            origem: "ROUTER_ERROR_FALLBACK" 
        };
    }
}

module.exports = { processMessage };