// src/services/bpLookup.js
"use strict";

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

//###################################################################################
// Cache simples em memória
//###################################################################################
const cache = new Map();

function cacheGet(key) {
  const it = cache.get(key);
  if (!it) return null;
  if (Date.now() > it.exp) {
    cache.delete(key);
    return null;
  }
  return it.val;
}

function cacheSet(key, val, ttlSeconds) {
  cache.set(key, { val, exp: Date.now() + (ttlSeconds || 300) * 1000 });
}

//###################################################################################
// Normalização telefone / chatId
//###################################################################################
function onlyDigits_v1(s) {
  return String(s || "").replace(/\D+/g, "");
}

function chatIdToNumber_v1(chatId) {
  return onlyDigits_v1(String(chatId || "").split("@")[0]);
}

//###################################################################################
// Google Sheets client (service account)
//###################################################################################
let sheetsClient = null;

function getSheetsClient_v1() {
  if (sheetsClient) return sheetsClient;

  const credPath = path.resolve(process.cwd(), "credentials", "service-account.json");
  if (!fs.existsSync(credPath)) {
    throw new Error(`[BP_LOOKUP] service-account.json não encontrado em: ${credPath}`);
  }

  const creds = JSON.parse(fs.readFileSync(credPath, "utf8"));
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

//###################################################################################
// Ler range
//###################################################################################
async function readRange_v1(spreadsheetId, rangeA1) {
  const sheets = getSheetsClient_v1();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: rangeA1,
    majorDimension: "ROWS",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  return res?.data?.values || [];
}

//###################################################################################
// Cabeçalhos
//###################################################################################
function headerUpper_v1(headers) {
  return (headers || []).map((h) => String(h || "").trim().toUpperCase());
}

function findHeaderIndex_v1(headers, wanted) {
  const H = headerUpper_v1(headers);
  const W = (wanted || []).map((w) => String(w || "").trim().toUpperCase());
  for (let i = 0; i < H.length; i++) {
    if (W.includes(H[i])) return i;
  }
  return -1;
}

function toBool_v1(v) {
  const t = String(v ?? "").trim().toLowerCase();
  return t === "true" || t === "1" || t === "sim" || t === "yes";
}

function stripDeptPrefix_v1(hUpper) {
  let s = String(hUpper || "").trim();
  if (s.startsWith("D.")) s = s.slice(2);
  return s.trim();
}

//###################################################################################
// Public: manter compatibilidade
//###################################################################################
async function getFirstNameByChatId({ spreadsheetId, sheetNameBp, chatId, cacheSeconds }) {
  const ctx = await getBpContextByChatId({
    spreadsheetId,
    sheetNameBp,
    chatId,
    cacheSeconds,
  });
  return ctx.firstName || "";
}

//###################################################################################
// Contexto do BP
// - fullName: nome completo (para pesquisar ausências)
// - isColaborador: coluna DEPARTAMENTOS (ou aliases)
// - deptList/flags: colunas D.* == true
//###################################################################################
async function getBpContextByChatId({ spreadsheetId, sheetNameBp, chatId, cacheSeconds }) {
  const key = `bp:ctx:${spreadsheetId}:${sheetNameBp}:${chatId}`;
  const cached = cacheGet(key);
  if (cached !== null) return cached;

  if (!spreadsheetId) throw new Error("spreadsheetId indefinido");
  if (!sheetNameBp) throw new Error("sheetNameBp indefinido");
  if (!chatId) throw new Error("chatId indefinido");

  // A:ZZ para apanhar colunas tipo AN (DEPARTAMENTOS)
  const range = `'${sheetNameBp}'!A:ZZ`;
  const rows = await readRange_v1(spreadsheetId, range);

  const out = {
    firstName: "",
    fullName: "",
    isColaborador: false,
    deptList: [],
    deptFlags: {},
  };

  if (!rows || rows.length < 2) {
    cacheSet(key, out, cacheSeconds);
    return out;
  }

  const headerRow = rows[0] || [];
  const headerUp = headerUpper_v1(headerRow);

  const idxTelefone = findHeaderIndex_v1(headerRow, ["TELEFONE"]);
  const idxNumberWp = findHeaderIndex_v1(headerRow, [
    "NUMBER_WHATSAPP",
    "NUMBER WHATSAPP",
    "WHATSAPP",
    "WHATSAPP_NUMBER",
  ]);

  const idxNome = findHeaderIndex_v1(headerRow, [
    "NOME",
    "NOME COMPLETO",
    "NOME_DO_COLABORADOR",
    "NOME DO COLABORADOR",
    "FULLNAME",
    "FULL NAME",
  ]);

  const idxColab = findHeaderIndex_v1(headerRow, [
    "ISCOLABORADOR",
    "IS_COLABORADOR",
    "COLABORADOR",
    "COLAB",
    "IS_COLAB",
    "DEPARTAMENTOS",
    "DEPARTAMENTO",
  ]);

  if (idxTelefone < 0 && idxNumberWp < 0) {
    throw new Error(
      `[BP_LOOKUP] Cabeçalho sem telefone. Esperado [TELEFONE] ou [NUMBER_WHATSAPP]. sheet=${sheetNameBp}`
    );
  }

  const chatNum = chatIdToNumber_v1(chatId);

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];

    const telA = idxTelefone >= 0 ? onlyDigits_v1(row[idxTelefone]) : "";
    const telB = idxNumberWp >= 0 ? onlyDigits_v1(row[idxNumberWp]) : "";

    if (!telA && !telB) continue;

    if (telA === chatNum || telB === chatNum) {
      // fullName + firstName
      const nome = idxNome >= 0 ? String(row[idxNome] || "").trim() : "";
      if (nome) {
        out.fullName = nome;
        out.firstName = nome.split(/\s+/)[0].trim();
      }

      // isColaborador
      if (idxColab >= 0) out.isColaborador = toBool_v1(row[idxColab]);

      // Departamentos D.* (apenas os true)
      const depts = [];
      for (let c = 0; c < headerUp.length; c++) {
        const h = headerUp[c];
        if (!h) continue;

        if (h.startsWith("D.")) {
          const deptName = stripDeptPrefix_v1(h);
          if (!deptName) continue;

          if (toBool_v1(row[c]) === true) {
            depts.push(deptName);
            out.deptFlags[deptName] = true;
          }
        }
      }

      out.deptList = depts;
      break;
    }
  }

  cacheSet(key, out, cacheSeconds);
  return out;
}

module.exports = { getFirstNameByChatId, getBpContextByChatId };