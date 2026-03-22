// Arquivo: src/services/campaignProcessor.js
"use strict";

const { readSheet, writeCells } = require("./sheets");
const { getTypingDelay, sleep } = require("../send");
const { MessageMedia } = require("whatsapp-web.js");
const { google } = require("googleapis");
const path = require("path");
const fs = require("fs");

/**
 * Função para lidar com Spintax (Variabilidade de Texto)
 * Exemplo: "Olá [como vai?|tudo bem?|bom ver você!]"
 */
function aplicarSpintax(texto) {
  if (!texto) return "";
  return texto.replace(/\[([^\]]+)\]/g, (match, opcoes) => {
    const escolhas = opcoes.split('|');
    return escolhas[Math.floor(Math.random() * escolhas.length)];
  });
}

/**
 * Função auxiliar para obter a saudação baseada na hora de Portugal
 */
function getDayGreeting() {
  const h = new Date().toLocaleString("pt-PT", { 
    timeZone: "Europe/Lisbon", 
    hour: "2-digit", 
    hour12: false 
  });
  const hour = parseInt(h);
  if (hour >= 5 && hour <= 11) return "Bom dia";
  if (hour >= 12 && hour <= 17) return "Boa tarde";
  return "Boa noite";
}

/**
 * Função auxiliar para obter o cliente do Google Drive
 */
function getDriveClient() {
  const credPath = path.resolve(process.cwd(), "credentials", "service-account.json");
  const creds = JSON.parse(fs.readFileSync(credPath, "utf8"));
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  return google.drive({ version: "v3", auth });
}

/**
 * Descarrega uma imagem do Google Drive e converte para MessageMedia
 */
async function downloadDriveImageAsMedia(imagePath) {
  if (!imagePath) return null;
  try {
    const drive = getDriveClient();
    const folderId = "1zcBQxi_W9P-0Oj2MsOY_6BX2PNT_kDk3"; 
    const imageName = imagePath.split('/').pop().split('\\').pop();

    const res = await drive.files.list({
      q: `name='${imageName}' and '${folderId}' in parents and trashed=false`,
      fields: "files(id, mimeType, name)",
    });

    const files = res.data.files;
    if (!files || files.length === 0) return null;

    const fileId = files[0].id;
    const mimeType = files[0].mimeType;

    const mediaRes = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
    const base64Data = Buffer.from(mediaRes.data).toString("base64");
    return new MessageMedia(mimeType, base64Data, imageName);
  } catch (error) {
    console.error(`[CAMPANHAS] Erro Drive:`, error.message);
    return null;
  }
}

/**
 * Processa campanhas de envio em massa (Modo Silencioso)
 */
async function processCampaigns({ client, spreadsheetId }) {
  // A verificação inicial agora é silenciosa para evitar poluição do log
  const campaignData = await readSheet(spreadsheetId, "Whatsapp");
  if (!campaignData || campaignData.length < 2) return;

  const headersW = campaignData[0].map(h => h.trim().toUpperCase());
  const idxStatusWs = headersW.indexOf("STATUS WS");
  const idxIdWp = headersW.indexOf("ID WHATSAPP");
  
  let activeCampaign = null;
  let campaignRowIndex = -1;

  for (let i = 1; i < campaignData.length; i++) {
    if (String(campaignData[i][idxStatusWs]).trim().toLowerCase() === "ativo") {
      activeCampaign = {
        id: campaignData[i][idxIdWp],
        titulo: campaignData[i][headersW.indexOf("TITULO")],
        saudacao: campaignData[i][headersW.indexOf("SAUDAÇÃO")],
        mensagem: campaignData[i][headersW.indexOf("MENSAGEM")],
        assinatura: campaignData[i][headersW.indexOf("ASSINATURA")],
        rodape: campaignData[i][headersW.indexOf("RODAPÉ")],
        imagePath: campaignData[i][headersW.indexOf("IMG")],
        grupoAlvo: String(campaignData[i][headersW.indexOf("GRUPO DE COMUNICAÇÃO")] || "GERAL").trim().toUpperCase()
      };
      campaignRowIndex = i + 1;
      break;
    }
  }

  // Se não houver campanha ativa, sai em silêncio
  if (!activeCampaign) return;

  // Só imprime no terminal após encontrar uma campanha ativa
  const LIMITE_POR_RODADA = 15; 
  let enviadosNestaRodada = 0;
  let totalPendentes = 0;

  console.log(`🚀 [CAMPANHA ATIVA] Iniciando disparos: "${activeCampaign.titulo}" (Lote: ${LIMITE_POR_RODADA})`);

  let media = null;
  if (activeCampaign.imagePath) {
    media = await downloadDriveImageAsMedia(activeCampaign.imagePath);
  }

  const dbData = await readSheet(spreadsheetId, "BP SERVICE");
  const headersD = dbData[0].map(h => h.trim().toUpperCase());
  
  const idxNome = headersD.indexOf("NOME");
  const idxTel = headersD.indexOf("TELEFONE");
  const idxStatusDest = headersD.indexOf("STATUS WS");
  const idxIdDest = headersD.indexOf("ID WHATSAPP");
  const idxInativo = headersD.indexOf("INATIVO");
  const idxMsgWs = headersD.indexOf("MENSAGEM WS");

  const saudacaoPeriodo = getDayGreeting();

  for (let r = 1; r < dbData.length; r++) {
    const row = dbData[r];
    
    if (String(row[idxInativo]).toLowerCase() === "true") continue;
    if (String(row[idxMsgWs]).toLowerCase() !== "true") continue;
    if (String(row[idxIdDest]) === String(activeCampaign.id)) continue;

    if (activeCampaign.grupoAlvo !== "GERAL") {
      const colGrupoIdx = headersD.indexOf(activeCampaign.grupoAlvo);
      if (colGrupoIdx === -1 || String(row[colGrupoIdx]).toLowerCase() !== "true") continue;
    }

    if (enviadosNestaRodada >= LIMITE_POR_RODADA) {
      totalPendentes++; 
      continue; 
    }

    const telefone = String(row[idxTel]).replace(/\D/g, "");
    if (!telefone) continue;

    const nome = row[idxNome] || "irmão(ã)";
    
    let textoFinal = `*${activeCampaign.titulo}*\n\n` +
                     `${activeCampaign.saudacao.replace("{NOME}", nome).replace("{SAUDACAO}", saudacaoPeriodo)}\n\n` +
                     `${activeCampaign.mensagem}\n\n` +
                     `${activeCampaign.assinatura}\n\n` +
                     `_${activeCampaign.rodape}_\n\n` +
                     `> Responda *SAIR* para não receber mais estes avisos.`;

    textoFinal = aplicarSpintax(textoFinal);

    try {
      const contactId = await client.getNumberId(telefone);
      if (contactId) {
        if (media) {
          await client.sendMessage(contactId._serialized, media, { caption: textoFinal });
        } else {
          await client.sendMessage(contactId._serialized, textoFinal);
        }
        
        const ts = new Date().toLocaleString("pt-PT");
        await writeCells(spreadsheetId, `BP SERVICE!${colToA1(idxStatusDest)}${r + 1}`, [[ts]]);
        await writeCells(spreadsheetId, `BP SERVICE!${colToA1(idxIdDest)}${r + 1}`, [[activeCampaign.id]]);
        
        enviadosNestaRodada++;
        console.log(`✅ [${enviadosNestaRodada}/${LIMITE_POR_RODADA}] Enviado para: ${nome}`);

        const delayMassa = Math.floor(Math.random() * (30000 - 15000 + 1)) + 15000;
        await sleep(delayMassa); 
      }
    } catch (err) {
      console.error(`❌ Erro em ${nome}:`, err.message);
    }
  }

  if (totalPendentes === 0 && enviadosNestaRodada > 0) {
    await writeCells(spreadsheetId, `Whatsapp!${colToA1(idxStatusWs)}${campaignRowIndex}`, [["Concluído"]]);
    console.log("🏁 Campanha finalizada!");
  } else if (totalPendentes > 0) {
    console.log(`⏳ Lote concluído. Restam ${totalPendentes} contactos pendentes.`);
  }
}

function colToA1(idx) {
  let n = idx + 1, s = "";
  while (n > 0) { let m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

module.exports = { processCampaigns };