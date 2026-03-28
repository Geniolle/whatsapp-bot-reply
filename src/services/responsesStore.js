//###################################################################################
// src/services/responsesStore.js - LEITURA BLINDADA (ÍNDICES ABSOLUTOS)
//###################################################################################
"use strict";

const { readRange } = require("./sheets");

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
  const ttl = (ttlSeconds !== undefined && ttlSeconds !== null) ? Number(ttlSeconds) : 60;
  cache.set(key, { val, exp: Date.now() + ttl * 1000 });
}

function stripBom(v) { return String(v || "").replace(/^\uFEFF/, ""); }

function normHeaderKey_v1(h) {
  return stripBom(h).trim().toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Z0-9]/g, "");
}

function findHeaderIndexByNorm_v1(headers, ...wantedNormKeys) {
  for (let i = 0; i < (headers || []).length; i++) {
    const hNorm = normHeaderKey_v1(headers[i]);
    if (wantedNormKeys.includes(hNorm)) return i;
  }
  return -1;
}

function parseBoolLoose_v1(v, defVal) {
  const t = String(v ?? "").trim().toLowerCase();
  if (!t) return Boolean(defVal);
  return t === "true" || t === "1" || t === "sim" || t === "yes";
}

function getAutoTimeOfDay() {
  const h = new Date().getHours();
  if (h >= 5 && h <= 11) return "bom dia";
  if (h >= 12 && h <= 17) return "boa tarde";
  return "boa noite";
}

function buildHumanizedResponse(csvText, userName, timeOfDay) {
  if (!csvText) return "";
  const options = csvText.split('||').map(opt => opt.trim());
  let selectedResponse = options[Math.floor(Math.random() * options.length)];
  const actualTimeOfDay = timeOfDay || getAutoTimeOfDay();
  selectedResponse = selectedResponse.replace(/{nome}/ig, userName ? userName : "irmão(ã)"); 
  selectedResponse = selectedResponse.replace(/{saudacao_tempo}/ig, actualTimeOfDay);
  return selectedResponse.replace(/\s+!/g, '!').replace(/\s+,/g, ',');
}

async function getRules(spreadsheetId, sheetNameResp, cacheSeconds) {
  const key = `rules:v9:${spreadsheetId}:${sheetNameResp}`;
  const cached = cacheGet(key);
  if (cached !== null) return cached;

  const values = await readRange(spreadsheetId, `'${sheetNameResp}'!A:ZZ`);
  if (!values || values.length < 2) {
    cacheSet(key, [], cacheSeconds);
    return [];
  }

  const header = values[0] || [];
  const idxIdTable = findHeaderIndexByNorm_v1(header, "IDTABLE", "ID");
  const idxAtivo = findHeaderIndexByNorm_v1(header, "ATIVO");
  const idxProcesso = findHeaderIndexByNorm_v1(header, "PROCESSO", "PROCESS");
  const idxDepartamento = findHeaderIndexByNorm_v1(header, "DEPARTAMENTO", "DEPARTAMENTOS");

  const rules = [];

  for (let r = 1; r < values.length; r++) {
    const row = values[r] || [];
    const ativo = idxAtivo >= 0 ? parseBoolLoose_v1(row[idxAtivo], true) : true;
    if (!ativo) continue;

    const idTable = idxIdTable >= 0 ? String(row[idxIdTable] ?? "").trim() : "";
    
    // Leitura à prova de falhas: se falhar pelo cabeçalho, vai pelo índice físico (I = 8, K = 10)
    let processo = idxProcesso >= 0 ? String(row[idxProcesso] ?? "").trim() : "";
    if (!processo && row.length > 8) {
      const colI = String(row[8] || "").trim();
      if (colI.includes("__APP_")) processo = colI;
    }

    let departamento = idxDepartamento >= 0 ? String(row[idxDepartamento] ?? "").trim() : "";
    if (!departamento && row.length > 10) {
      const colK = String(row[10] || "").trim();
      if (colK && !colK.startsWith("__")) departamento = colK;
    }

    rules.push({
      ID_TABLE: idTable,
      PROCESSO: processo,
      DEPARTAMENTO: departamento,
      RESPOSTA: String(row[6] || "").trim(), // Coluna G
      CHAVE: String(row[5] || "").trim()     // Coluna F
    });
  }

  cacheSet(key, rules, cacheSeconds);
  return rules;
}

module.exports = { getRules, buildHumanizedResponse };