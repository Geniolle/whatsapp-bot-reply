"use strict";

//###################################################################################
// Imports
//###################################################################################
const path = require("path");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");

//###################################################################################
// Helper: Human Delay
// Cria um atraso variável para simular o tempo de pensamento/digitação humano
//###################################################################################
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calcula um tempo de digitação baseado no tamanho do texto
 * @param {string} text - O texto que será enviado
 * @returns {number} - Milissegundos de atraso
 */
const getTypingDelay = (text) => {
  const minDelay = 1500; // Mínimo de 1.5 segundos
  const perCharDelay = 20; // 20ms por caractere
  return Math.min(minDelay + (text.length * perCharDelay), 5000); // Máximo de 5 segundos
};

//###################################################################################
// Start WhatsApp Client
//###################################################################################
async function startClient_v1(cfg = {}) {
  // Local onde a sessão será salva (na raiz do projeto conforme seu .gitignore)
  const authPath = path.resolve(process.cwd(), ".wwebjs_auth");

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: authPath }),
    puppeteer: {
      headless: true, // Mude para false se quiser ver o Chrome trabalhando
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    },
  });

  //###################################################################################
  // Events: Monitoramento e Feedback
  //###################################################################################
  client.on("qr", (qr) => {
    console.log("[WA_QR] Novo QR Code gerado. Escaneie para conectar:");
    qrcode.generate(qr, { small: true });
  });

  client.on("authenticated", () => {
    console.log("[WA_AUTH] Sessão autenticada com sucesso!");
  });

  client.on("auth_failure", (msg) => {
    console.error("[WA_AUTH_FAIL] Falha na autenticação:", msg);
  });

  client.on("ready", () => {
    console.log("[WA_READY] O bot está online e pronto para operar!");
  });

  client.on("disconnected", (reason) => {
    console.warn("[WA_DISCONNECTED] O cliente foi desconectado:", reason);
  });

  //###################################################################################
  // Initialization
  //###################################################################################
  console.log("[WA_INIT] Inicializando o motor do WhatsApp...");
  
  try {
    await client.initialize();
  } catch (err) {
    console.error("[WA_INIT_ERROR] Erro ao inicializar:", err);
  }

  // Pequeno fôlego para garantir que o socket está estável
  await sleep(1000);

  return client;
}

//###################################################################################
// Exports
//###################################################################################
module.exports = {
  startClient_v1,
  sleep,
  getTypingDelay
};