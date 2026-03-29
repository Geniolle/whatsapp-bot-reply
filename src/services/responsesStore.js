//###################################################################################
// src/services/responsesStore.js - LEITURA BLINDADA DAS REGRAS (SEM LOGS DE DEBUG)
//###################################################################################
"use strict";

const { readRange } = require("./sheets");

const cache = new Map();

//###################################################################################
// Cache helpers
//###################################################################################
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
  const ttl = (ttlSeconds !== undefined && ttlSeconds !== null)
    ? Number(ttlSeconds)
    : 60;

  cache.set(key, {
    val,
    exp: Date.now() + ttl * 1000,
  });
}

//###################################################################################
// Normalização
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

//###################################################################################
// Humanização
//###################################################################################
function getAutoTimeOfDay() {
  const h = new Date().getHours();
  if (h >= 5 && h <= 11) return "bom dia";
  if (h >= 12 && h <= 17) return "boa tarde";
  return "boa noite";
}

function buildHumanizedResponse(csvText, userName, timeOfDay) {
  if (!csvText) return "";

  const options = String(csvText)
    .split("||")
    .map((opt) => opt.trim())
    .filter(Boolean);

  if (!options.length) return "";

  let selectedResponse = options[Math.floor(Math.random() * options.length)];
  const actualTimeOfDay = timeOfDay || getAutoTimeOfDay();

  selectedResponse = selectedResponse.replace(
    /\{nome\}/ig,
    userName ? userName : "irmão(ã)"
  );
  selectedResponse = selectedResponse.replace(
    /\{saudacao_tempo\}/ig,
    actualTimeOfDay
  );

  return selectedResponse
    .replace(/\s+!/g, "!")
    .replace(/\s+,/g, ",");
}

//###################################################################################
// Leitura das regras
//###################################################################################
async function getRules(spreadsheetId, sheetNameResp, cacheSeconds) {
  const key = `rules:v10:${spreadsheetId}:${sheetNameResp}`;
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
  const idxChave = findHeaderIndexByNorm_v1(header, "CHAVE");
  const idxResposta = findHeaderIndexByNorm_v1(header, "RESPOSTA", "REPLY");
  const idxProcesso = findHeaderIndexByNorm_v1(header, "PROCESSO", "PROCESS");
  const idxContexto = findHeaderIndexByNorm_v1(header, "CONTEXTO", "CONTEXT");
  const idxDepartamento = findHeaderIndexByNorm_v1(
    header,
    "DEPARTAMENTO",
    "DEPARTAMENTOS"
  );

  const rules = [];

  for (let r = 1; r < values.length; r++) {
    const row = values[r] || [];

    const ativo = idxAtivo >= 0
      ? parseBoolLoose_v1(row[idxAtivo], true)
      : true;

    if (!ativo) continue;

    const idTable = idxIdTable >= 0 ? String(row[idxIdTable] ?? "").trim() : "";
    const chave = idxChave >= 0 ? String(row[idxChave] ?? "").trim() : "";
    const resposta = idxResposta >= 0 ? String(row[idxResposta] ?? "").trim() : "";
    const contexto = idxContexto >= 0 ? String(row[idxContexto] ?? "").trim() : "";

    let processo = idxProcesso >= 0 ? String(row[idxProcesso] ?? "").trim() : "";
    if (!processo && row.length > 7) {
      const colH = String(row[7] || "").trim();
      if (colH) processo = colH;
    }

    let departamento = idxDepartamento >= 0
      ? String(row[idxDepartamento] ?? "").trim()
      : "";

    if (!departamento && row.length > 9) {
      const colJ = String(row[9] || "").trim();
      if (colJ && !colJ.startsWith("__")) departamento = colJ;
    }

    if (!idTable && !chave && !processo && !resposta) continue;

    rules.push({
      ID_TABLE: idTable,
      CHAVE: chave,
      RESPOSTA: resposta,
      PROCESSO: processo,
      CONTEXTO: contexto,
      DEPARTAMENTO: departamento,
    });
  }

  cacheSet(key, rules, cacheSeconds);
  return rules;
}

module.exports = {
  getRules,
  buildHumanizedResponse,
};