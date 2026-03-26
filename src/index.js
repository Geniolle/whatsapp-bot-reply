//###################################################################################
// src/index.js
//###################################################################################
"use strict";

require("dotenv").config();

const cron = require("node-cron");
const { processOpenRows } = require("./services/alarmProcessor");
const { processCampaigns } = require("./services/campaignProcessor");
const { checkAndNotifyNewRequests } = require("./services/appScheduling");

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

  // 🟢 NOVA CONFIG: LER A ABA DE APOIO DO .ENV
  sheetNameApoio: process.env.SHEET_NAME_APOIO || "WS_COMUNICACAO",

  ignoreLid: String(process.env.IGNORE_LID || "false").toLowerCase() === "true",
};

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
    
    if (isProcessingVigia) return;
    isProcessingVigia = true; 

    try {
      await processOpenRows({
        client: client, 
        spreadsheetId: cfg.spreadsheetId, 
        sheetName: cfg.sheetNameAlarmes,
        sheetNameBp: cfg.sheetNameBp
      });

      await processCampaigns({ 
        client, 
        spreadsheetId: cfg.spreadsheetId 
      });

      // 🟢 Processa Agendamentos lendo a config do .env
      await checkAndNotifyNewRequests(client, cfg);

    } catch (error) {
      const hora = new Date().toLocaleString("pt-PT", { timeZone: "Europe/Lisbon" });
      console.error(`[VIGIA] [${hora}] Erro crítico:`, error.message);
    } finally {
      isProcessingVigia = false; 
    }

  }, {
    timezone: "Europe/Lisbon"
  });
  
  console.log('[SISTEMA] Vigia Híbrido ativo (Modo Silencioso com Agendamentos).');
}

main_v5().catch((e) => {
  console.log("[FATAL]", e?.message || e);
  process.exit(1);
});