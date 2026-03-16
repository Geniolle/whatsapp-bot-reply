//###################################################################################
// src/index.js
//###################################################################################
"use strict";

require("dotenv").config();

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

  // AGENDA (NOVO)
  sheetNameAgenda: process.env.SHEET_NAME_AGENDA,
  cacheAgendaSeconds: Number(process.env.CACHE_AGENDA_SECONDS || 300),

  // Outros
  ignoreLid: String(process.env.IGNORE_LID || "false").toLowerCase() === "true",
};

//###################################################################################
// Start
//###################################################################################
async function main_v5() {
  const client = await startClient_v1(cfg);
  registerOnMessage_v5(client, cfg);
}

main_v5().catch((e) => {
  console.log("[FATAL]", e?.message || e);
  process.exit(1);
});