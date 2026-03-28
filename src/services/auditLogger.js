//###################################################################################
// src/services/auditLogger.js - VERSÃO COM DEPARTAMENTOS NO STATUS
//###################################################################################
"use strict";

const fs = require("fs");
const path = require("path");

function logAudit(data) {
    const now = new Date().toLocaleString("pt-PT");
    
    // 1. Define o status base
    let statusText = data.isColab ? "🟢 Colab" : "⚪ Visitante";
    
    // 2. Se for Colab e tiver departamentos, adiciona-os ao status!
    if (data.isColab && Array.isArray(data.depts) && data.depts.length > 0) {
        // Mapeia tanto se for um objeto {nome, nivel} ou apenas uma string normal
        const deptsString = data.depts.map(d => typeof d === 'object' ? d.nome : d).join(", ");
        statusText += `, ${deptsString}`;
    }
    
    // 3. Constrói a mensagem visual do log
    let logMsg = `\n---------------------------------------------------------`;
    logMsg += `\n[${data.type}] ${now}`;
    if (data.chatId)   logMsg += `\n > CHAT: ${data.chatId} | STATUS: ${statusText}`;
    if (data.msg)      logMsg += `\n > RECEBIDO: "${data.msg}"`;
    if (data.response) logMsg += `\n > ENVIADO:  "${data.response}"`; 
    if (data.origem)   logMsg += `\n > ORIGEM:   ${data.origem}`;
    if (data.idTable)  logMsg += `\n > ID: ${data.idTable} | CTX: ${data.context || 'Geral'}`;
    if (data.process)  logMsg += `\n > PROC: ${data.process}`;
    
    if (data.error) {
        logMsg += `\n > ❌ ERROR: ${data.error}`;
    }
    logMsg += `\n---------------------------------------------------------`;

    // 4. Imprime no terminal
    console.log(logMsg);
    
    // 5. Guarda no ficheiro de log persistente
    try {
        const logPath = path.join(__dirname, "../../audit.log");
        fs.appendFileSync(logPath, logMsg);
    } catch (e) { 
        console.error("Erro ao gravar log no ficheiro:", e.message); 
    }
}

module.exports = { logAudit };