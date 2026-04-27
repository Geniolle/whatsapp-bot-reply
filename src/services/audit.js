//###################################################################################
// src/services/audit.js
//###################################################################################
"use strict";

const fs = require('fs');
const path = require('path');

class AuditService {
    constructor() {
        this.logDir = path.resolve(process.cwd(), 'logs');
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir);
        }
    }

    log(level, category, message, details = null) {
        const timestamp = new Date().toISOString();
        const logLine = `[${timestamp}] [${level}] [${category}] ${message} ${details ? JSON.stringify(details) : ''}\n`;
        
        const logFile = path.join(this.logDir, `audit-${timestamp.split('T')[0]}.log`);
        
        // Escrita assíncrona para não bloquear o Event Loop
        fs.appendFile(logFile, logLine, (err) => {
            if (err) console.error("Erro ao gravar log de auditoria:", err);
        });

        // Saída para PM2
        if (level === 'ERROR') {
            console.error(logLine.trim());
        } else {
            console.log(logLine.trim());
        }
    }

    info(cat, msg, det) { this.log('INFO', cat, msg, det); }
    warn(cat, msg, det) { this.log('WARN', cat, msg, det); }
    error(cat, msg, det) { this.log('ERROR', cat, msg, det); }
}

module.exports = new AuditService();