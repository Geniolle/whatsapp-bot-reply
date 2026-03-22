// Arquivo: src/services/alarmProcessor.js
const { readSheet, writeCells } = require("./sheets");

function nowPt() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function todayPtStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getCleanPhone(raw) {
  if (!raw) return null;
  return String(raw).replace(/[^\d]/g, "") || null;
}

function buildHeaderIndex(headerRow) {
  const idx = {};
  (headerRow || []).forEach((h, i) => {
    const key = String(h || "").trim().toUpperCase();
    if (key) idx[key] = i;
  });
  return idx;
}

function colToA1(colIndex) {
  let n = colIndex + 1;
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function discoverSequentials(headerRow) {
  const pairs = [];
  for (let i = 0; i < headerRow.length; i++) {
    const h = String(headerRow[i] || "").trim().toUpperCase();
    const m = h.match(/^TEXTO_WS(\d+)$/);
    if (!m) continue;

    const n = Number(m[1]);
    const idKey = `ID_SEND${n}`;

    const idIdx = headerRow.findIndex(x => String(x || "").trim().toUpperCase() === idKey);
    if (idIdx >= 0) {
      pairs.push({ n, textoIdx: i, idIdx });
    }
  }
  pairs.sort((a, b) => a.n - b.n);
  return pairs;
}

async function setCell(spreadsheetId, sheetName, colIndex, rowNumber1Based, value) {
  const a1 = `${sheetName}!${colToA1(colIndex)}${rowNumber1Based}`;
  await writeCells(spreadsheetId, a1, [[value]]);
}

function safeErrMsg(err) {
  const msg = (err && err.message) ? err.message : String(err || "");
  return msg.length > 300 ? msg.slice(0, 300) : msg;
}

// =================================================================
// FUNÇÕES DE HUMANIZAÇÃO
// =================================================================

function getSaudacaoTempo() {
  const agora = new Date();
  const horaString = agora.toLocaleString("en-US", { timeZone: "Europe/Lisbon", hour: 'numeric', hour12: false });
  const horaPT = parseInt(horaString, 10);

  if (horaPT >= 5 && horaPT < 12) return "bom dia";
  if (horaPT >= 12 && horaPT < 20) return "boa tarde";
  return "boa noite";
}

async function loadCollaborators(spreadsheetId, bpSheetName) {
  if (!bpSheetName) return {};
  
  try {
    const data = await readSheet(spreadsheetId, bpSheetName);
    if (data.length < 2) return {};

    const headers = (data[0] || []).map(h => String(h).trim().toUpperCase());
    
    const nameIdx = headers.findIndex(h => h.includes("NOME"));
    const phoneIdx = headers.findIndex(h => h.includes("TELEFONE") || h.includes("TELEMÓVEL") || h.includes("CELULAR") || h.includes("WHATSAPP"));

    if (nameIdx === -1 || phoneIdx === -1) return {};

    const map = {};
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const rawName = row[nameIdx];
      const rawPhone = row[phoneIdx];
      if (rawName && rawPhone) {
         const cleanPhone = getCleanPhone(rawPhone);
         if (cleanPhone) map[cleanPhone] = String(rawName).trim();
      }
    }
    return map;
  } catch (err) {
    console.error("[ALARMES] Erro ao carregar colaboradores:", err.message);
    return {};
  }
}

function humanizeMessage(nomeCompleto, processo, contextoDaPlanilha) {
  const nomeProcesso = processo !== "(SEM PROCESSO)" ? processo : "atualização de dados";
  const tempoDescritivo = getSaudacaoTempo(); 
  
  const tempoCapitalizado = tempoDescritivo.charAt(0).toUpperCase() + tempoDescritivo.slice(1);

  let intro = "";

  if (!nomeCompleto) {
    const saudacoesGenericas = [
      `Olá, graça e paz, ${tempoDescritivo}!`, 
      `Olá, ${tempoDescritivo}!`, 
      `Oi, tudo bem? ${tempoCapitalizado}!`
    ];
    intro = saudacoesGenericas[Math.floor(Math.random() * saudacoesGenericas.length)];
  } else {
    const primeiroNome = nomeCompleto.split(" ")[0];
    const nomeFormatado = primeiroNome.charAt(0).toUpperCase() + primeiroNome.slice(1).toLowerCase();

    const saudacoes = [
      `Olá ${nomeFormatado}, graça e paz, ${tempoDescritivo}!`,
      `${tempoCapitalizado} ${nomeFormatado}, graça e paz!`,
      `Oi ${nomeFormatado}, tudo bem? ${tempoCapitalizado}!`,
      `Olá ${nomeFormatado}, ${tempoDescritivo}!`
    ];
    intro = saudacoes[Math.floor(Math.random() * saudacoes.length)];
  }
  
  return `${intro}\n\nEstamos a enviar uma mensagem referente ao processo de *${nomeProcesso}* para a vossa informação.\n\n${contextoDaPlanilha}`;
}
// =================================================================

async function processOpenRows({ client, spreadsheetId, sheetName, sheetNameBp }) {
  // Ajuste: A leitura agora é silenciosa
  const data = await readSheet(spreadsheetId, sheetName);
  if (data.length < 2) return;

  const header = data[0];
  const H = buildHeaderIndex(header);

  const colPROCESSO = H["PROCESSO"];
  const colSTATUS = H["STATUS"];
  const colSTATUS_WS = H["STATUS_WS"];
  const colSTATUS_ERRO = H["STATUS_ERRO"];

  if (colPROCESSO == null || colSTATUS == null || colSTATUS_WS == null) return;

  const sequentials = discoverSequentials(header);
  if (!sequentials.length) return;

  const group = {}; 
  const dataDeHoje = todayPtStr();
  
  // Ajuste: Carregamento de colaboradores agora só ocorre se houver pelo menos uma linha "em aberto"
  let colaboradoresMap = null;

  for (let r = 1; r < data.length; r++) {
    const row = data[r] || [];
    const status = String(row[colSTATUS] || "").trim().toLowerCase();
    if (status !== "em aberto") continue;

    // Se chegou aqui, existe trabalho a fazer. Iniciamos os logs e carregamos o mapa.
    if (!colaboradoresMap) {
        console.log(`[ALARMES] 🚨 Notificações em aberto encontradas na planilha: ${sheetName}`);
        colaboradoresMap = await loadCollaborators(spreadsheetId, sheetNameBp);
    }

    const processo = String(row[colPROCESSO] || "").trim() || `(SEM PROCESSO)`;
    const sheetRow = r + 1;
    const statusWsVal = String(row[colSTATUS_WS] || "").trim();

    if (statusWsVal.startsWith(dataDeHoje)) {
        console.log(`[ALARMES] ⚠️ [BLOQUEADO] A linha ${sheetRow} (${processo}) já tem um registo de hoje (${statusWsVal}).`);
        await setCell(spreadsheetId, sheetName, colSTATUS, sheetRow, "Concluído");
        continue; 
    }

    if (!group[processo]) {
      group[processo] = { rows: 0, filledPairs: 0, sentPairs: 0, skippedPairs: 0 };
    }
    group[processo].rows += 1;

    const filled = [];
    for (const p of sequentials) {
      const textoContexto = String(row[p.textoIdx] || "").trim();
      const rawPhone = getCleanPhone(row[p.idIdx]);
      if (textoContexto && rawPhone) filled.push({ n: p.n, contexto: textoContexto, phone: rawPhone });
    }

    group[processo].filledPairs += filled.length;
    if (!filled.length) {
      group[processo].skippedPairs += 1;
      continue;
    }

    await setCell(spreadsheetId, sheetName, colSTATUS, sheetRow, "Em envio");
    await setCell(spreadsheetId, sheetName, colSTATUS_WS, sheetRow, nowPt());

    let sentThisRow = 0;
    let lastErr = "";

    for (const item of filled) {
      try {
        const delayMs = Math.floor(Math.random() * 2000) + 1000;
        await sleep(delayMs);

        const contactId = await client.getNumberId(item.phone);
        if (!contactId) {
            throw new Error(`Número ${item.phone} não possui WhatsApp ativo.`);
        }
        const finalChatId = contactId._serialized;

        const nomeDoColaborador = colaboradoresMap[item.phone]; 
        const mensagemFinal = humanizeMessage(nomeDoColaborador, processo, item.contexto); 

        await client.sendMessage(finalChatId, mensagemFinal);
        
        sentThisRow += 1;
        group[processo].sentPairs += 1;
        console.log(`[ALARMES] ✅ L${sheetRow} | WS${item.n} -> ${finalChatId} (Enviado para: ${nomeDoColaborador || 'Desconhecido'})`);
      } catch (err) {
        group[processo].skippedPairs += 1;
        lastErr = safeErrMsg(err);
        console.log(`[ALARMES] ❌ L${sheetRow} | WS${item.n} -> ${item.phone} | ${lastErr}`);
      }
    }

    if (sentThisRow > 0) {
      await setCell(spreadsheetId, sheetName, colSTATUS, sheetRow, "Concluído");
      await setCell(spreadsheetId, sheetName, colSTATUS_WS, sheetRow, nowPt());
    } else {
      await setCell(spreadsheetId, sheetName, colSTATUS, sheetRow, "Erro");
      await setCell(spreadsheetId, sheetName, colSTATUS_WS, sheetRow, nowPt());
      if (colSTATUS_ERRO != null) {
        await setCell(spreadsheetId, sheetName, colSTATUS_ERRO, sheetRow, lastErr);
      }
    }
  }
}

module.exports = { processOpenRows };