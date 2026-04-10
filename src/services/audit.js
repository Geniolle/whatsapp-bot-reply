"use strict";

const fs = require('fs');
const path = require('path');

/**
 * Serviço de Auditoria Global
 * Regista eventos importantes, erros e ações do utilizador
 */
function logEvent(level, category, message, details = null) {
  const timestamp = new Date().toISOString();
  const logDir = path.resolve(process.cwd(), 'logs');
  
  // Garante que a pasta de logs existe
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
  }

  const logEntry = {
    timestamp,
    level: level.toUpperCase(),
    category: category.toUpperCase(),
    message,
    details
  };

  const logLine = `[${timestamp}] [${logEntry.level}] [${logEntry.category}] ${message} ${details ? JSON.stringify(details) : ''}\n`;

  // Escreve no log de auditoria do dia
  const logFile = path.join(logDir, `audit-${timestamp.split('T')[0]}.log`);
  fs.appendFileSync(logFile, logLine);

  // Também envia para a consola para o PM2 capturar
  console.log(logLine.trim());
}

module.exports = {
  info: (cat, msg, det) => logEvent('INFO', cat, msg, det),
  warn: (cat, msg, det) => logEvent('WARN', cat, msg, det),
  error: (cat, msg, det) => logEvent('ERROR', cat, msg, det)
};