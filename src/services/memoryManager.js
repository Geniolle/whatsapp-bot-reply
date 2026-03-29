//###################################################################################
// src/services/memoryManager.js - GESTÃO DE CONTEXTO + ESTADO DE FLUXOS
//###################################################################################
"use strict";

const userMemory = new Map();
const userDialogState = new Map();
const MAX_HISTORY = 6;

//###################################################################################
// Histórico curto
//###################################################################################
function getHistory(chatId) {
    return userMemory.get(chatId) || [];
}

function saveToHistory(chatId, role, content) {
    let history = userMemory.get(chatId) || [];
    history.push({ role, content });

    if (history.length > MAX_HISTORY) {
        history.shift();
    }
    userMemory.set(chatId, history);
}

//###################################################################################
// Estado de fluxos conversacionais
//###################################################################################
function getDialogState(chatId) {
    return userDialogState.get(chatId) || null;
}

function setDialogState(chatId, state) {
    userDialogState.set(chatId, {
        ...(state || {}),
        updatedAt: Date.now(),
    });
}

function clearDialogState(chatId) {
    userDialogState.delete(chatId);
}

module.exports = {
    getHistory,
    saveToHistory,
    getDialogState,
    setDialogState,
    clearDialogState,
};