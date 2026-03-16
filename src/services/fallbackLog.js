const { appendRow } = require("./sheets");

const LOG_SHEET = "LOG_FALLBACK";

function nowTimestamp() {
  // ISO é bom para ordenar e filtrar (ex.: 2026-02-23T12:34:56.789Z)
  return new Date().toISOString();
}

async function logFallback({ spreadsheetId, chatId, rawMsg, normMsg }) {
  await appendRow(spreadsheetId, LOG_SHEET, [
    nowTimestamp(), // TIMESTEMP
    chatId,
    rawMsg,
    normMsg,
  ]);
}

module.exports = { logFallback, LOG_SHEET };