//###################################################################################
// src/services/responsesStore.js
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
// Normalização de cabeçalhos
//###################################################################################
function stripBom(v) {
  return String(v || "").replace(/^\uFEFF/, "");
}

function normHeaderKey_v1(h) {
  // "MATCH_TYPE" -> "MATCHTYPE", "ID_TABLE" -> "IDTABLE", etc.
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
// Public: getRules (COMPAT total com router.js)
//###################################################################################
async function getRules(spreadsheetId, sheetNameResp, cacheSeconds) {
  const key = `rules:v4:${spreadsheetId}:${sheetNameResp}`;
  const cached = cacheGet(key);
  if (cached !== null) return cached;

  if (!spreadsheetId) throw new Error("spreadsheetId indefinido");
  if (!sheetNameResp) throw new Error("sheetNameResp indefinido");

  // LER desde A para incluir ID_TABLE
  const values = await readRange(spreadsheetId, `'${sheetNameResp}'!A:ZZ`);
  if (!values || values.length < 2) {
    const empty = [];
    cacheSet(key, empty, cacheSeconds);
    return empty;
  }

  const header = values[0] || [];

  // índices robustos
  const idxIdTable = findHeaderIndexByNorm_v1(header, "IDTABLE");
  const idxAtivo = findHeaderIndexByNorm_v1(header, "ATIVO");
  const idxAccess = findHeaderIndexByNorm_v1(header, "ACCESS");
  const idxPrioridade = findHeaderIndexByNorm_v1(header, "PRIORIDADE");
  const idxMatchType = findHeaderIndexByNorm_v1(header, "MATCHTYPE");
  const idxChave = findHeaderIndexByNorm_v1(header, "CHAVE");
  const idxResposta = findHeaderIndexByNorm_v1(header, "RESPOSTA");
  const idxProcesso = findHeaderIndexByNorm_v1(header, "PROCESSO");
  const idxDepartamento = findHeaderIndexByNorm_v1(header, "DEPARTAMENTO");

  // mínimos para funcionar
  if (idxMatchType < 0 || idxChave < 0 || idxResposta < 0) {
    throw new Error(
      `[RESPONSES] Cabeçalho inválido. Esperado: MATCH_TYPE, CHAVE, RESPOSTA. sheet=${sheetNameResp}`
    );
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

    const idTable = idxIdTable >= 0 ? String(row[idxIdTable] ?? "").trim() : "";
    const access = idxAccess >= 0 ? String(row[idxAccess] ?? "").trim() : "PUBLIC";
    const prioridade = idxPrioridade >= 0 ? Number(row[idxPrioridade] ?? 0) : 0;

    const processo = idxProcesso >= 0 ? String(row[idxProcesso] ?? "").trim() : "";
    const departamento = idxDepartamento >= 0 ? String(row[idxDepartamento] ?? "").trim() : "";

    // OBJETO com TODOS os aliases (não quebra router antigo nem novo)
    rules.push({
      // formato “novo” (muitos routers usam isto)
      matchType,
      chave,
      reply: resposta,

      // formato “planilha” (alguns routers usam isto)
      MATCH_TYPE: matchType,
      CHAVE: chave,
      RESPOSTA: resposta,

      // formato “minúsculo”
      match_type: matchType,
      resposta: resposta,

      // controlo
      access,
      prioridade,

      // auditoria
      ID_TABLE: idTable,
      PROCESSO: processo,
      DEPARTAMENTO: departamento,
      __rowNum: r + 1,
    });
  }

  cacheSet(key, rules, cacheSeconds);
  return rules;
}

module.exports = { getRules };