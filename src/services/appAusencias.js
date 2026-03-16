"use strict";

const { readRange } = require("./sheets");

//###################################################################################
// Normalizações
//###################################################################################
function normHeader_v1(s) {
  return String(s || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normName_v1(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function findHeaderIndex_v1(headers, expectedExact) {
  const H = (headers || []).map(normHeader_v1);
  const W = (expectedExact || []).map(normHeader_v1);
  for (let i = 0; i < H.length; i++) {
    if (W.includes(H[i])) return i;
  }
  return -1;
}

function parsePtDate_v1(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return v;

  if (typeof v === "number") {
    // timestamp ms
    if (v > 10_000_000_000) {
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d;
    }
    // serial days (Sheets/Excel)
    if (v > 1000 && v < 100000) {
      const base = new Date(Date.UTC(1899, 11, 30));
      const d = new Date(base.getTime() + v * 24 * 60 * 60 * 1000);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  }

  const s = String(v || "").trim();
  if (!s) return null;

  // DD/MM/YYYY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
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

function formatPtDate_v1(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return "";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = String(d.getFullYear());
  return `${dd}/${mm}/${yyyy}`;
}

function todayMidnight_v1() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

//###################################################################################
// Public: buscar ausências por FullName
// Colunas esperadas:
// [DATA INÍCIO, DATA FIM, NOME DO COLABORADOR, MOTIVO DA AUSÊNCIA]
//###################################################################################
async function getAusenciasByFullName_v1({
  spreadsheetId,
  sheetNameAusencias,
  fullName,
  maxUpcoming = 5,
}) {
  const values = await readRange(spreadsheetId, `'${sheetNameAusencias}'!A:ZZ`);
  if (!values || values.length < 2) return { upcoming: [], last: null };

  const header = values[0] || [];

  const idxIni = findHeaderIndex_v1(header, ["DATA INÍCIO", "DATA INICIO"]);
  const idxFim = findHeaderIndex_v1(header, ["DATA FIM"]);
  const idxNome = findHeaderIndex_v1(header, ["NOME DO COLABORADOR"]);
  const idxMotivo = findHeaderIndex_v1(header, ["MOTIVO DA AUSÊNCIA", "MOTIVO DA AUSENCIA"]);

  if (idxIni < 0 || idxFim < 0 || idxNome < 0 || idxMotivo < 0) {
    throw new Error(
      `[APP_AUSENCIAS] Cabeçalho inválido. Esperado: DATA INÍCIO, DATA FIM, NOME DO COLABORADOR, MOTIVO DA AUSÊNCIA.`
    );
  }

  const target = normName_v1(fullName);
  const today = todayMidnight_v1();

  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r] || [];

    const nomeRow = normName_v1(row[idxNome]);
    if (!nomeRow) continue;
    if (nomeRow !== target) continue;

    const dIni = parsePtDate_v1(row[idxIni]);
    const dFim = parsePtDate_v1(row[idxFim]);

    rows.push({
      ini: dIni,
      fim: dFim,
      motivo: String(row[idxMotivo] || "").trim(),
    });
  }

  const upcomingAll = rows
    .filter((x) => x.ini && x.ini.getTime() >= today.getTime())
    .sort((a, b) => a.ini.getTime() - b.ini.getTime());

  const pastAll = rows
    .filter((x) => x.ini && x.ini.getTime() < today.getTime())
    .sort((a, b) => b.ini.getTime() - a.ini.getTime());

  const upcoming = upcomingAll.slice(0, maxUpcoming).map((x) => ({
    ini: formatPtDate_v1(x.ini),
    fim: x.fim ? formatPtDate_v1(x.fim) : "",
    motivo: x.motivo,
  }));

  const last = pastAll.length
    ? {
        ini: formatPtDate_v1(pastAll[0].ini),
        fim: pastAll[0].fim ? formatPtDate_v1(pastAll[0].fim) : "",
        motivo: pastAll[0].motivo,
      }
    : null;

  return { upcoming, last };
}

//###################################################################################
// Exports
//###################################################################################
module.exports = { getAusenciasByFullName_v1 };