//###################################################################################
// src/utils/humanizer.js - CENTRAL DE HUMANIZAÇÃO E DELAY DE DIGITAÇÃO
//###################################################################################
"use strict";

// ============================================================================
// MOTOR DE HUMANIZAÇÃO INTERNO
// ============================================================================

/**
 * Descobre a hora automaticamente com o fuso horário de Portugal
 */
function getAutoTimeOfDay() {
    try {
        const parts = new Intl.DateTimeFormat("pt-PT", {
            timeZone: "Europe/Lisbon",
            hour: "2-digit",
            hour12: false,
        }).formatToParts(new Date());

        const hourStr = parts.find((p) => p.type === "hour")?.value || "12";
        const h = Number(hourStr);

        if (h >= 5 && h <= 11) return "bom dia";
        if (h >= 12 && h <= 17) return "boa tarde";
        return "boa noite";
    } catch (_) {
        const h = new Date().getHours();
        if (h >= 5 && h <= 11) return "bom dia";
        if (h >= 12 && h <= 17) return "boa tarde";
        return "boa noite";
    }
}

/**
 * Constrói uma resposta humanizada a partir de texto com delimitadores "||"
 */
function buildHumanizedResponse(rawText, userName, timeOfDay) {
    if (!rawText) return "";

    // 1. Separar as opções de resposta usando o delimitador "||"
    const options = rawText.split('||').map(opt => opt.trim());
    
    // 2. Escolher uma opção aleatoriamente
    const randomIndex = Math.floor(Math.random() * options.length);
    let selectedResponse = options[randomIndex];
    
    // 3. Calcula a hora sozinho se não for passada
    const actualTimeOfDay = timeOfDay || getAutoTimeOfDay();
    
    // 4. Substituir os placeholders pelas variáveis reais
    selectedResponse = selectedResponse.replace(/{nome}/ig, userName ? userName : "irmão(ã)"); 
    selectedResponse = selectedResponse.replace(/{saudacao_tempo}/ig, actualTimeOfDay);
    
    // 5. Limpeza de formatação (corrige espaços antes de pontuação)
    selectedResponse = selectedResponse.replace(/\s+!/g, '!').replace(/\s+,/g, ',');
    
    return selectedResponse;
}

// ============================================================================
// ORQUESTRADOR DE RESPOSTA FINAL
// ============================================================================

/**
 * Constrói a resposta final que será enviada para o WhatsApp
 */
function buildFinalReply(rawText, firstName, origem, aiData) {
    const timeOfDay = getAutoTimeOfDay();
    
    // Passa pelo nosso motor de humanização e aleatoriedade
    let reply = buildHumanizedResponse(rawText, firstName, timeOfDay);
    
    // Tratamento especial para saudações iniciais (para não ficar estranho se a IA já disser "Olá")
    const isGreeting = origem.includes("ID_1") || 
                       origem.includes("GREET") || 
                       aiData?.contexto?.toUpperCase().includes("SAUDACAO") || 
                       String(aiData?.id_table) === "1";
    
    if (isGreeting && !reply.includes(firstName)) {
        const textoLimpo = reply.replace(/^(Olá|Oi|Ola|Oi!|Olá!)\s*,?\s*/i, "");
        reply = `Olá ${firstName}! ${textoLimpo}`;
    }

    return reply;
}

/**
 * Calcula o tempo de digitação (delay) com base no tamanho do texto
 * e simula o "Escrevendo..." no WhatsApp de forma realista.
 */
async function simulateTyping(chat, text) {
    try {
        if (chat && typeof chat.sendStateTyping === 'function') {
            await chat.sendStateTyping(); 
        }

        // Lógica de tempo baseada na quantidade de caracteres para maior realismo
        let delayMs = 6000; // Tempo base padrão
        
        if (text.length > 60) {
            delayMs = Math.floor(Math.random() * (20000 - 15000 + 1)) + 15000;
        } else if (text.length < 20) {
            delayMs = Math.floor(Math.random() * (3000 - 1500 + 1)) + 1500;
        }

        await new Promise(resolve => setTimeout(resolve, delayMs));
        
        if (chat && typeof chat.clearState === 'function') {
            await chat.clearState();
        }
    } catch (error) {
        console.error(`[ERRO_HUMANIZER] Falha ao simular digitação: ${error.message}`);
    }
}

module.exports = {
    buildFinalReply,
    simulateTyping,
    buildHumanizedResponse,
    getAutoTimeOfDay
};