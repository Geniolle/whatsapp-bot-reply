//###################################################################################
// src/services/sheets.js - VERSÃO DEFINITIVA COM AUTENTICAÇÃO E ALIAS
//###################################################################################
"use strict";

const path = require("path");
const { google } = require("googleapis");
const fs = require("fs");

/**
 * Define o caminho do arquivo de credenciais.
 * Tentamos primeiro na pasta 'credentials' e depois na raiz por segurança.
 */
function getCredentialsPath() {
    const path1 = path.join(process.cwd(), "credentials", "service-account.json");
    const path2 = path.join(process.cwd(), "service-account.json");
    const path3 = path.join(process.cwd(), "credentials.json"); // Nome comum

    if (fs.existsSync(path1)) return path1;
    if (fs.existsSync(path2)) return path2;
    if (fs.existsSync(path3)) return path3;
    
    // Se não encontrar, retorna o padrão para gerar o erro descritivo no catch
    return path1;
}

function getAuth() {
    const keyFile = getCredentialsPath();
    return new google.auth.GoogleAuth({
        keyFile,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
}

// ==========================================
// FUNÇÕES DE LEITURA E ESCRITA
// ==========================================

async function readRange(spreadsheetId, rangeA1) {
    try {
        const auth = await getAuth().getClient();
        const sheets = google.sheets({ version: "v4", auth });

        // Garante que o range tenha aspas simples para nomes com espaços
        const cleanRange = rangeA1.includes("!") && !rangeA1.includes("'") 
            ? `'${rangeA1.replace("!", "'!")}` 
            : rangeA1;

        const res = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: cleanRange,
        });

        return res.data.values || [];
    } catch (error) {
        console.error(`\x1b[31m[SHEETS_READ_ERR]\x1b[0m Range: ${rangeA1} | Erro: ${error.message}`);
        throw error;
    }
}

async function appendRow(spreadsheetId, sheetName, rowValues) {
    const auth = await getAuth().getClient();
    const sheets = google.sheets({ version: "v4", auth });

    await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A:D`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [rowValues] },
    });
}

// ==========================================
// GESTÃO DE STATUS E LOTES
// ==========================================

async function updateStatusById(spreadsheetId, sheetName, idPedido, novoStatus) {
    const auth = await getAuth().getClient();
    const sheets = google.sheets({ version: "v4", auth });

    const rows = await readRange(spreadsheetId, `'${sheetName}'!A:ZZ`);
    if (!rows.length) return false;

    const header = rows[0];
    const idxId = header.indexOf("ID_PEDIDO");
    const idxStatus = header.indexOf("STATUS");
    const idxTimestamp = header.indexOf("TIMESTEMP") || header.indexOf("TIMESTAMP");

    const rowIndex = rows.findIndex(r => r[idxId] == idPedido) + 1;

    if (rowIndex > 0) {
        // Coluna Status
        const colLetterStatus = String.fromCharCode(65 + idxStatus);
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${sheetName}!${colLetterStatus}${rowIndex}`,
            valueInputOption: "RAW",
            requestBody: { values: [[novoStatus]] },
        });

        // Coluna Timestamp
        if (idxTimestamp >= 0) {
            const colLetterTime = String.fromCharCode(65 + idxTimestamp);
            const agora = new Date().toLocaleString("pt-PT", { timeZone: "Europe/Lisbon" });
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `${sheetName}!${colLetterTime}${rowIndex}`,
                valueInputOption: "RAW",
                requestBody: { values: [[agora]] },
            });
        }
        return true;
    }
    return false;
}

async function getNextInBatch(spreadsheetId, sheetName, solicitante, apoio) {
    const rows = await readRange(spreadsheetId, `'${sheetName}'!A:ZZ`);
    if (!rows.length) return null;

    const header = rows[0];
    const idxSol = header.indexOf("SOLICITANTE");
    const idxApoio = header.indexOf("APOIO");
    const idxStatus = header.indexOf("STATUS");
    const idxId = header.indexOf("ID_PEDIDO");
    const idxDet = header.indexOf("DETALHES");

    const nextRow = rows.find((r, index) => 
        index > 0 && 
        r[idxSol] === solicitante && 
        r[idxApoio] === apoio && 
        (String(r[idxStatus]).includes("Aguardando") || String(r[idxStatus]).includes("Em espera"))
    );

    return nextRow ? {
        id: nextRow[idxId],
        detalhes: nextRow[idxDet],
        solicitante: nextRow[idxSol],
        apoio: nextRow[idxApoio]
    } : null;
}

/**
 * ALIAS: Define readSheet como um sinônimo de readRange para evitar erros no Vigia.
 */
const readSheet = readRange;

module.exports = { 
    readRange, 
    appendRow, 
    readSheet, 
    updateStatusById, 
    getNextInBatch 
};