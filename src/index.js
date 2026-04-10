//###################################################################################
// src/index.js
//###################################################################################
"use strict";

require("dotenv").config();
const audit = require("./services/audit");
const { startClient_v1 } = require("./send");
const { registerOnMessage_v5 } = require("./handlers/onMessage");

/**
 * Configuração Centralizada
 * Carrega variáveis de ambiente com fallbacks seguros
 */
const cfg = {
  spreadsheetId: process.env.SPREADSHEET_ID,
  sheetNameResp: process.env.SHEET_NAME_RESP,
  cacheSeconds: Number(process.env.CACHE_SECONDS || 60),

  // BP SERVICE (ACL)
  sheetNameBp: process.env.SHEET_NAME_BP || process.env.SHEET_NAME_BP_SERVICE,
  cacheBpSeconds: Number(process.env.CACHE_BP_SECONDS || 300),

  // SERVIÇOS ADICIONAIS
  sheetNameAusencias: process.env.SHEET_NAME_AUSENCIAS,
  sheetNameEnsaio: process.env.SHEET_NAME_ENSAIO,
  sheetNameAgenda: process.env.SHEET_NAME_AGENDA,
  
  // CACHE SETTINGS
  cacheAusenciasSeconds: Number(process.env.CACHE_AUSENCIAS_SECONDS || 300),
  cacheEnsaioSeconds: Number(process.env.CACHE_ENSAIO_SECONDS || 300),
  cacheAgendaSeconds: Number(process.env.CACHE_AGENDA_SECONDS || 300),

  ignoreLid: String(process.env.IGNORE_LID || "false").toLowerCase() === "true",
};

/**
 * Ponto de Entrada Principal
 */
async function main() {
  audit.info("SISTEMA", "Iniciando aplicação do Bot...");

  try {
    // 1. Inicializa o cliente do WhatsApp
    const client = await startClient_v1(cfg);
    audit.info("SISTEMA", "Cliente WhatsApp inicializado com sucesso.");

    // 2. Regista os handlers de mensagens
    registerOnMessage_v5(client, cfg);
    audit.info("SISTEMA", "Handlers de mensagens registados.");

    audit.info("SISTEMA", "Bot totalmente operacional e aguardando mensagens.");
  } catch (error) {
    audit.error("SISTEMA", "Erro fatal durante a inicialização", { 
      message: error.message,
      stack: error.stack 
    });
    process.exit(1);
  }
}

// Tratamento de erros não capturados para evitar crash silencioso
process.on("unhandledRejection", (reason, promise) => {
  audit.error("SISTEMA", "Unhandled Rejection detetada", { reason });
});

process.on("uncaughtException", (error) => {
  audit.error("SISTEMA", "Uncaught Exception detetada", { message: error.message });
  process.exit(1);
});

main();