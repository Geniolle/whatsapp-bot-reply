//###################################################################################
// src/index.js
//###################################################################################
"use strict";

require("dotenv").config();

const cron = require("node-cron");
const { processOpenRows } = require("./services/alarmProcessor");
const { processCampaigns } = require("./services/campaignProcessor");

const { startClient_v1 } = require("./send");
const { registerOnMessage_v5 } = require("./handlers/onMessage");

//###################################################################################
// Config
//###################################################################################
const cfg = {
  spreadsheetId: process.env.SPREADSHEET_ID,
  sheetNameResp: process.env.SHEET_NAME_RESP,
  cacheSeconds: Number(process.env.CACHE_SECONDS || 60),

  sheetNameBp: process.env.SHEET_NAME_BP || process.env.SHEET_NAME_BP_SERVICE,
  cacheBpSeconds: Number(process.env.CACHE_BP_SECONDS || 300),

  sheetNameAusencias: process.env.SHEET_NAME_AUSENCIAS,
  cacheAusenciasSeconds: Number(process.env.CACHE_AUSENCIAS_SECONDS || 300),

  sheetNameEnsaio: process.env.SHEET_NAME_ENSAIO,
  cacheEnsaioSeconds: Number(process.env.CACHE_ENSAIO_SECONDS || 300),

  sheetNameAgenda: process.env.SHEET_NAME_AGENDA,
  cacheAgendaSeconds: Number(process.env.CACHE_AGENDA_SECONDS || 300),

  sheetNameAlarmes: process.env.SHEET_NAME_ALARMES || "ALARMISTICAS",

  ignoreLid: String(process.env.IGNORE_LID || "false").toLowerCase() === "true",
};

// Variável de segurança para não atropelar envios
let isProcessingVigia = false;

//###################################################################################
// Start
//###################################################################################
async function main_v5() {
  const client = await startClient_v1(cfg);
  registerOnMessage_v5(client, cfg);

  // ==========================================
  // ROTINA DE VIGIA SILENCIOSA (A cada 2 minutos)
  // ==========================================
  cron.schedule('*/2 * * * *', async () => {
    
    // Se já estiver processando, sai silenciosamente
    if (isProcessingVigia) return;

    isProcessingVigia = true; 

    try {
      // 1. Processa Alarmísticas (Logs internos agora só aparecem se houver envio)
      await processOpenRows({
        client: client, 
        spreadsheetId: cfg.spreadsheetId, 
        sheetName: cfg.sheetNameAlarmes,
        sheetNameBp: cfg.sheetNameBp
      });

      // 2. Processa Campanhas (Logs internos agora só aparecem se houver envio)
      await processCampaigns({ 
        client, 
        spreadsheetId: cfg.spreadsheetId 
      });

    } catch (error) {
      const hora = new Date().toLocaleString("pt-PT", { timeZone: "Europe/Lisbon" });
      console.error(`[VIGIA] [${hora}] Erro crítico:`, error.message);
    } finally {
      isProcessingVigia = false; 
    }

  }, {
    timezone: "Europe/Lisbon"
  });
  
  console.log('[SISTEMA] Vigia Híbrido ativo (Modo Silencioso).');
  // ==========================================
}

main_v5().catch((e) => {
  console.log("[FATAL]", e?.message || e);
  process.exit(1);
});