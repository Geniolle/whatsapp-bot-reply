//###################################################################################
// ecosystem.config.js - CONFIGURAÇÃO DE PRODUÇÃO PM2
//###################################################################################
module.exports = {
  apps: [
    {
      name: "bot-igreja",
      script: "./src/index.js",
      instances: 1,           // Manter 1 para evitar conflitos de sessão WhatsApp
      exec_mode: "fork",
      max_memory_restart: "450M", // Reinicia antes de atingir o limite crítico do servidor
      cron_restart: "0 4 * * *",   // Reinicia às 04:00 para purgar a RAM
      watch: false,
      env: {
        NODE_ENV: "production",
        TZ: "Europe/Lisbon"
      },
      // Configuração de Logs Profissional
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss"
    }
  ]
};