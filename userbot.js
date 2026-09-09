/**
 * Entry point for the userbot — the /link and /ib text expander that runs as
 * the admin's own Telegram account. Separate process from the bot on purpose:
 * a session that needs re-authorising must never take the bot down with it.
 *
 *   npm run userbot:login    once, to sign in
 *   npm run userbot          to run it
 */
const { startUserbot } = require("./src/userbot");

startUserbot()
  .then((client) => {
    const shutdown = async (signal) => {
      console.log(`\n${signal} received — disconnecting.`);
      await client.disconnect().catch(() => {});
      process.exit(0);
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  })
  .catch((err) => {
    console.error("[userbot] Could not start:", err.message);
    process.exit(1);
  });
