const express = require("express");

const store = require("./src/store");
const { createBot, ALLOWED_UPDATES } = require("./src/bot");
const { startUserbot, stopUserbot } = require("./src/userbot");
const { PRIVATE_COMMANDS, GROUP_COMMANDS } = require("./src/messages");
const {
  BOT_TOKEN,
  PORT,
  HOST,
  MODE,
  PUBLIC_URL,
  WEBHOOK_PATH,
  WEBHOOK_SECRET,
  ADMIN_USERNAME,
  AUTO_APPROVE_JOIN_REQUESTS,
} = require("./src/config");

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing. Put it in .env (locally) or in your host's environment variables.");
  console.error("Get one from https://t.me/BotFather");
  process.exit(1);
}

/** Free hosts sometimes boot before their network is ready, so give up slowly. */
async function withRetry(label, task, attempts = 4) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (err) {
      if (attempt >= attempts) throw err;
      const waitMs = attempt * 3000;
      console.warn(`[boot] ${label} failed (${err.message}) — retrying in ${waitMs / 1000}s.`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

async function main() {
  // Before anything can answer: the messages come from MongoDB, and a failure
  // here falls back to the texts in messages.js rather than stopping the bot.
  await store.connect({ label: "bot" });

  const bot = createBot(BOT_TOKEN);
  const me = await withRetry("Connecting to Telegram", () => bot.telegram.getMe());
  bot.botInfo = me;

  const app = express();

  // Health check — also the URL to point a free uptime pinger at, which is what
  // keeps a free instance from sleeping.
  app.get("/", (req, res) => {
    res.json({ ok: true, bot: `@${me.username}`, mode: MODE, uptime: Math.round(process.uptime()) });
  });

  if (MODE === "webhook") {
    const webhook = await withRetry("Setting the webhook", () =>
      bot.createWebhook({
        domain: PUBLIC_URL,
        path: WEBHOOK_PATH,
        secret_token: WEBHOOK_SECRET,
        allowed_updates: ALLOWED_UPDATES,
        drop_pending_updates: false,
      })
    );
    app.use(webhook);
  }

  const server = app.listen(PORT, HOST, () => {
    console.log("====================================================");
    console.log(`Bot @${me.username} is online in ${MODE} mode.`);
    if (MODE === "webhook") {
      console.log(`Webhook:  https://${PUBLIC_URL}${WEBHOOK_PATH}`);
    } else {
      console.log("Webhook:  none — no public URL found, using long polling.");
    }
    console.log(`Health:   http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/`);
    console.log(`Admin DM: @${ADMIN_USERNAME}`);
    console.log(`Join requests: ${AUTO_APPROVE_JOIN_REQUESTS ? "auto-approved" : "left for an admin"}`);
    console.log("====================================================");
  });

  if (MODE === "polling") {
    // A webhook left over from a previous deploy would silently swallow every
    // update, so clear it before polling.
    await bot.telegram.deleteWebhook().catch(() => {});
    bot
      .launch({
        allowedUpdates: ALLOWED_UPDATES,
        // Keep whatever queued up while the process was restarting. Every
        // deploy reloads PM2, and dropping the backlog would mean anyone who
        // joined in those two seconds never gets welcomed. Re-delivered
        // updates are safe: the welcomed list on disk survives the restart.
        dropPendingUpdates: false,
      })
      .catch((err) => {
        console.error("[boot] Polling stopped:", err);
        process.exit(1);
      });
  }

  // The "/" menu is scoped: /start belongs in a private chat, while /link and
  // /ib should be listed inside groups too. Nice-to-have — harmless if
  // Telegram rate-limits it.
  bot.telegram
    .setMyCommands(PRIVATE_COMMANDS, { scope: { type: "all_private_chats" } })
    .then(() => bot.telegram.setMyCommands(GROUP_COMMANDS, { scope: { type: "all_group_chats" } }))
    .then(() => console.log(`Commands: ${GROUP_COMMANDS.map((c) => "/" + c.command).join(" ")} in groups`))
    .catch((err) => console.warn("[boot] Could not publish the command menu:", err.message));

  // Telegraf and GramJS in the same process. The userbot resolves to null
  // rather than throwing when it has no valid session, so a signed-out account
  // costs /link and /ib in DMs and nothing else.
  await startUserbot();

  const shutdown = (signal) => {
    console.log(`\n${signal} received — shutting down.`);
    bot.stop(signal);
    stopUserbot().catch(() => {});
    store.close().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[boot] Startup failed:", err);
  process.exit(1);
});
