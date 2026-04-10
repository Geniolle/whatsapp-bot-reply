module.exports = {
  apps: [
    {
      name: "bot-igreja",
      script: "./src/index.js",
      max_memory_restart: "500M", // Reinicia se ultrapassar 500MB de RAM
      cron_restart: "0 4 * * *",   // Reinicia preventivamente todos os dias às 04:00
      env: {
        NODE_ENV: "production"
      },
      error_file: "./logs/err.log",
      out_file: "./logs/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss"
    }
  ]
};