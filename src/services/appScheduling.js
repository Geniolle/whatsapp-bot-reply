//###################################################################################
// src/services/appScheduling.js
//###################################################################################
"use strict";

const { google } = require("googleapis");
const path = require("path");

const SHEET_NAME = process.env.SHEET_NAME_APOIO || "WS_COMUNICACAO";

let sheetsClientInstance = null;
async function getSheetsClient() {
  if (sheetsClientInstance) return sheetsClientInstance;
  const keyFile = path.join(__dirname, "..", "..", "credentials", "service-account.json");
  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const authClient = await auth.getClient();
  sheetsClientInstance = google.sheets({ version: "v4", auth: authClient });
  return sheetsClientInstance;
}

function getColumnIndexes(header) {
  const norm = (h) => String(h || "").trim().toUpperCase();
  return {
    id: header.findIndex(h => norm(h).includes("ID_PEDIDO")),
    status: header.findIndex(h => norm(h).includes("STATUS")),
    solicitante: header.findIndex(h => norm(h).includes("SOLICITANTE")),
    number: header.findIndex(h => norm(h).includes("ID_NUMBER")),
    apoio: header.findIndex(h => norm(h).includes("APOIO")),
    detalhes: header.findIndex(h => norm(h).includes("DETALHES")),
    // NOVO: Encontra a coluna TIMESTEMP ou TIMESTAMP
    timestamp: header.findIndex(h => norm(h).includes("TIMESTEMP") || norm(h).includes("TIMESTAMP"))
  };
}

function parseApoioField(apoioStr) {
  if (!apoioStr) return null;
  const clean = apoioStr.replace(/[{}]/g, "");
  const parts = clean.split(";").map(p => p.trim());
  if (parts.length < 3) return null;
  return {
    departamento: parts[0],
    liderNome: parts[1],
    liderTelefone: parts[2].replace(/\D/g, "") 
  };
}

async function findAllPendingByLeader({ spreadsheetId, leaderChatId }) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${SHEET_NAME}'!A:Z` });
  const rows = res.data.values || [];
  if (rows.length < 2) return [];

  const idx = getColumnIndexes(rows[0]);
  const leaderPhoneOnly = leaderChatId.split("@")[0].replace(/\D/g, "");
  const pendings = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const status = String(row[idx.status] || "").trim();
    const apoioInfo = parseApoioField(row[idx.apoio]);

    const isPending = !status || status.includes("Aguardando");

    if (apoioInfo && apoioInfo.liderTelefone === leaderPhoneOnly && isPending) {
      pendings.push({
        rowIndex: i + 1,
        id: row[idx.id],
        solicitante: row[idx.solicitante],
        numeroSolicitante: row[idx.number],
        detalhes: row[idx.detalhes],
        departamento: apoioInfo.departamento,
        liderNome: apoioInfo.liderNome,
        colStatus: String.fromCharCode(65 + idx.status)
      });
    }
  }
  return pendings;
}

async function updateStatusById({ spreadsheetId, requestId, newStatus }) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${SHEET_NAME}'!A:Z` });
  const rows = res.data.values || [];
  if (rows.length < 2) return null;

  const idx = getColumnIndexes(rows[0]);
  const nowStr = new Date().toLocaleString("pt-PT", { timeZone: "Europe/Lisbon" }); // Data e hora atual

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][idx.id]).trim() === String(requestId).trim()) {
      const rowIndex = i + 1;
      const colLetterStatus = String.fromCharCode(65 + idx.status);
      
      // 1. Atualizar a coluna STATUS
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${SHEET_NAME}!${colLetterStatus}${rowIndex}`,
        valueInputOption: "RAW",
        requestBody: { values: [[newStatus]] },
      });

      // 2. Atualizar a coluna TIMESTEMP (se ela existir na folha)
      if (idx.timestamp >= 0) {
        const colLetterTs = String.fromCharCode(65 + idx.timestamp);
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${SHEET_NAME}!${colLetterTs}${rowIndex}`,
          valueInputOption: "RAW",
          requestBody: { values: [[nowStr]] },
        });
      }

      return {
        id: requestId,
        solicitante: rows[i][idx.solicitante],
        numeroSolicitante: rows[i][idx.number],
        apoioData: parseApoioField(rows[i][idx.apoio]),
        detalhes: rows[i][idx.detalhes]
      };
    }
  }
  return null;
}

async function checkAndNotifyNewRequests(client, cfg) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: cfg.spreadsheetId, range: `'${SHEET_NAME}'!A:Z` });
  const rows = res.data.values || [];
  if (rows.length < 2) return;

  const idx = getColumnIndexes(rows[0]);

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const status = String(row[idx.status] || "").trim();
    const apoioInfo = parseApoioField(row[idx.apoio]);

    if (apoioInfo && !status) {
      const requestId = row[idx.id];
      const targetChatId = `${apoioInfo.liderTelefone}@c.us`;
      const msg = `*CONFIRMAÇÃO DE SOLICITAÇÃO*\n\nOlá *${apoioInfo.liderNome}*, o departamento *${row[idx.solicitante]}* solicitou o apoio de *${apoioInfo.departamento}*.\n\n🆔 *ID do Pedido:* ${requestId}\n📝 *Detalhes:* ${row[idx.detalhes]}\n\nPara aceitar, responda apenas com *CONFIRMAR*. Para rejeitar, responda *RECUSAR*.`;

      try {
        await client.sendMessage(targetChatId, msg);
        const colLetter = String.fromCharCode(65 + idx.status);
        await sheets.spreadsheets.values.update({
          spreadsheetId: cfg.spreadsheetId,
          range: `${SHEET_NAME}!${colLetter}${i + 1}`,
          valueInputOption: "RAW",
          requestBody: { values: [["Aguardando ⏳"]] },
        });
        console.log(`[VIGIA] Notificação enviada: Líder ${apoioInfo.liderNome} (Pedido #${requestId})`);
        await new Promise(r => setTimeout(r, 2000)); 
      } catch (err) {
        console.error(`[VIGIA_ERR] Pedido #${requestId}:`, err.message);
      }
    }
  }
}

module.exports = { findAllPendingByLeader, updateStatusById, checkAndNotifyNewRequests };