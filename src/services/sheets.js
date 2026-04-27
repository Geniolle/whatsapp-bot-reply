//###################################################################################
// src/services/sheets.js - MOTOR DE DADOS GOOGLE (RESILIENTE)
//###################################################################################
"use strict";

const { google } = require("googleapis");
const audit = require("./audit");

/**
 * Configura o cliente de autenticação.
 */
async function getAuthClient() {
    try {
        const auth = new google.auth.GoogleAuth({
            keyFile: "./credentials/google-credentials.json",
            scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
        });
        return await auth.getClient();
    } catch (error) {
        audit.error("SHEETS_AUTH", "Falha crítica de autenticação", { error: error.message });
        throw error;
    }
}

/**
 * Lê dados da planilha com Timeout de segurança para evitar bloqueio de CPU.
 */
async function getSheetData_v1({ spreadsheetId, range }) {
    if (!spreadsheetId || !range) throw new Error("Parâmetros de planilha ausentes.");

    try {
        const auth = await getAuthClient();
        const sheets = google.sheets({ version: "v4", auth });

        audit.info("SHEETS_READ", `Leitura iniciada: ${range}`);

        // Timeout de 10 segundos para não "congelar" o bot
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range,
        }, { timeout: 10000 });

        return response.data.values || [];

    } catch (error) {
        if (error.code === 'ETIMEDOUT' || error.message.includes('socket')) {
            audit.error("SHEETS_TIMEOUT", "Conexão com Google lenta ou caída", { range });
        } else {
            audit.error("SHEETS_ERROR", error.message, { range });
        }
        return []; // Retorna vazio para o bot continuar operante
    }
}

module.exports = { getSheetData_v1 };