//###################################################################################
// src/services/auditLogger.js - VERSÃO COM EXIBIÇÃO DE RESPOSTA ENVIADA
//###################################################################################
"use strict";
const fs = require("fs");
const path = require("path");

function logAudit(data) {
    const now = new Date().toLocaleString("pt-PT");
    const statusIcon = data.isColab ? "🟢 Colab" : "⚪ Visitante";
    
    let logMsg = `\n---------------------------------------------------------`;
    logMsg += `\n[${data.type}] ${now}`;
    if (data.chatId)   logMsg += `\n > CHAT: ${data.chatId} | STATUS: ${statusIcon}`;
    if (data.msg)      logMsg += `\n > RECEBIDO: "${data.msg}"`;
    if (data.response) logMsg += `\n > ENVIADO:  "${data.response}"`; // <-- RESPOSTA AQUI
    if (data.origem)   logMsg += `\n > ORIGEM:   ${data.origem}`;
    if (data.idTable)  logMsg += `\n > ID: ${data.idTable} | CTX: ${data.context || 'Geral'}`;
    if (data.process)  logMsg += `\n > PROC: ${data.process}`;
    
    if (data.error) {
        logMsg += `\n > ❌ ERROR: ${data.error}`;
    }
    logMsg += `\n---------------------------------------------------------`;

    console.log(logMsg);
    
    try {
        fs.appendFileSync(path.join(__dirname, "../../audit.log"), logMsg);
    } catch (e) { console.error("Erro ao gravar log:", e.message); }
}

module.exports = { logAudit };