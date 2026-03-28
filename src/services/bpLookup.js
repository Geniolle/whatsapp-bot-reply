//###################################################################################
// src/services/bpLookup.js - VERSÃO COM RBAC (Controlo de Acessos e Departamentos)
//###################################################################################
"use strict";

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

//###################################################################################
// Cache simples
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
// Normalização
//###################################################################################
function stripBom(v) {
  return String(v || "").replace(/^\uFEFF/, "");
}

function onlyDigits_v1(s) {
  return String(s || "").replace(/\D+/g, "");
}

function chatIdToNumber_v1(chatId) {
  return onlyDigits_v1(String(chatId || "").split("@")[0]);
}

function findHeaderIndex_v1(headers, wanted) {
  const H = (headers || []).map((h) => stripBom(h).trim().toUpperCase());
  const W = (wanted || []).map((w) => stripBom(w).trim().toUpperCase());
  for (let i = 0; i < H.length; i++) {
    if (W.includes(H[i])) return i;
  }
  return -1;
}

function parseBoolLoose(v) {
  const t = stripBom(v).trim().toLowerCase();
  if (!t) return false;
  return [
    "true", "1", "sim", "yes", "y", "s", "x", "ok", "verdadeiro", "v"
  ].includes(t);
}

function isBooleanLike(v) {
  const t = stripBom(v).trim().toLowerCase();
  if (!t) return false;
  return [
    "true", "false", "1", "0", "sim", "nao", "não", "yes", "no",
    "y", "n", "x", "ok", "verdadeiro", "falso", "v"
  ].includes(t);
}

function parseDeptsSmart(v) {
  const raw = stripBom(v).trim();
  if (!raw) return { deptsAccess: false, depts: [] };

  if (isBooleanLike(raw)) {
    return { deptsAccess: parseBoolLoose(raw), depts: [] };
  }

  const depts = raw
    .split(/[;,|]+/g)
    .map((x) => stripBom(x).trim())
    .filter(Boolean);

  return { deptsAccess: depts.length > 0, depts };
}

//###################################################################################
// Logger helpers
//###################################################################################
function safeCell(v, maxLen) {
  const s = stripBom(v).replace(/\s+/g, " ").trim();
  if (!s) return "";
  const m = Number(maxLen || 140);
  return s.length > m ? s.slice(0, m) + "…" : s;
}

function maskDigits(s) {
  const d = onlyDigits_v1(s);
  if (d.length <= 4) return d;
  return d.slice(0, 2) + "****" + d.slice(-2);
}

function normalizeHeaderName_v1(h) {
  return stripBom(h).replace(/\s+/g, " ").trim();
}

function isDeptHeader_v1(h) {
  const t = String(h || "").trim();
  return /^D\.\s*/i.test(t);
}

function deptNameFromHeader_v1(h) {
  const t = normalizeHeaderName_v1(h);
  return t.replace(/^D\.\s*/i, "").trim();
}

function colToA1(idx) {
    let n = idx + 1;
    let s = "";
    while (n > 0) {
      let m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
}

//###################################################################################
// Google Sheets client
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
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

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
// Public: getAccessByChatId
//###################################################################################
async function getAccessByChatId({
  spreadsheetId,
  sheetNameBp,
  chatId,
  cacheSeconds,
  debugRowLog,
}) {
  const key = `bpacc:v9:${spreadsheetId}:${sheetNameBp}:${chatId}`;

  if (debugRowLog !== true) {
    const cached = cacheGet(key);
    if (cached !== null) return cached;
  }

  if (!spreadsheetId) throw new Error("spreadsheetId indefinido");
  if (!sheetNameBp) throw new Error("sheetNameBp indefinido");
  if (!chatId) throw new Error("chatId indefinido");

  const range = `'${sheetNameBp}'!A:ZZ`;
  const rows = await readRange_v1(spreadsheetId, range);

  const empty = { fullName: "", isColab: false, deptsAccess: false, depts: [], deptsDetalhado: [] };
  if (!rows || rows.length < 2) {
    cacheSet(key, empty, cacheSeconds);
    return empty;
  }

  const headerRow = rows[0];

  const idxTelefone = findHeaderIndex_v1(headerRow, ["TELEFONE"]);
  const idxNumberWp = findHeaderIndex_v1(headerRow, ["NUMBER_WHATSAPP", "NUMBER WHATSAPP", "WHATSAPP", "WHATSAPP_NUMBER"]);
  const idxNome = findHeaderIndex_v1(headerRow, ["NOME", "NOME COMPLETO", "NOME_COMPLETO", "PRIMEIRO NOME", "FIRST_NAME", "FULL_NAME", "NAME"]);
  const idxType = findHeaderIndex_v1(headerRow, ["TYPE", "TIPO"]);
  const idxAccess = findHeaderIndex_v1(headerRow, ["ACCESS", "ACESSO"]);
  const idxColab = findHeaderIndex_v1(headerRow, ["COLAB", "IS_COLAB", "COLABORADOR"]);
  const idxDeptsFlag = findHeaderIndex_v1(headerRow, ["DEPARTAMENTOS", "DEPARTAMENTO", "DEPTS"]);

  if (idxTelefone < 0 && idxNumberWp < 0) {
    throw new Error(`[BP_LOOKUP] Cabeçalho sem telefone na sheet=${sheetNameBp}`);
  }

  // Mapear colunas de departamentos (D.*)
  const deptCols = [];
  for (let i = 0; i < headerRow.length; i++) {
    const h = normalizeHeaderName_v1(headerRow[i]);
    if (isDeptHeader_v1(h)) {
      deptCols.push({ idx: i, name: deptNameFromHeader_v1(h) });
    }
  }

  const chatNum = chatIdToNumber_v1(chatId);

  let result = empty;
  let foundRowIndex = -1;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];

    const telA = idxTelefone >= 0 ? onlyDigits_v1(row[idxTelefone]) : "";
    const telB = idxNumberWp >= 0 ? onlyDigits_v1(row[idxNumberWp]) : "";

    if (!telA && !telB) continue;

    if (telA === chatNum || telB === chatNum) {
      const fullName = idxNome >= 0 ? stripBom(row[idxNome]).trim() : "";
      const type = idxType >= 0 ? stripBom(row[idxType]).trim().toUpperCase() : "";
      const access = idxAccess >= 0 ? stripBom(row[idxAccess]).trim().toUpperCase() : "";
      const colabFlag = idxColab >= 0 ? parseBoolLoose(row[idxColab]) : false;

      const deptsFlagRaw = idxDeptsFlag >= 0 ? row[idxDeptsFlag] : "";
      const { deptsAccess } = idxDeptsFlag >= 0
        ? parseDeptsSmart(deptsFlagRaw)
        : { deptsAccess: false, depts: [] };

      // >>> LÓGICA DE DEPARTAMENTOS INTELIGENTE <<<
      const depts = [];
      const deptsDetalhado = [];

      for (const c of deptCols) {
        const valRaw = row[c.idx] || "";
        const v = stripBom(valRaw).trim();
        
        if (v) {
          const lowerV = v.toLowerCase();
          // Ignora se for "não", "false", "-", etc.
          if (["nao", "não", "false", "0", "n", "falso", "-"].includes(lowerV)) continue;

          // Define o nível: se a pessoa escreveu "sim" ou "x", assume "MEMBRO". Senão, assume o que ela escreveu (ex: "GESTOR")
          let nivel = "MEMBRO";
          if (!["sim", "true", "1", "y", "s", "x", "ok", "verdadeiro", "v"].includes(lowerV)) {
            nivel = v.toUpperCase();
          }

          if (c.name) {
            depts.push(c.name); // Lista simples antiga para retrocompatibilidade
            deptsDetalhado.push({ nome: c.name, nivel: nivel }); // Objeto novo com permissões
          }
        }
      }

      const isColab =
        colabFlag ||
        type === "COLAB" ||
        access === "COLAB" ||
        type.startsWith("COLAB") ||
        access.startsWith("COLAB") ||
        deptsAccess === true ||
        depts.length > 0;

      result = { fullName, isColab, deptsAccess, depts, deptsDetalhado };
      foundRowIndex = r + 1;

      // >>> LOGGER SOLICITADO (Mostra os departamentos e funções) <<<
      if (isColab) {
          const deptsLog = deptsDetalhado.length > 0 
              ? deptsDetalhado.map(d => `${d.nome} [${d.nivel}]`).join(", ") 
              : "Sem departamentos atribuídos";
              
          console.log(`\n---------------------------------------------------------`);
          console.log(`[BP_LOOKUP] 🟢 COLAB IDENTIFICADO: ${fullName}`);
          console.log(`[BP_LOOKUP] 🏢 PERTENCE A: ${deptsLog}`);
          console.log(`---------------------------------------------------------\n`);
      }
      break;
    }
  }

  cacheSet(key, result, cacheSeconds);
  return result;
}

//###################################################################################
// Desativação de Mensagens (Opt-out)
//###################################################################################
async function desativarMensagensWS(spreadsheetId, sheetNameBp, telefone) {
    try {
        const { readSheet, writeCells } = require("./sheets");
        const data = await readSheet(spreadsheetId, sheetNameBp);
        if (!data || data.length < 2) return false;

        const headers = data[0].map(h => stripBom(h).trim().toUpperCase());
        const idxTel = headers.indexOf("TELEFONE");
        const idxNumberWp = headers.indexOf("NUMBER_WHATSAPP");
        const idxMsgWs = headers.indexOf("MENSAGEM WS");

        if (idxMsgWs === -1) {
            console.error(`[BP_LOOKUP] Coluna [MENSAGEM WS] não encontrada na aba ${sheetNameBp}`);
            return false;
        }

        const telBusca = onlyDigits_v1(telefone);

        for (let i = 1; i < data.length; i++) {
            const telA = onlyDigits_v1(data[i][idxTel] || "");
            const telB = onlyDigits_v1(data[i][idxNumberWp] || "");

            if (telA === telBusca || telB === telBusca) {
                const range = `${sheetNameBp}!${colToA1(idxMsgWs)}${i + 1}`;
                await writeCells(spreadsheetId, range, [["FALSE"]]);
                console.log(`[BP_LOOKUP] ✅ Contacto ${telefone} removido da lista (Linha ${i + 1})`);
                return true;
            }
        }
        return false;
    } catch (error) {
        console.error("[BP_LOOKUP] Erro ao desativar mensagens:", error.message);
        return false;
    }
}

//###################################################################################
// Helpers
//###################################################################################
async function getFullNameByChatId({ spreadsheetId, sheetNameBp, chatId, cacheSeconds, debugRowLog }) {
  const acc = await getAccessByChatId({ spreadsheetId, sheetNameBp, chatId, cacheSeconds, debugRowLog });
  return acc.fullName || "";
}

async function getFirstNameByChatId({ spreadsheetId, sheetNameBp, chatId, cacheSeconds, debugRowLog }) {
  const full = await getFullNameByChatId({ spreadsheetId, sheetNameBp, chatId, cacheSeconds, debugRowLog });
  if (!full) return "";
  return String(full).trim().split(/\s+/)[0] || "";
}

module.exports = {
  getAccessByChatId,
  getFullNameByChatId,
  getFirstNameByChatId, 
  desativarMensagensWS
};