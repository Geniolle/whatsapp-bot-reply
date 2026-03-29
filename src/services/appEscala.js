//###################################################################################
// src/services/appEscala.js - CONSULTA DE ESCALAS POR TELEFONE -> EMAIL -> BP ESCALA
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
  return stripBom(v)
    .trim()
    .replace(/\s+/g, " ");
}

function normEmail(v) {
  return normText(v).toLowerCase();
}

function onlyDigits(v) {
  return String(v || "").replace(/\D+/g, "");
}

function chatIdToNumber(chatId) {
  return onlyDigits(String(chatId || "").split("@")[0]);
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

//###################################################################################
// Lookup de email no BP SERVICE
//###################################################################################
async function getEmailByChatId_v1({
  spreadsheetId,
  sheetNameBpService,
  chatId,
}) {
  const values = await readRange(spreadsheetId, `'${sheetNameBpService}'!A:ZZ`);
  if (!values || values.length < 2) {
    throw new Error(`[APP_ESCALA] A aba ${sheetNameBpService} está vazia ou sem dados.`);
  }

  const header = values[0] || [];

  const idxTelefone = findHeaderIndex(header, "TELEFONE");
  const idxNumberWp = findHeaderIndex(
    header,
    "NUMBERWHATSAPP",
    "NUMBER WHATSAPP",
    "WHATSAPP",
    "WHATSAPPNUMBER"
  );
  const idxEmail = findHeaderIndex(header, "EMAIL", "E-MAIL");

  if (idxEmail < 0) {
    throw new Error(`[APP_ESCALA] Coluna [EMAIL] não encontrada na aba ${sheetNameBpService}.`);
  }

  if (idxTelefone < 0 && idxNumberWp < 0) {
    throw new Error(`[APP_ESCALA] Coluna [TELEFONE] não encontrada na aba ${sheetNameBpService}.`);
  }

  const chatNum = chatIdToNumber(chatId);

  for (let r = 1; r < values.length; r++) {
    const row = values[r] || [];

    const telA = idxTelefone >= 0 ? onlyDigits(row[idxTelefone]) : "";
    const telB = idxNumberWp >= 0 ? onlyDigits(row[idxNumberWp]) : "";

    if (!telA && !telB) continue;

    if (telA === chatNum || telB === chatNum) {
      const email = idxEmail >= 0 ? normEmail(row[idxEmail]) : "";
      if (!email) {
        throw new Error(`[APP_ESCALA] O colaborador foi encontrado, mas a coluna [EMAIL] está vazia.`);
      }
      return email;
    }
  }

  return "";
}

//###################################################################################
// Leitura das escalas
//###################################################################################
async function getEscalasByEmail_v1({
  spreadsheetId,
  sheetNameEscala,
  email,
}) {
  const values = await readRange(spreadsheetId, `'${sheetNameEscala}'!A:ZZ`);
  if (!values || values.length < 2) {
    return [];
  }

  const header = values[0] || [];

  const idxEmail = findHeaderIndex(header, "EMAIL", "E-MAIL");
  const idxData = findHeaderIndex(header, "DATA");
  const idxDia = findHeaderIndex(header, "DIA");

  if (idxEmail < 0) {
    throw new Error(`[APP_ESCALA] Coluna [EMAIL] não encontrada na aba ${sheetNameEscala}.`);
  }

  if (idxData < 0) {
    throw new Error(`[APP_ESCALA] Coluna [DATA] não encontrada na aba ${sheetNameEscala}.`);
  }

  if (idxDia < 0) {
    throw new Error(`[APP_ESCALA] Coluna [DIA] não encontrada na aba ${sheetNameEscala}.`);
  }

  const serviceIndexes = [];
  for (let n = 1; n <= 10; n++) {
    const idx = findHeaderIndex(header, `SERVICO${n}`);
    if (idx >= 0) {
      serviceIndexes.push({ name: `SERVICO${n}`, idx });
    }
  }

  if (!serviceIndexes.length) {
    throw new Error(`[APP_ESCALA] Nenhuma coluna [SERVICO1..SERVICO10] foi encontrada na aba ${sheetNameEscala}.`);
  }

  const targetEmail = normEmail(email);
  const out = [];

  for (let r = 1; r < values.length; r++) {
    const row = values[r] || [];
    const emailRow = normEmail(row[idxEmail]);

    if (!emailRow) continue;
    if (emailRow !== targetEmail) continue;

    const servicos = serviceIndexes
      .map((s) => normText(row[s.idx]))
      .filter(Boolean);

    if (!servicos.length) continue;

    out.push({
      dataRaw: row[idxData],
      data: formatDatePt(row[idxData]),
      dia: normText(row[idxDia]),
      servicos,
    });
  }

  out.sort((a, b) => {
    const da = parseDateValue(a.dataRaw);
    const db = parseDateValue(b.dataRaw);
    const ta = da ? da.getTime() : Number.MAX_SAFE_INTEGER;
    const tb = db ? db.getTime() : Number.MAX_SAFE_INTEGER;
    return ta - tb;
  });

  return out;
}

//###################################################################################
// Formatação final
//###################################################################################
function formatEscalasText_v1(items) {
  if (!Array.isArray(items) || !items.length) {
    return "Não encontrei nenhuma escala atribuída a ti neste momento.";
  }

  const lines = [];
  lines.push("📅 *Estas são as tuas escalas atribuídas:*");

  for (const item of items) {
    const data = item?.data || "—";
    const dia = item?.dia || "—";
    const funcoes = Array.isArray(item?.servicos) ? item.servicos.filter(Boolean) : [];

    lines.push("");
    lines.push(`• *${data}* (${dia})`);
    for (const funcao of funcoes) {
      lines.push(`  - ${funcao}`);
    }
  }

  return lines.join("\n");
}

//###################################################################################
// Função principal para o bot
//###################################################################################
async function getMinhasEscalas_v1({
  spreadsheetId,
  sheetNameBpService,
  sheetNameEscala,
  chatId,
}) {
  if (!spreadsheetId) {
    throw new Error("[APP_ESCALA] spreadsheetId não definido.");
  }

  if (!sheetNameBpService) {
    throw new Error("[APP_ESCALA] sheetNameBpService não definido.");
  }

  if (!sheetNameEscala) {
    throw new Error("[APP_ESCALA] sheetNameEscala não definido.");
  }

  if (!chatId) {
    throw new Error("[APP_ESCALA] chatId não definido.");
  }

  const email = await getEmailByChatId_v1({
    spreadsheetId,
    sheetNameBpService,
    chatId,
  });

  if (!email) {
    return "Não consegui localizar o teu email na base de dados para consultar a tua escala.";
  }

  const items = await getEscalasByEmail_v1({
    spreadsheetId,
    sheetNameEscala,
    email,
  });

  return formatEscalasText_v1(items);
}

module.exports = {
  getEmailByChatId_v1,
  getEscalasByEmail_v1,
  formatEscalasText_v1,
  getMinhasEscalas_v1,
};