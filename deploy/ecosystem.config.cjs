/**
 * PM2 process definition for the VIP bot.
 *
 *   pm2 start deploy/ecosystem.config.cjs
 *   pm2 save
 *
 * CommonJS on purpose: PM2 reads this file itself and does not handle ESM.
 *
 * ONE instance, fork mode, and that is not an oversight — Telegram hands each
 * update to exactly one getUpdates caller, so a second instance would silently
 * take half the joins and neither copy would see the whole picture.
 */
module.exports = {
  apps: [
    {
      name: "vip-bot",
      cwd: "/srv/vip-bot/app",
      script: "index.js",
      exec_mode: "fork",
      instances: 1,

      env: {
        NODE_ENV: "production",
        // Long polling: nothing needs to reach this box from outside.
        BOT_MODE: "polling",
        // The health server still binds a port. 3000 already belongs to the
        // trucking panel on this host, and loopback keeps this one off the
        // public internet.
        PORT: 3101,
        HOST: "127.0.0.1",
      },

      autorestart: true,
      max_restarts: 20,
      // Back off instead of hammering Telegram if the token is ever wrong.
      restart_delay: 5000,
      min_uptime: "30s",
      max_memory_restart: "300M",

      error_file: "/var/log/vip-bot/bot.error.log",
      out_file: "/var/log/vip-bot/bot.out.log",
      merge_logs: true,
      time: true,

      // Telegraf closes its polling loop on SIGTERM; give it room to finish the
      // update in flight rather than dropping someone's join.
      kill_timeout: 10000,
    },
  ],
};
