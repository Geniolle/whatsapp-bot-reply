//###################################################################################
// src/services/sheets.js - VERSÃO DEFINITIVA COM AUTENTICAÇÃO, ALIAS E AUDITORIA
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
    const path3 = path.join(process.cwd(), "credentials.json");

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

        console.log(`[AUDITORIA] Leitura realizada com sucesso | Range: ${cleanRange}`);
        return res.data.values || [];
    } catch (error) {
        console.error(`\x1b[31m[ERRO_AUDITORIA] [SHEETS_READ_ERR]\x1b[0m Range: ${rangeA1} | Erro: ${error.message}`);
        throw error;
    }
}

async function appendRow(spreadsheetId, sheetName, rowValues) {
    try {
        const auth = await getAuth().getClient();
        const sheets = google.sheets({ version: "v4", auth });

        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `${sheetName}!A:D`,
            valueInputOption: "RAW",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values: [rowValues] },
        });
        console.log(`[AUDITORIA] Nova linha adicionada com sucesso | Aba: ${sheetName}`);
    } catch (error) {
        console.error(`\x1b[31m[ERRO_AUDITORIA] [SHEETS_APPEND_ERR]\x1b[0m Aba: ${sheetName} | Erro: ${error.message}`);
        throw error;
    }
}

/**
 * NOVA FUNÇÃO: Escreve ou atualiza células específicas/intervalos (Requisitada pelo VIGIA)
 */
async function writeCells(spreadsheetId, rangeA1, values) {
    try {
        const auth = await getAuth().getClient();
        const sheets = google.sheets({ version: "v4", auth });

        // Garante que os values estejam num formato bidimensional array [][]
        const valuesFormatados = Array.isArray(values[0]) ? values : [values];

        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: rangeA1,
            valueInputOption: "RAW",
            requestBody: {
                values: valuesFormatados,
            },
        });
        console.log(`[AUDITORIA] Células atualizadas com sucesso | Range: ${rangeA1}`);
    } catch (error) {
        console.error(`\x1b[31m[ERRO_AUDITORIA] [SHEETS_WRITE_ERR]\x1b[0m Range: ${rangeA1} | Erro: ${error.message}`);
        throw error;
    }
}

// ==========================================
// GESTÃO DE STATUS E LOTES
// ==========================================

async function updateStatusById(spreadsheetId, sheetName, idPedido, novoStatus) {
    try {
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
            
            console.log(`[AUDITORIA] Status atualizado | ID: ${idPedido} -> ${novoStatus}`);
            return true;
        }
        return false;
    } catch (error) {
        console.error(`\x1b[31m[ERRO_AUDITORIA] [SHEETS_UPDATE_STATUS_ERR]\x1b[0m ID: ${idPedido} | Erro: ${error.message}`);
        throw error;
    }
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

    if (nextRow) {
        console.log(`[AUDITORIA] Próximo do lote encontrado | ID: ${nextRow[idxId]}`);
        return {
            id: nextRow[idxId],
            detalhes: nextRow[idxDet],
            solicitante: nextRow[idxSol],
            apoio: nextRow[idxApoio]
        };
    }
    
    return null;
}

/**
 * ALIAS: Define readSheet como um sinónimo de readRange
 */
const readSheet = readRange;

module.exports = { 
    readRange, 
    appendRow, 
    writeCells, // <-- ADICIONADO E EXPORTADO AQUI!
    readSheet, 
    updateStatusById, 
    getNextInBatch 
};