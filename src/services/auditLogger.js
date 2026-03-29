//###################################################################################
// src/services/auditLogger.js - LOGGER COM DEPARTAMENTOS E PERFIL DE MANAGER
//###################################################################################
"use strict";

const fs = require("fs");
const path = require("path");

function logAudit(data) {
    const now = new Date().toLocaleString("pt-PT");

    let statusText = data.isColab ? "🟢 Colab" : "⚪ Visitante";

    if (data.isColab && Array.isArray(data.depts) && data.depts.length > 0) {
        const deptsString = data.depts.map(d => {
            if (typeof d === "object") {
                const nome = d.nome || "";
                const nivel = d.nivel ? ` [${d.nivel}]` : "";
                return `${nome}${nivel}`;
            }
            return d;
        }).join(", ");

        statusText += `, ${deptsString}`;
    }

    if (data.isManager === true) {
        statusText += ` | 👔 Manager`;
    }

    if (Array.isArray(data.managerDepts) && data.managerDepts.length > 0) {
        statusText += ` (${data.managerDepts.join(", ")})`;
    }

    let logMsg = `\n---------------------------------------------------------`;
    logMsg += `\n[${data.type}] ${now}`;
    if (data.chatId)   logMsg += `\n > CHAT: ${data.chatId} | STATUS: ${statusText}`;
    if (data.msg)      logMsg += `\n > RECEBIDO: "${data.msg}"`;
    if (data.response) logMsg += `\n > ENVIADO:  "${data.response}"`;
    if (data.origem)   logMsg += `\n > ORIGEM:   ${data.origem}`;
    if (data.idTable)  logMsg += `\n > ID: ${data.idTable} | CTX: ${data.context || "Geral"}`;
    if (data.process)  logMsg += `\n > PROC: ${data.process}`;

    if (data.error) {
        logMsg += `\n > ❌ ERROR: ${data.error}`;
    }
    logMsg += `\n---------------------------------------------------------`;

    console.log(logMsg);

    try {
        const logPath = path.join(__dirname, "../../audit.log");
        fs.appendFileSync(logPath, logMsg);
    } catch (e) {
        console.error("Erro ao gravar log no ficheiro:", e.message);
    }
}

module.exports = { logAudit };