// src/services/appBilling.js
"use strict";

const { readRange, appendRow } = require("./sheets");

const SALDO_INICIAL_OPENAI = 4.89; // O valor que vimos na tua print
const CUSTO_ESTIMADO_MSG = 0.0002; // Estimativa média por interação

// Função para registar cada mensagem na Sheet WhatsAppBilling
async function registrarGasto_v1({ spreadsheetId, chatId, mensagem }) {
  try {
    const sheetName = "WhatsAppBilling";
    const timestamp = new Date().toLocaleString("pt-PT");
    const id = Date.now(); // ID único simples

    // Colunas: ID, Data e Hora, ChatId, Mensagem, Custo Estimado
    const row = [id, timestamp, chatId, mensagem, CUSTO_ESTIMADO_MSG];
    
    await appendRow(spreadsheetId, sheetName, row);
  } catch (error) {
    console.error("[BILLING_SAVE_ERROR]:", error.message);
  }
}

// Função para ler a folha e calcular o saldo atual para o comando /saldo
async function getOpenAISaldo_v1({ spreadsheetId }) {
  try {
    const values = await readRange(spreadsheetId, "'WhatsAppBilling'!E:E");
    if (!values || values.length < 2) {
        return `💳 *Saldo OpenAI*\n\nSaldo: *$${SALDO_INICIAL_OPENAI.toFixed(2)}*\nAinda não existem gastos registados na folha.`;
    }

    // Soma todos os valores da coluna E (Custo Estimado), ignorando o cabeçalho
    let totalGasto = 0;
    for (let i = 1; i < values.length; i++) {
        const valor = parseFloat(values[i][0]);
        if (!isNaN(valor)) totalGasto += valor;
    }

    const saldoAtual = (SALDO_INICIAL_OPENAI - totalGasto).toFixed(2);

    return `💳 *CONTROLO DE SALDO*\n\n` +
           `💰 Saldo Restante: *$${saldoAtual}*\n` +
           `📉 Total Gasto (Bot): *$${totalGasto.toFixed(4)}*\n\n` +
               `⚠️ _Baseado em estimativas registadas na folha WhatsAppBilling._`;
  } catch (error) {
    console.error("[BILLING_READ_ERROR]:", error);
    return "❌ Erro ao calcular saldo na folha.";
  }
}

module.exports = { registrarGasto_v1, getOpenAISaldo_v1 };