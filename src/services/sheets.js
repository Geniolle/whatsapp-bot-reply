const path = require("path");
const { google } = require("googleapis");

function getAuth() {
  const keyFile = path.join(__dirname, "..", "..", "credentials", "service-account.json");
  return new google.auth.GoogleAuth({
    keyFile,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

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

module.exports = { readRange, appendRow };