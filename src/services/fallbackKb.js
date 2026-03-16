//###################################################################################
// src/services/fallbackKb.js
//###################################################################################
"use strict";

const { readRange } = require("./sheets");

//###################################################################################
// Cache simples por sheet
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
  cache.set(key, { val, exp: Date.now() + (ttlSeconds || 60) * 1000 });
}

//###################################################################################
// Helpers de cabeçalho
//###################################################################################
function stripBom(v) {
  return String(v || "").replace(/^\uFEFF/, "");
}

function normHeaderKey_v1(h) {
  return stripBom(h)
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]/g, "");
}

function findHeaderIndexByNorm_v1(headers, wantedNormKey) {
  const W = String(wantedNormKey || "").toUpperCase();
  for (let i = 0; i < (headers || []).length; i++) {
    if (normHeaderKey_v1(headers[i]) === W) return i;
  }
  return -1;
}

function parseBoolLoose_v1(v, defVal) {
  const t = String(v ?? "").trim().toLowerCase();
  if (!t) return Boolean(defVal);
  return t === "true" || t === "1" || t === "sim" || t === "yes";
}

//###################################################################################
// Public: regras do KB (compatível com router.js)
//###################################################################################
async function getFallbackKbRules_v1({ spreadsheetId, sheetName, cacheSeconds }) {
  const key = `fallbackkb:v1:${spreadsheetId}:${sheetName}`;
  const cached = cacheGet(key);
  if (cached !== null) return cached;

  if (!spreadsheetId) throw new Error("spreadsheetId indefinido");
  if (!sheetName) throw new Error("sheetName indefinido");

  const values = await readRange(spreadsheetId, `'${sheetName}'!A:ZZ`);
  if (!values || values.length < 2) {
    const empty = [];
    cacheSet(key, empty, cacheSeconds);
    return empty;
  }

  const header = values[0] || [];

  const idxAtivo = findHeaderIndexByNorm_v1(header, "ATIVO");
  const idxMatchType = findHeaderIndexByNorm_v1(header, "MATCHTYPE");
  const idxChave = findHeaderIndexByNorm_v1(header, "CHAVE");
  const idxResposta = findHeaderIndexByNorm_v1(header, "RESPOSTA");

  if (idxMatchType < 0 || idxChave < 0 || idxResposta < 0) {
    throw new Error(`[FALLBACK_KB] Cabeçalho inválido. Esperado: MATCH_TYPE, CHAVE, RESPOSTA. sheet=${sheetName}`);
  }

  const rules = [];

  for (let r = 1; r < values.length; r++) {
    const row = values[r] || [];

    const ativo = idxAtivo >= 0 ? parseBoolLoose_v1(row[idxAtivo], true) : true;
    if (!ativo) continue;

    const matchType = String(row[idxMatchType] ?? "").trim();
    const chave = String(row[idxChave] ?? "").trim();
    const resposta = String(row[idxResposta] ?? "").trim();

    if (!matchType || !chave || !resposta) continue;

    rules.push({
      matchType,
      chave,
      resposta,

      // aliases (compat)
      MATCH_TYPE: matchType,
      CHAVE: chave,
      RESPOSTA: resposta,

      reply: resposta,
      __rowNum: r + 1,
    });
  }

  cacheSet(key, rules, cacheSeconds);
  return rules;
}

module.exports = { getFallbackKbRules_v1 };