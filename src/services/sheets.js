const path = require("path");
const { google } = require("googleapis");

// ==========================================
// AUTENTICAÇÃO
// ==========================================
function getAuth() {
  const keyFile = path.join(__dirname, "..", "..", "credentials", "service-account.json");
  return new google.auth.GoogleAuth({
    keyFile,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

// ==========================================
// FUNÇÕES DO BOT DE RESPOSTAS (Originais)
// ==========================================
async function readRange(spreadsheetId, rangeA1) {
  const auth = await getAuth().getClient();
  const sheets = google.sheets({ version: "v4", auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: rangeA1,
  });

  return res.data.values || [];
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
// FUNÇÕES DO BOT DE ALARMES (Novas)
// ==========================================

// Lê uma aba inteira (reaproveita a lógica do readRange)
async function readSheet(spreadsheetId, sheetName) {
  return await readRange(spreadsheetId, sheetName);
}

// Atualiza células específicas (ex: muda o status para "Concluído")
async function writeCells(spreadsheetId, range, values) {
  const auth = await getAuth().getClient();
  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
}

// Exporta tudo para que os dois sistemas funcionem em harmonia
module.exports = { 
  readRange, 
  appendRow, 
  readSheet, 
  writeCells 
};