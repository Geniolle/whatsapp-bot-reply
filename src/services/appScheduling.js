//###################################################################################
// src/services/appScheduling.js - VERSÃO COM FILA DE LOTE INTELIGENTE
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

// ==============================================================================
// FUNÇÕES DE BUSCA E FILA
// ==============================================================================

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

    // Aceita tanto "Aguardando" quanto "Em espera" para processamento via WhatsApp
    const isPending = status.includes("Aguardando") || status.includes("Em espera");

    if (apoioInfo && apoioInfo.liderTelefone === leaderPhoneOnly && isPending) {
      pendings.push({
        rowIndex: i + 1,
        id: row[idx.id],
        solicitante: row[idx.solicitante],
        apoio: row[idx.apoio],
        numeroSolicitante: row[idx.number],
        detalhes: row[idx.detalhes],
        departamento: apoioInfo.departamento,
        liderNome: apoioInfo.liderNome
      });
    }
  }
  return pendings;
}

/**
 * Busca o próximo item "Em espera" do mesmo lote
 */
async function getNextInBatch(spreadsheetId, sheetName, solicitante, apoio) {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${SHEET_NAME}'!A:Z` });
    const rows = res.data.values || [];
    if (rows.length < 2) return null;

    const idx = getColumnIndexes(rows[0]);
    
    const nextRow = rows.find((r, i) => 
        i > 0 && 
        r[idx.solicitante] === solicitante && 
        r[idx.apoio] === apoio && 
        String(r[idx.status]).includes("Em espera")
    );

    return nextRow ? {
        id: nextRow[idx.id],
        detalhes: nextRow[idx.detalhes],
        solicitante: nextRow[idx.solicitante]
    } : null;
}

async function updateStatusById({ spreadsheetId, requestId, newStatus }) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${SHEET_NAME}'!A:Z` });
  const rows = res.data.values || [];
  if (rows.length < 2) return null;

  const idx = getColumnIndexes(rows[0]);
  const nowStr = new Date().toLocaleString("pt-PT", { timeZone: "Europe/Lisbon" });

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][idx.id]).trim() === String(requestId).trim()) {
      const rowIndex = i + 1;
      
      // 1. Atualiza Status
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${SHEET_NAME}!${String.fromCharCode(65 + idx.status)}${rowIndex}`,
        valueInputOption: "RAW",
        requestBody: { values: [[newStatus]] },
      });

      // 2. Atualiza Timestamp
      if (idx.timestamp >= 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${SHEET_NAME}!${String.fromCharCode(65 + idx.timestamp)}${rowIndex}`,
          valueInputOption: "RAW",
          requestBody: { values: [[nowStr]] },
        });
      }

      return {
        id: requestId,
        solicitante: rows[i][idx.solicitante],
        numeroSolicitante: rows[i][idx.number],
        apoio: rows[i][idx.apoio],
        apoioData: parseApoioField(rows[i][idx.apoio]),
        detalhes: rows[i][idx.detalhes]
      };
    }
  }
  return null;
}

// ==============================================================================
// VIGIA COM LÓGICA DE FILA (O CORAÇÃO DA MUDANÇA)
// ==============================================================================
async function checkAndNotifyNewRequests(client, cfg) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: cfg.spreadsheetId, range: `'${SHEET_NAME}'!A:Z` });
  const rows = res.data.values || [];
  if (rows.length < 2) return;

  const idx = getColumnIndexes(rows[0]);
  const lotesNotificados = new Set(); // Evita enviar 2 do mesmo lote na mesma rodada

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const status = String(row[idx.status] || "").trim();
    const solicitante = row[idx.solicitante];
    const apoioRaw = row[idx.apoio];
    const apoioInfo = parseApoioField(apoioRaw);

    if (!apoioInfo || status) continue;

    const loteKey = `${solicitante}|${apoioRaw}`;

    // Se já enviamos um deste lote agora, ou se já existe um "Aguardando" na planilha para este lote
    const jaExisteAguardando = rows.some((r, idxR) => 
        idxR > 0 && 
        r[idx.solicitante] === solicitante && 
        r[idx.apoio] === apoioRaw && 
        String(r[idx.status]).includes("Aguardando")
    );

    if (lotesNotificados.has(loteKey) || jaExisteAguardando) {
      // MARCA COMO EM ESPERA (FILA)
      await sheets.spreadsheets.values.update({
        spreadsheetId: cfg.spreadsheetId,
        range: `${SHEET_NAME}!${String.fromCharCode(65 + idx.status)}${i + 1}`,
        valueInputOption: "RAW",
        requestBody: { values: [["Em espera ⏳"]] },
      });
      continue;
    }

    // ENVIA O PRIMEIRO DO LOTE
    const requestId = row[idx.id];
    const targetChatId = `${apoioInfo.liderTelefone}@c.us`;
    const msg = `*CONFIRMAÇÃO DE SOLICITAÇÃO*\n\nOlá *${apoioInfo.liderNome}*, o departamento *${solicitante}* solicitou o apoio de *${apoioInfo.departamento}*.\n\n🆔 *ID do Pedido:* ${requestId}\n📝 *Detalhes:* ${row[idx.detalhes]}\n\nPara aceitar, responda apenas com *CONFIRMAR*. Para rejeitar, responda *RECUSAR*.`;

    try {
      await client.sendMessage(targetChatId, msg);
      await sheets.spreadsheets.values.update({
        spreadsheetId: cfg.spreadsheetId,
        range: `${SHEET_NAME}!${String.fromCharCode(65 + idx.status)}${i + 1}`,
        valueInputOption: "RAW",
        requestBody: { values: [["Aguardando ⏳"]] },
      });
      lotesNotificados.add(loteKey);
      console.log(`[VIGIA] Lote Iniciado: Pedido #${requestId} enviado.`);
      await new Promise(r => setTimeout(r, 2000)); 
    } catch (err) {
      console.error(`[VIGIA_ERR] Pedido #${requestId}:`, err.message);
    }
  }
}

module.exports = { findAllPendingByLeader, updateStatusById, checkAndNotifyNewRequests, getNextInBatch };