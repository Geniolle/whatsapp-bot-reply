//###################################################################################
// src/services/responsesStore.js - VERSÃO CLEAN ARCHITECTURE (CACHE E LEITURA BLINDADOS)
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

function stripBom(v) {
  return String(v || "").replace(/^\uFEFF/, "");
}

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

async function getRules(spreadsheetId, sheetNameResp, cacheSeconds) {
  const key = `rules:v7:${spreadsheetId}:${sheetNameResp}`;
  const cached = cacheGet(key);
  if (cached !== null) return cached;

  if (!spreadsheetId) throw new Error("spreadsheetId indefinido");
  if (!sheetNameResp) throw new Error("sheetNameResp indefinido");

  const values = await readRange(spreadsheetId, `'${sheetNameResp}'!A:ZZ`);
  if (!values || values.length < 2) {
    const empty = [];
    cacheSet(key, empty, cacheSeconds);
    return empty;
  }

  const header = values[0] || [];

  const idxIdTable = findHeaderIndexByNorm_v1(header, "IDTABLE", "ID");
  const idxAtivo = findHeaderIndexByNorm_v1(header, "ATIVO", "ACTIVE");
  const idxMatchType = findHeaderIndexByNorm_v1(header, "MATCHTYPE", "TIPO");
  const idxChave = findHeaderIndexByNorm_v1(header, "CHAVE", "KEY");
  const idxResposta = findHeaderIndexByNorm_v1(header, "RESPOSTA", "REPLY");
  const idxProcesso = findHeaderIndexByNorm_v1(header, "PROCESSO", "PROCESS", "ACAO");
  const idxDepartamento = findHeaderIndexByNorm_v1(header, "DEPARTAMENTO", "DEPARTAMENTOS", "DEPTS");

  const rules = [];

  for (let r = 1; r < values.length; r++) {
    const row = values[r] || [];

    const ativo = idxAtivo >= 0 ? parseBoolLoose_v1(row[idxAtivo], true) : true;
    if (!ativo) continue; // Pula se estiver inativo

    const matchType = String(row[idxMatchType] ?? "").trim();
    const chave = String(row[idxChave] ?? "").trim();
    const resposta = String(row[idxResposta] ?? "").trim();
    const idTable = idxIdTable >= 0 ? String(row[idxIdTable] ?? "").trim() : "";

    // RADAR: Se o cabeçalho "PROCESSO" falhar devido a colunas vazias, varre a linha!
    let processo = idxProcesso >= 0 ? String(row[idxProcesso] ?? "").trim() : "";
    if (!processo) {
        const procCell = row.find(c => String(c).trim().startsWith("__APP_"));
        if (procCell) processo = String(procCell).trim();
    }

    // Se a linha não tiver ID_TABLE, nem CHAVE, nem PROCESSO, não tem utilidade nenhuma e ignoramos.
    if (!idTable && !chave && !processo) continue;

    let departamento = idxDepartamento >= 0 ? String(row[idxDepartamento] ?? "").trim() : "";
    
    // Fallback agressivo para o Departamento (Coluna K é o índice 10)
    if (!departamento && row.length > 10) {
        const colK = String(row[10] || "").trim();
        if (colK.length > 2 && !colK.startsWith("__")) departamento = colK;
    }

    rules.push({
      matchType, chave, reply: resposta,
      ID_TABLE: idTable, PROCESSO: processo, DEPARTAMENTO: departamento,
      __rowNum: r + 1,
    });
  }

  cacheSet(key, rules, cacheSeconds);
  return rules;
}

module.exports = { getRules };