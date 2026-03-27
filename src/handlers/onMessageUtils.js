//###################################################################################
// src/handlers/onMessageUtils.js - UTILITÁRIOS DE MENSAGENS E SEGURANÇA
//###################################################################################
"use strict";

const spamMonitor = new Map();

/**
 * Simula o estado de "Digitando..." no WhatsApp para humanizar a interação.
 * @param {object} client - Instância do cliente WhatsApp.
 * @param {string} chatId - ID do chat destino.
 * @param {number} delayMs - Tempo de simulação em milissegundos.
 */
async function simulateTyping(client, chatId, delayMs = 1500) {
    try {
        const chat = await client.getChatById(chatId);
        if (chat && chat.sendStateTyping) {
            await chat.sendStateTyping();
        }
    } catch (e) {
        // Silencia erros se o estado de digitação falhar
    }
    
    await new Promise(resolve => setTimeout(resolve, delayMs));

    try {
        const chat = await client.getChatById(chatId);
        if (chat && chat.clearState) {
            await chat.clearState(); // Limpa o estado para não ficar "digitando" infinitamente
        }
    } catch (e) {}
}

/**
 * Envia uma mensagem de forma segura com captura de erro.
 */
async function safeSend(client, chatId, text) {
    try { 
        await client.sendMessage(chatId, text); 
        return true; 
    } catch (e) { 
        return false; 
    }
}

/**
 * Sistema Anti-Spam: Bloqueia utilizadores que enviam mais de 10 mensagens por minuto.
 * @param {string} chatId - ID do utilizador.
 * @returns {boolean} - True se for spam (bloqueado), False se for permitido.
 */
function isSpamming(chatId) {
    const now = Date.now();
    const user = spamMonitor.get(chatId);
    
    if (!user) {
        spamMonitor.set(chatId, { count: 1, startTime: now, blockedUntil: 0 });
        return false;
    }
    
    // Verifica se ainda está no período de bloqueio (5 minutos)
    if (now < user.blockedUntil) return true;
    
    // Reinicia o contador se passou mais de 1 minuto desde a primeira mensagem
    if (now - user.startTime > 60000) {
        user.count = 1;
        user.startTime = now;
        return false;
    }
    
    user.count++;
    
    // Se exceder 10 mensagens em 1 minuto, bloqueia por 5 minutos (300.000ms)
    if (user.count > 10) {
        user.blockedUntil = now + 300000;
        console.warn(`[ANTI-SPAM] Usuário bloqueado temporariamente: ${chatId}`);
        return true;
    }
    
    return false;
}

/**
 * Retorna a saudação apropriada baseada na hora local.
 */
function getDayGreetingPt() {
    const h = new Date().getHours();
    if (h >= 5 && h <= 11) return "bom dia";
    if (h >= 12 && h <= 17) return "boa tarde";
    return "boa noite";
}

module.exports = { simulateTyping, safeSend, isSpamming, getDayGreetingPt };