//###################################################################################
// src/services/memoryManager.js - GESTOR DE MEMÓRIA E HISTÓRICO (OTIMIZADO)
//###################################################################################
"use strict";

const audit = require("./audit");

// Armazenamento em memória (Poderia ser expandido para Redis no futuro)
const historyStore = new Map();

// Configurações de limite para preservar RAM
const MAX_HISTORY_PER_USER = 10; 

/**
 * Guarda uma mensagem no histórico do utilizador com limite de tamanho
 */
function saveToHistory(chatId, role, content) {
    if (!chatId || !content) return;

    try {
        if (!historyStore.has(chatId)) {
            historyStore.set(chatId, []);
        }

        const history = historyStore.get(chatId);
        
        // Adiciona a nova interação
        history.push({
            role, // 'user' ou 'assistant'
            content: String(content).substring(0, 1000), // Limite de caracteres por msg
            timestamp: Date.now()
        });

        // Mantém apenas as últimas X mensagens (Melhor Prática: Previne Memory Leak)
        if (history.length > MAX_HISTORY_PER_USER) {
            history.shift();
        }

    } catch (error) {
        audit.error("MEMORY_MANAGER_SAVE", error.message, { chatId });
    }
}

/**
 * Recupera o histórico formatado para a OpenAI/IA
 */
function getHistory(chatId) {
    return historyStore.get(chatId) || [];
}

/**
 * Limpa o histórico de um utilizador específico (útil após conclusão de fluxos)
 */
function clearHistory(chatId) {
    historyStore.delete(chatId);
    audit.info("MEMORY_MANAGER", `Histórico limpo para ${chatId}`);
}

module.exports = {
    saveToHistory,
    getHistory,
    clearHistory
};