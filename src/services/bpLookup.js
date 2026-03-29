//###################################################################################
// src/services/bpLookup.js - VERSÃO COM RBAC + IDENTIFICAÇÃO DE MANAGERS
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

function normalizeText_v1(s) {
  return stripBom(s)
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function normalizeDeptKey_v1(s) {
  let t = normalizeText_v1(s);
  t = t.replace(/^D\.\s*/i, "").replace(/^D\s+/i, "").trim();
  return t;
}

function findHeaderIndex_v1(headers, wanted) {
  const H = (headers || []).map((h) => normalizeText_v1(h));
  const W = (wanted || []).map((w) => normalizeText_v1(w));
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

function parseDeptListCell_v1(v) {
  return String(v || "")
    .split(/[;,|]+/g)
    .map((x) => normalizeDeptKey_v1(x))
    .filter(Boolean);
}

//###################################################################################
// Logger helpers
//###################################################################################
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
// Manager lookup
//###################################################################################
async function getManagerDeptsByChatId_v1({
  spreadsheetId,
  sheetNameManager,
  chatId,
}) {
  if (!sheetNameManager) return [];

  const range = `'${sheetNameManager}'!A:ZZ`;
  const rows = await readRange_v1(spreadsheetId, range);
  if (!rows || rows.length < 2) return [];

  const headerRow = rows[0] || [];
  const idxTelefone = findHeaderIndex_v1(headerRow, ["TELEFONE"]);
  const idxNumberWp = findHeaderIndex_v1(headerRow, ["NUMBER_WHATSAPP", "NUMBER WHATSAPP", "WHATSAPP", "WHATSAPP_NUMBER"]);
  const idxDepts = findHeaderIndex_v1(headerRow, ["DEPARTAMENTOS", "DEPARTAMENTO", "DEPTS"]);

  if (idxDepts < 0) return [];

  if (idxTelefone < 0 && idxNumberWp < 0) {
    throw new Error(`[BP_LOOKUP] Cabeçalho sem telefone na sheet=${sheetNameManager}`);
  }

  const chatNum = chatIdToNumber_v1(chatId);

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const telA = idxTelefone >= 0 ? onlyDigits_v1(row[idxTelefone]) : "";
    const telB = idxNumberWp >= 0 ? onlyDigits_v1(row[idxNumberWp]) : "";

    if (!telA && !telB) continue;

    if (telA === chatNum || telB === chatNum) {
      return parseDeptListCell_v1(row[idxDepts]);
    }
  }

  return [];
}

function mergeDepartmentRoles_v1(deptsDetalhado, managerDeptKeys) {
  const managerSet = new Set((managerDeptKeys || []).map((d) => normalizeDeptKey_v1(d)));
  const merged = [];
  const seen = new Set();

  for (const item of deptsDetalhado || []) {
    const nomeOriginal = String(item?.nome || "").trim();
    if (!nomeOriginal) continue;

    const deptKey = normalizeDeptKey_v1(nomeOriginal);
    const isManagerDept = managerSet.has(deptKey);
    const nivel = isManagerDept ? "MANAGER" : String(item?.nivel || "MEMBRO").trim().toUpperCase();

    merged.push({
      nome: nomeOriginal,
      nivel,
      isManager: isManagerDept,
    });

    seen.add(deptKey);
  }

  for (const deptKey of managerSet) {
    if (seen.has(deptKey)) continue;

    merged.push({
      nome: deptKey,
      nivel: "MANAGER",
      isManager: true,
    });
  }

  return merged;
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
  const sheetNameManager = process.env.SHEET_NAME_ID_MANAGER || "ID_MANAGER";
  const key = `bpacc:v10:${spreadsheetId}:${sheetNameBp}:${sheetNameManager}:${chatId}`;

  if (debugRowLog !== true) {
    const cached = cacheGet(key);
    if (cached !== null) return cached;
  }

  if (!spreadsheetId) throw new Error("spreadsheetId indefinido");
  if (!sheetNameBp) throw new Error("sheetNameBp indefinido");
  if (!chatId) throw new Error("chatId indefinido");

  const range = `'${sheetNameBp}'!A:ZZ`;
  const rows = await readRange_v1(spreadsheetId, range);

  const empty = {
    fullName: "",
    isColab: false,
    deptsAccess: false,
    depts: [],
    deptsDetalhado: [],
    managerDepts: [],
    isManager: false,
  };

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

  const deptCols = [];
  for (let i = 0; i < headerRow.length; i++) {
    const h = normalizeHeaderName_v1(headerRow[i]);
    if (isDeptHeader_v1(h)) {
      deptCols.push({ idx: i, name: deptNameFromHeader_v1(h) });
    }
  }

  const chatNum = chatIdToNumber_v1(chatId);

  let result = empty;

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

      const depts = [];
      const deptsDetalhadoBase = [];

      for (const c of deptCols) {
        const valRaw = row[c.idx] || "";
        const v = stripBom(valRaw).trim();

        if (v) {
          const lowerV = v.toLowerCase();
          if (["nao", "não", "false", "0", "n", "falso", "-"].includes(lowerV)) continue;

          let nivel = "MEMBRO";
          if (!["sim", "true", "1", "y", "s", "x", "ok", "verdadeiro", "v"].includes(lowerV)) {
            nivel = v.toUpperCase();
          }

          if (c.name) {
            depts.push(c.name);
            deptsDetalhadoBase.push({
              nome: c.name,
              nivel,
              isManager: false,
            });
          }
        }
      }

      const managerDepts = await getManagerDeptsByChatId_v1({
        spreadsheetId,
        sheetNameManager,
        chatId,
      });

      const deptsDetalhado = mergeDepartmentRoles_v1(deptsDetalhadoBase, managerDepts);
      const isManager = Array.isArray(managerDepts) && managerDepts.length > 0;

      const allDeptNames = deptsDetalhado.map((d) => d.nome);

      const isColab =
        colabFlag ||
        type === "COLAB" ||
        access === "COLAB" ||
        type.startsWith("COLAB") ||
        access.startsWith("COLAB") ||
        deptsAccess === true ||
        allDeptNames.length > 0 ||
        isManager;

      result = {
        fullName,
        isColab,
        deptsAccess,
        depts: allDeptNames,
        deptsDetalhado,
        managerDepts,
        isManager,
      };

      if (isColab) {
        const deptsLog = deptsDetalhado.length > 0
          ? deptsDetalhado.map((d) => `${d.nome} [${d.nivel}]`).join(", ")
          : "Sem departamentos atribuídos";

        const managersLog = managerDepts.length > 0
          ? managerDepts.join(", ")
          : "Nenhum";

        console.log(`\n---------------------------------------------------------`);
        console.log(`[BP_LOOKUP] 🟢 COLAB IDENTIFICADO: ${fullName}`);
        console.log(`[BP_LOOKUP] 🏢 PERTENCE A: ${deptsLog}`);
        console.log(`[BP_LOOKUP] 👔 MANAGER DE: ${managersLog}`);
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