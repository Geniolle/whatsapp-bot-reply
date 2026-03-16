// src/services/appEnsaio.js
"use strict";

const { readRange } = require("./sheets");

//###################################################################################
// Helpers
//###################################################################################
function findHeaderIndex_v1(headers, wanted) {
  const H = (headers || []).map((h) => String(h || "").trim().toUpperCase());
  const W = (wanted || []).map((w) => String(w || "").trim().toUpperCase());
  for (let i = 0; i < H.length; i++) {
    if (W.includes(H[i])) return i;
  }
  return -1;
}

function parsePtDate_v1(v) {
  // aceita:
  // - Date
  // - número (timestamp / serial não garantido)
  // - "DD/MM/YYYY" (opcional " HH:MM")
  if (v instanceof Date && !isNaN(v.getTime())) return v;

  if (typeof v === "number") {
    // Heurística: se parece timestamp em ms
    if (v > 10_000_000_000) {
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d;
    }
    // Se vier como "serial" (Sheets), é difícil garantir sem timezone/base.
    // Tentamos tratar como dias desde 1899-12-30 (comum em Sheets/Excel).
    if (v > 1000 && v < 100000) {
      const base = new Date(Date.UTC(1899, 11, 30));
      const d = new Date(base.getTime() + v * 24 * 60 * 60 * 1000);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  }

  const s = String(v || "").trim();
  if (!s) return null;

  // DD/MM/YYYY ...
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yyyy = Number(m[3]);
    const hh = m[4] != null ? Number(m[4]) : 0;
    const mi = m[5] != null ? Number(m[5]) : 0;
    const d = new Date(yyyy, mm - 1, dd, hh, mi, 0, 0);
    return isNaN(d.getTime()) ? null : d;
  }

  // fallback ISO parse
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

//###################################################################################
// Public: obter ensaio mais recente
//###################################################################################
async function getLatestEnsaio_v1({ spreadsheetId, sheetNameEnsaio }) {
  if (!spreadsheetId) throw new Error("spreadsheetId indefinido");
  if (!sheetNameEnsaio) throw new Error("sheetNameEnsaio indefinido");

  const values = await readRange(spreadsheetId, `'${sheetNameEnsaio}'!A:Z`);
  if (!values || values.length < 2) return null;

  const header = values[0] || [];
  const idxEnsaio = findHeaderIndex_v1(header, ["ENSAIO", "DATA", "DATA_ENSAIO", "DATA ENSAIO"]);
  const idxHorario = findHeaderIndex_v1(header, ["HORARIO", "HORÁRIO", "HORA", "HORÁRIO"]);
  const idxResp = findHeaderIndex_v1(header, ["RESPONSÁVEL", "RESPONSAVEL", "RESPONSAVEL", "RESP", "RESPONSAVEL_ENSAIO"]);

  if (idxEnsaio < 0) {
    throw new Error(`[APP_ENSAIO] Coluna 'ENSAIO' não encontrada em ${sheetNameEnsaio}.`);
  }

  let best = null;

  for (let r = 1; r < values.length; r++) {
    const row = values[r] || [];
    const d = parsePtDate_v1(row[idxEnsaio]);
    if (!d) continue;

    if (!best || d.getTime() > best._time) {
      best = {
        ensaioRaw: row[idxEnsaio],
        ensaioDate: d,
        horario: idxHorario >= 0 ? String(row[idxHorario] || "").trim() : "",
        responsavel: idxResp >= 0 ? String(row[idxResp] || "").trim() : "",
        _time: d.getTime(),
      };
    }
  }

  if (!best) return null;

  return {
    ENSAIO: formatPtDate_v1(best.ensaioDate) || String(best.ensaioRaw || "").trim(),
    HORARIO: best.horario,
    "RESPONSÁVEL": best.responsavel,
  };
}

module.exports = { getLatestEnsaio_v1 };