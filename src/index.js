//###################################################################################
// src/index.js
//###################################################################################
"use strict";

require("dotenv").config();

const cron = require("node-cron");
const { processOpenRows } = require("./services/alarmProcessor");

const { startClient_v1 } = require("./send");
const { registerOnMessage_v5 } = require("./handlers/onMessage");

//###################################################################################
// Config
//###################################################################################
const cfg = {
  // Base
  spreadsheetId: process.env.SPREADSHEET_ID,
  sheetNameResp: process.env.SHEET_NAME_RESP,
  cacheSeconds: Number(process.env.CACHE_SECONDS || 60),

  // BP SERVICE (ACL)
  sheetNameBp: process.env.SHEET_NAME_BP || process.env.SHEET_NAME_BP_SERVICE,
  cacheBpSeconds: Number(process.env.CACHE_BP_SECONDS || 300),

  // AUSÊNCIAS
  sheetNameAusencias: process.env.SHEET_NAME_AUSENCIAS,
  cacheAusenciasSeconds: Number(process.env.CACHE_AUSENCIAS_SECONDS || 300),

  // ENSAIO
  sheetNameEnsaio: process.env.SHEET_NAME_ENSAIO,
  cacheEnsaioSeconds: Number(process.env.CACHE_ENSAIO_SECONDS || 300),

  // AGENDA
  sheetNameAgenda: process.env.SHEET_NAME_AGENDA,
  cacheAgendaSeconds: Number(process.env.CACHE_AGENDA_SECONDS || 300),

  // ALARMES 
  sheetNameAlarmes: process.env.SHEET_NAME_ALARMES || "ALARMISTICAS",

  // Outros
  ignoreLid: String(process.env.IGNORE_LID || "false").toLowerCase() === "true",
};

// Variável de segurança para não atropelar envios
let isProcessingAlarms = false;

// Função auxiliar para pegar a hora atual em PT
function getHoraAtual() {
  return new Date().toLocaleString("pt-PT", { timeZone: "Europe/Lisbon" });
}

//###################################################################################
// Start
//###################################################################################
async function main_v5() {
  const client = await startClient_v1(cfg);
  registerOnMessage_v5(client, cfg);

  // ==========================================
  // ROTINA DE ALARMES (VIGIA CONTÍNUO)
  // ==========================================
  cron.schedule('*/2 * * * *', async () => {
    const hora = getHoraAtual();
    
    // Se já estiver enviando mensagens, ele pula esta verificação para não duplicar
    if (isProcessingAlarms) {
        console.log(`[VIGIA] [${hora}] Verificação ignorada: Já existe um envio de alarmes em andamento.`);
        return;
    }

    // Exibe no terminal a hora exata em que o vigia "acordou" para olhar a planilha
    console.log(`[VIGIA] [${hora}] Iniciando verificação de rotina na planilha de alarmes...`);
    
    isProcessingAlarms = true; // Tranca a porta

    try {
      await processOpenRows({
        client: client, 
        spreadsheetId: cfg.spreadsheetId, 
        sheetName: cfg.sheetNameAlarmes,
        sheetNameBp: cfg.sheetNameBp // <--- ABA DOS COLABORADORES ADICIONADA AQUI
      });
    } catch (error) {
      console.error(`[VIGIA] [${hora}] Erro crítico ao rodar os alarmes:`, error);
    } finally {
      isProcessingAlarms = false; // Destranca a porta quando terminar
    }

  }, {
    timezone: "Europe/Lisbon"
  });
  
  console.log('[SISTEMA] Vigia de Alarmes configurado para verificar a cada 2 minutos.');
  // ==========================================
}

main_v5().catch((e) => {
  console.log("[FATAL]", e?.message || e);
  process.exit(1);
});