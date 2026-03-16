"use strict";

//###################################################################################
// Imports
//###################################################################################
const path = require("path");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");

//###################################################################################
// Helper: delay
//###################################################################################
function sleep_v1(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

//###################################################################################
// Start WhatsApp Client
//###################################################################################
async function startClient_v1(cfg = {}) {
  //###################################################################################
  // Auth folder (na raiz do projeto)
  //###################################################################################
  const authPath = path.resolve(process.cwd(), ".wwebjs_auth");

  //###################################################################################
  // Client config
  //###################################################################################
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: authPath }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    },
  });

  //###################################################################################
  // Events
  //###################################################################################
  client.on("qr", (qr) => {
    console.log("[WA_QR] Escaneie o QR Code abaixo:");
    qrcode.generate(qr, { small: true });
  });

  client.on("authenticated", () => {
    console.log("[WA_AUTH] Autenticado");
  });

  client.on("auth_failure", (msg) => {
    console.log("[WA_AUTH_FAIL]", msg);
  });

  client.on("ready", () => {
    console.log("[WA_READY] Client pronto");
  });

  client.on("disconnected", (reason) => {
    console.log("[WA_DISCONNECTED]", reason);
  });

  //###################################################################################
  // Init
  //###################################################################################
  console.log("[WA_INIT] Iniciando...");
  await client.initialize();

  //###################################################################################
  // Aguarda READY (simples)
  //###################################################################################
  // Nota: whatsapp-web.js dispara "ready" async; aqui só damos um pequeno tempo
  // para evitar race em alguns ambientes.
  await sleep_v1(500);

  return client;
}

//###################################################################################
// Exports (compatível com o index.js)
//###################################################################################
module.exports = {
  startClient_v1,
};