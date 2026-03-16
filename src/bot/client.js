const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");

function createClient() {
  const dataPath = path.join(__dirname, "..", "..", "session");

  return new Client({
    authStrategy: new LocalAuth({
      clientId: "main",
      dataPath,
    }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });
}

module.exports = { createClient };
