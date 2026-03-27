//###################################################################################
// src/services/memoryManager.js - GESTÃO DE CONTEXTO (MEMÓRIA CURTO PRAZO)
//###################################################################################
"use strict";

const userMemory = new Map();
const MAX_HISTORY = 6; // Guarda as últimas 3 trocas (pergunta/resposta)

/**
 * Obtém o histórico formatado para a OpenAI
 */
function getHistory(chatId) {
    return userMemory.get(chatId) || [];
}

/**
 * Salva uma nova interação no histórico
 */
function saveToHistory(chatId, role, content) {
    let history = userMemory.get(chatId) || [];
    history.push({ role, content });

    // Mantém apenas o limite definido para não gastar tokens desnecessários
    if (history.length > MAX_HISTORY) {
        history.shift();
    }
    userMemory.set(chatId, history);
}

module.exports = { getHistory, saveToHistory };