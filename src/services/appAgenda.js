//###################################################################################
// src/services/appAgenda.js
//###################################################################################
"use strict";

const { readRange } = require("./sheets");

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
// Helpers: headers dinâmicos
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

function cleanText_v1(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

//###################################################################################
// Datas
//###################################################################################
function pad2(n) {
  return String(n).padStart(2, "0");
}

function parseDate_ddmmyyyy_v1(s) {
  const t = String(s || "").trim();
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;

  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  if (!dd || !mm || !yyyy) return null;

  const d = new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function getTodayInTZ_ymdUTC_v1(timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());

    const y = Number(parts.find((p) => p.type === "year")?.value || "1970");
    const m = Number(parts.find((p) => p.type === "month")?.value || "01");
    const d = Number(parts.find((p) => p.type === "day")?.value || "01");

    return new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  } catch (_) {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  }
}

function endOfMonthUTC_v1(dUtc) {
  const y = dUtc.getUTCFullYear();
  const m = dUtc.getUTCMonth();
  return new Date(Date.UTC(y, m + 1, 0, 0, 0, 0));
}

function weekdayPt_v1(dUtc, timeZone) {
  try {
    const wd = new Intl.DateTimeFormat("pt-PT", { timeZone, weekday: "long" }).format(dUtc);
    return wd.charAt(0).toUpperCase() + wd.slice(1);
  } catch (_) {
    const map = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];
    return map[dUtc.getUTCDay()] || "";
  }
}

function formatDatePt_ddmmyyyy_v1(dUtc) {
  const dd = pad2(dUtc.getUTCDate());
  const mm = pad2(dUtc.getUTCMonth() + 1);
  const yyyy = dUtc.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function parseTimeToHHhMM_v1(s) {
  const t = String(s || "").trim();
  if (!t) return "";
  // aceita "20:30:00", "20:30", "20h30"
  const m = t.match(/^(\d{1,2})[:hH](\d{2})(?::\d{2})?$/);
  if (!m) return cleanText_v1(t);
  const hh = pad2(Number(m[1]));
  const mm = pad2(Number(m[2]));
  return `${hh}h${mm}`;
}

//###################################################################################
// Leitura base
//###################################################################################
async function readAgendaSheet_v1({ spreadsheetId, sheetNameAgenda }) {
  const values = await readRange(spreadsheetId, `'${sheetNameAgenda}'!A:ZZ`);
  if (!values || values.length < 2) return { header: [], rows: [] };
  return { header: values[0] || [], rows: values.slice(1) || [] };
}

function buildAgendaIndexes_v1(header) {
  const idxTipo = findHeaderIndexByNorm_v1(header, "TIPODEAGENDAMENTO");
  const idxOrg = findHeaderIndexByNorm_v1(header, "ORGANIZADOR");
  const idxData = findHeaderIndexByNorm_v1(header, "DATADOAGENDAMENTO");
  const idxHoraIni = findHeaderIndexByNorm_v1(header, "HORADEINICIO");
  const idxTitulo = findHeaderIndexByNorm_v1(header, "TITULODAAGENDA");
  const idxLocal = findHeaderIndexByNorm_v1(header, "LOCALIZACAO");
  const idxMorada = findHeaderIndexByNorm_v1(header, "MORADA");

  if (idxTipo < 0 || idxData < 0 || idxTitulo < 0) {
    throw new Error(
      "[AppAgendaDepartamentos] Cabeçalho inválido. Esperado: TIPO DE AGENDAMENTO, DATA DO AGENDAMENTO, TÍTULO DA AGENDA."
    );
  }

  return { idxTipo, idxOrg, idxData, idxHoraIni, idxTitulo, idxLocal, idxMorada };
}

//###################################################################################
// Assinatura p/ dedupe (normaliza data + hora normalizada + titulo + local + morada)
//###################################################################################
function normSigPart_v1(s) {
  return cleanText_v1(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function buildEventSignature_v1({ dataUtc, horaIni, titulo, localizacao, morada }) {
  const d =
    dataUtc instanceof Date
      ? `${dataUtc.getUTCFullYear()}-${pad2(dataUtc.getUTCMonth() + 1)}-${pad2(dataUtc.getUTCDate())}`
      : "";

  const h = normSigPart_v1(parseTimeToHHhMM_v1(horaIni || "")); // <<< NORMALIZA HORA
  const t = normSigPart_v1(titulo || "");
  const l = normSigPart_v1(localizacao || "");
  const m = normSigPart_v1(morada || "");

  return [d, h, t, l, m].join("|");
}

//###################################################################################
// Agenda NORMAL (até fim do mês)
//###################################################################################
async function getAgendaEventosMes_v1({
  spreadsheetId,
  sheetNameAgenda,
  cacheSeconds = 300,
  timeZone = "Europe/Lisbon",
}) {
  const key = `agenda:mes:v1:${spreadsheetId}:${sheetNameAgenda}`;
  const cached = cacheGet(key);
  if (cached !== null) return cached;

  if (!spreadsheetId) throw new Error("spreadsheetId indefinido");
  if (!sheetNameAgenda) throw new Error("sheetNameAgenda indefinido");

  const { header, rows } = await readAgendaSheet_v1({ spreadsheetId, sheetNameAgenda });
  if (!header.length) {
    cacheSet(key, [], cacheSeconds);
    return [];
  }

  const { idxTipo, idxData, idxHoraIni, idxTitulo, idxLocal, idxMorada } = buildAgendaIndexes_v1(header);

  const todayUtc = getTodayInTZ_ymdUTC_v1(timeZone);
  const endMonthUtc = endOfMonthUTC_v1(todayUtc);

  const out = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];

    const tipo = cleanText_v1(row[idxTipo] ?? "");
    if (tipo.toUpperCase() !== "EVENTO") continue;

    const dataStr = cleanText_v1(row[idxData] ?? "");
    const dUtc = parseDate_ddmmyyyy_v1(dataStr);
    if (!dUtc) continue;

    if (dUtc.getTime() < todayUtc.getTime()) continue;
    if (dUtc.getTime() > endMonthUtc.getTime()) continue;

    out.push({
      dataUtc: dUtc,
      horaIni: idxHoraIni >= 0 ? cleanText_v1(row[idxHoraIni] ?? "") : "",
      titulo: cleanText_v1(row[idxTitulo] ?? ""),
      localizacao: idxLocal >= 0 ? cleanText_v1(row[idxLocal] ?? "") : "",
      morada: idxMorada >= 0 ? cleanText_v1(row[idxMorada] ?? "") : "",
      __rowNum: r + 2,
    });
  }

  out.sort((a, b) => {
    const da = a?.dataUtc?.getTime?.() || 0;
    const db = b?.dataUtc?.getTime?.() || 0;
    if (da !== db) return da - db;
    return String(a?.horaIni || "").localeCompare(String(b?.horaIni || ""), "pt-PT", { sensitivity: "base" });
  });

  cacheSet(key, out, cacheSeconds);
  return out;
}

//###################################################################################
// Agenda DEPARTAMENTOS (>= hoje)
// - Agrupar por ORGANIZADOR
// - Dedupe GLOBAL por assinatura (agora com hora normalizada)
//###################################################################################
async function getAgendaDepartamentos_v1({
  spreadsheetId,
  sheetNameAgenda,
  cacheSeconds = 300,
  timeZone = "Europe/Lisbon",
}) {
  const key = `agenda:depts:v3:${spreadsheetId}:${sheetNameAgenda}`;
  const cached = cacheGet(key);
  if (cached !== null) return cached;

  if (!spreadsheetId) throw new Error("spreadsheetId indefinido");
  if (!sheetNameAgenda) throw new Error("sheetNameAgenda indefinido");

  const { header, rows } = await readAgendaSheet_v1({ spreadsheetId, sheetNameAgenda });
  if (!header.length) {
    const empty = { groups: [], totalEvents: 0 };
    cacheSet(key, empty, cacheSeconds);
    return empty;
  }

  const { idxTipo, idxOrg, idxData, idxHoraIni, idxTitulo, idxLocal, idxMorada } = buildAgendaIndexes_v1(header);

  const todayUtc = getTodayInTZ_ymdUTC_v1(timeZone);

  const byOrg = new Map();
  const seenGlobal = new Set();

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];

    const tipo = cleanText_v1(row[idxTipo] ?? "");
    if (tipo.toUpperCase() !== "EVENTO") continue;

    const dataStr = cleanText_v1(row[idxData] ?? "");
    const dUtc = parseDate_ddmmyyyy_v1(dataStr);
    if (!dUtc) continue;

    if (dUtc.getTime() < todayUtc.getTime()) continue;

    const org = idxOrg >= 0 ? cleanText_v1(row[idxOrg] ?? "") : "";
    const orgKey = org || "Sem Organizador";

    const horaIni = idxHoraIni >= 0 ? cleanText_v1(row[idxHoraIni] ?? "") : "";
    const titulo = cleanText_v1(row[idxTitulo] ?? "");
    const localizacao = idxLocal >= 0 ? cleanText_v1(row[idxLocal] ?? "") : "";
    const morada = idxMorada >= 0 ? cleanText_v1(row[idxMorada] ?? "") : "";

    const sig = buildEventSignature_v1({ dataUtc: dUtc, horaIni, titulo, localizacao, morada });
    if (seenGlobal.has(sig)) continue;
    seenGlobal.add(sig);

    const ev = {
      dataUtc: dUtc,
      horaIni,
      titulo,
      localizacao,
      morada,
      organizador: orgKey,
      __rowNum: r + 2,
    };

    if (!byOrg.has(orgKey)) byOrg.set(orgKey, []);
    byOrg.get(orgKey).push(ev);
  }

  const groups = [];
  for (const [organizador, events] of byOrg.entries()) {
    events.sort((a, b) => {
      const da = a?.dataUtc?.getTime?.() || 0;
      const db = b?.dataUtc?.getTime?.() || 0;
      if (da !== db) return da - db;
      return String(a?.horaIni || "").localeCompare(String(b?.horaIni || ""), "pt-PT", { sensitivity: "base" });
    });
    groups.push({ organizador, events });
  }

  groups.sort((a, b) => a.organizador.localeCompare(b.organizador, "pt-PT", { sensitivity: "base" }));

  const totalEvents = groups.reduce((acc, g) => acc + (g?.events?.length || 0), 0);
  const result = { groups, totalEvents };

  cacheSet(key, result, cacheSeconds);
  return result;
}

//###################################################################################
// Formatação
//###################################################################################
function formatEventoLine_v1(ev, timeZone = "Europe/Lisbon") {
  if (!ev || typeof ev !== "object") return "";

  const dUtc = ev.dataUtc instanceof Date ? ev.dataUtc : null;
  if (!dUtc) return "";

  const ddmmyyyy = formatDatePt_ddmmyyyy_v1(dUtc);
  const wd = weekdayPt_v1(dUtc, timeZone);

  const hora = parseTimeToHHhMM_v1(ev.horaIni);
  const titulo = cleanText_v1(ev.titulo) || "Evento";

  const locVal = cleanText_v1(ev.localizacao);
  const locSuffix = locVal ? ` (LOCALIZAÇÃO: ${locVal})` : "";

  const line1 = `🗓️ (${ddmmyyyy}) ${wd} | ${hora || "—"} — ${titulo}${locSuffix}`;

  const morada = cleanText_v1(ev.morada);
  
  // MUDANÇA AQUI: Adicionado "\n" (quebra de linha) no final de cada retorno 
  // para garantir que haverá uma linha em branco entre cada evento!
  if (morada) return `${line1}\n📍 ${morada}\n`;

  return `${line1}\n`;
}

function formatAgendaDepartamentosText_v1(groupsPayload, timeZone = "Europe/Lisbon") {
  const groups = Array.isArray(groupsPayload?.groups) ? groupsPayload.groups : [];
  if (!groups.length) return "Não encontrei eventos de departamentos a partir de hoje.";

  const out = [];
  out.push("Agenda por departamentos (a partir de hoje):");
  out.push("");

  for (const g of groups) {
    const org = String(g?.organizador || "Sem Organizador").trim() || "Sem Organizador";
    out.push(`*${org}*`);

    const evs = Array.isArray(g?.events) ? g.events : [];
    for (const ev of evs) out.push(formatEventoLine_v1(ev, timeZone));

    out.push("");
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = {
  getAgendaEventosMes_v1,
  getAgendaDepartamentos_v1,
  formatAgendaDepartamentosText_v1,
  formatEventoLine_v1,
};