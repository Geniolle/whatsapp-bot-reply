//###################################################################################
// src/services/appEscalaEquipe.js - ESCALA DA EQUIPA POR DEPARTAMENTO MANAGER
//###################################################################################
"use strict";

const { readRange } = require("./sheets");

//###################################################################################
// Normalização
//###################################################################################
function stripBom(v) {
  return String(v || "").replace(/^\uFEFF/, "");
}

function normHeader(v) {
  return stripBom(v)
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]/g, "");
}

function normText(v) {
  return stripBom(v).trim().replace(/\s+/g, " ");
}

function normDeptKey(v) {
  return normText(v)
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^D\.\s*/i, "")
    .replace(/^D\s+/i, "")
    .trim();
}

function findHeaderIndex(headers, ...wantedNormKeys) {
  const wanted = wantedNormKeys.map((x) => String(x || "").trim().toUpperCase());
  for (let i = 0; i < (headers || []).length; i++) {
    const h = normHeader(headers[i]);
    if (wanted.includes(h)) return i;
  }
  return -1;
}

//###################################################################################
// Datas
//###################################################################################
function parseDateValue(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return v;

  if (typeof v === "number") {
    if (v > 10_000_000_000) {
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d;
    }

    if (v > 1000 && v < 100000) {
      const base = new Date(Date.UTC(1899, 11, 30));
      const d = new Date(base.getTime() + v * 24 * 60 * 60 * 1000);
      return isNaN(d.getTime()) ? null : d;
    }
  }

  const s = normText(v);
  if (!s) return null;

  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yyyy = Number(m[3]);
    const d = new Date(yyyy, mm - 1, dd, 0, 0, 0, 0);
    return isNaN(d.getTime()) ? null : d;
  }

  const d2 = new Date(s);
  return isNaN(d2.getTime()) ? null : d2;
}

function formatDatePt(v) {
  const d = parseDateValue(v);
  if (!d) return normText(v);

  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = String(d.getFullYear());

  return `${dd}/${mm}/${yyyy}`;
}

function todayMidnight() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

function monthNamePt(monthNumber) {
  const names = [
    "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"
  ];
  return names[(monthNumber || 1) - 1] || "";
}

//###################################################################################
// Funções do departamento em BP FUNÇÃO
//###################################################################################
async function getDepartmentFunctions_v1({
  spreadsheetId,
  sheetNameFuncoes,
  departamento,
}) {
  const values = await readRange(spreadsheetId, `'${sheetNameFuncoes}'!A:ZZ`);
  if (!values || values.length < 2) {
    throw new Error(`[APP_ESCALA_EQUIPE] A aba ${sheetNameFuncoes} está vazia ou sem dados.`);
  }

  const header = values[0] || [];
  const deptKey = normDeptKey(departamento);
  const targetHeaderNorm = `FUNC${deptKey}`.replace(/[^A-Z0-9]/g, "");

  let targetIdx = -1;
  for (let i = 0; i < header.length; i++) {
    const hNorm = normHeader(header[i]);
    if (hNorm === targetHeaderNorm) {
      targetIdx = i;
      break;
    }
  }

  if (targetIdx < 0) {
    throw new Error(`[APP_ESCALA_EQUIPE] Coluna da função do departamento não encontrada para ${departamento}.`);
  }

  const set = new Set();

  for (let r = 1; r < values.length; r++) {
    const row = values[r] || [];
    const funcao = normText(row[targetIdx]);
    if (funcao) set.add(funcao);
  }

  return Array.from(set);
}

//###################################################################################
// Leitura de BP ESCALA
//###################################################################################
async function getTeamScaleItems_v1({
  spreadsheetId,
  sheetNameEscala,
  funcoesDepartamento,
  periodo,
}) {
  const values = await readRange(spreadsheetId, `'${sheetNameEscala}'!A:ZZ`);
  if (!values || values.length < 2) {
    return [];
  }

  const header = values[0] || [];

  const idxEmail = findHeaderIndex(header, "EMAIL", "E-MAIL");
  const idxData = findHeaderIndex(header, "DATA");
  const idxDia = findHeaderIndex(header, "DIA");
  const idxNome = findHeaderIndex(header, "NOME");

  if (idxEmail < 0 || idxData < 0 || idxDia < 0 || idxNome < 0) {
    throw new Error(`[APP_ESCALA_EQUIPE] Cabeçalhos obrigatórios não encontrados na aba ${sheetNameEscala}.`);
  }

  const servicoCols = [];
  for (let n = 1; n <= 10; n++) {
    const idx = findHeaderIndex(header, `SERVICO${n}`);
    if (idx >= 0) servicoCols.push(idx);
  }

  if (!servicoCols.length) {
    throw new Error(`[APP_ESCALA_EQUIPE] Colunas SERVICO1..SERVICO10 não encontradas na aba ${sheetNameEscala}.`);
  }

  const funcoesSet = new Set((funcoesDepartamento || []).map((f) => normText(f).toUpperCase()));
  const rows = [];

  for (let r = 1; r < values.length; r++) {
    const row = values[r] || [];
    const dataObj = parseDateValue(row[idxData]);
    if (!dataObj) continue;

    const servicosDaLinha = servicoCols
      .map((idx) => normText(row[idx]))
      .filter(Boolean);

    if (!servicosDaLinha.length) continue;

    const matchedFunctions = servicosDaLinha.filter((s) => funcoesSet.has(s.toUpperCase()));
    if (!matchedFunctions.length) continue;

    rows.push({
      email: normText(row[idxEmail]),
      nome: normText(row[idxNome]),
      dataObj,
      data: formatDatePt(row[idxData]),
      dia: normText(row[idxDia]),
      funcoes: matchedFunctions,
    });
  }

  if (!rows.length) return [];

  if (periodo?.type === "NEXT_CULTO") {
    const hoje = todayMidnight();
    const futureRows = rows
      .filter((x) => x.dataObj.getTime() >= hoje.getTime())
      .sort((a, b) => a.dataObj.getTime() - b.dataObj.getTime());

    if (!futureRows.length) return [];

    const nextTime = futureRows[0].dataObj.getTime();
    return futureRows.filter((x) => x.dataObj.getTime() === nextTime);
  }

  if (periodo?.type === "DATE" && periodo?.date) {
    const target = parseDateValue(periodo.date);
    if (!target) return [];
    return rows.filter((x) => x.dataObj.getTime() === target.getTime());
  }

  if (periodo?.type === "MONTH" && periodo?.month && periodo?.year) {
    return rows.filter(
      (x) =>
        x.dataObj.getMonth() + 1 === Number(periodo.month) &&
        x.dataObj.getFullYear() === Number(periodo.year)
    );
  }

  return rows.sort((a, b) => a.dataObj.getTime() - b.dataObj.getTime());
}

//###################################################################################
// Formatação
//###################################################################################
function formatTeamScaleText_v1({
  departamento,
  periodoLabel,
  items,
}) {
  if (!Array.isArray(items) || !items.length) {
    return `Não encontrei pessoas escaladas para o departamento *${departamento}* no período selecionado.`;
  }

  const lines = [];
  lines.push(`📋 *Escala da equipa — ${departamento}*`);
  if (periodoLabel) {
    lines.push(`🗓️ *Período:* ${periodoLabel}`);
  }

  let currentKey = "";
  for (const item of items) {
    const groupKey = `${item.data}||${item.dia}`;
    if (groupKey !== currentKey) {
      currentKey = groupKey;
      lines.push("");
      lines.push(`*${item.data}* (${item.dia})`);
    }

    lines.push(`- ${item.nome || "Sem nome"} — ${item.funcoes.join(", ")}`);
  }

  return lines.join("\n");
}

//###################################################################################
// API principal
//###################################################################################
async function getEscalaEquipePorDepartamento_v1({
  spreadsheetId,
  sheetNameFuncoes,
  sheetNameEscala,
  departamento,
  periodo,
}) {
  const funcoesDepartamento = await getDepartmentFunctions_v1({
    spreadsheetId,
    sheetNameFuncoes,
    departamento,
  });

  const items = await getTeamScaleItems_v1({
    spreadsheetId,
    sheetNameEscala,
    funcoesDepartamento,
    periodo,
  });

  let periodoLabel = "Todos";
  if (periodo?.type === "NEXT_CULTO") {
    periodoLabel = "Próximo culto";
  } else if (periodo?.type === "DATE") {
    periodoLabel = formatDatePt(periodo.date);
  } else if (periodo?.type === "MONTH") {
    periodoLabel = `${monthNamePt(Number(periodo.month))}/${periodo.year}`;
  }

  return formatTeamScaleText_v1({
    departamento,
    periodoLabel,
    items,
  });
}

module.exports = {
  getDepartmentFunctions_v1,
  getTeamScaleItems_v1,
  formatTeamScaleText_v1,
  getEscalaEquipePorDepartamento_v1,
};