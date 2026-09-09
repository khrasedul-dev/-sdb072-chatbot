require("dotenv").config();

const crypto = require("crypto");

const bool = (value, fallback) => {
  if (value === undefined || value === "") return fallback;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
};

const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || "potlood17")
  .trim()
  .replace(/^@/, "");

// The channel/group /post publishes the VIP message to. "@name" for a public
// channel, "-100…" for a private one.
const CHANNEL_ID = (process.env.CHANNEL_ID || "").trim();

const PORT = Number(process.env.PORT) || 3000;

// Cloud hosts route to the container from outside, so the health server has to
// listen on every interface there. On a VPS that already runs other apps, set
// HOST=127.0.0.1 to keep it off the public internet.
const HOST = (process.env.HOST || "0.0.0.0").trim();
const AUTO_APPROVE_JOIN_REQUESTS = bool(process.env.AUTO_APPROVE_JOIN_REQUESTS, true);
const WELCOME_IN_GROUP = bool(process.env.WELCOME_IN_GROUP, true);
const WELCOME_IN_DM = bool(process.env.WELCOME_IN_DM, true);

// `npm run poll`, or BOT_MODE=polling, forces long polling even on a host
// that exposes a public URL.
const FORCE_POLLING =
  process.argv.includes("--polling") ||
  /^poll(ing)?$/i.test(process.env.BOT_MODE || "");

/**
 * Free hosts each expose their public URL under a different variable, so the
 * webhook can configure itself without anyone pasting a URL by hand.
 * Set WEBHOOK_URL yourself to override all of them.
 */
function detectPublicUrl() {
  const candidates = [
    process.env.WEBHOOK_URL,
    process.env.PUBLIC_URL,
    process.env.RENDER_EXTERNAL_URL, // Render
    process.env.RAILWAY_PUBLIC_DOMAIN, // Railway
    process.env.KOYEB_PUBLIC_DOMAIN, // Koyeb
    process.env.CYCLIC_URL, // Cyclic
    process.env.SPACE_HOST, // Hugging Face Spaces
    process.env.VERCEL_PROJECT_PRODUCTION_URL, // Vercel
    process.env.VERCEL_URL,
    process.env.FLY_APP_NAME && `${process.env.FLY_APP_NAME}.fly.dev`, // Fly.io
    process.env.WEBSITE_HOSTNAME, // Azure
  ];

  for (const candidate of candidates) {
    const host = String(candidate || "")
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/\/+$/, "");
    // Skip empty values and localhost — Telegram cannot reach those.
    if (host && !/^(localhost|127\.|0\.0\.0\.0)/i.test(host)) return host;
  }
  return "";
}

const PUBLIC_URL = detectPublicUrl();

// Telegram signs every webhook call with this token, so nobody else can POST
// fake updates to the endpoint. Derived from the bot token when not supplied.
const WEBHOOK_SECRET =
  (process.env.WEBHOOK_SECRET || "").trim() ||
  (BOT_TOKEN
    ? crypto.createHash("sha256").update(`secret:${BOT_TOKEN}`).digest("hex").slice(0, 32)
    : "");

// Unguessable URL path, also derived from the token so it survives restarts.
const WEBHOOK_PATH =
  "/telegraf/" +
  (BOT_TOKEN
    ? crypto.createHash("sha256").update(`path:${BOT_TOKEN}`).digest("hex").slice(0, 32)
    : "webhook");

const MODE = FORCE_POLLING || !PUBLIC_URL ? "polling" : "webhook";

module.exports = {
  BOT_TOKEN,
  ADMIN_USERNAME,
  CHANNEL_ID,
  PORT,
  HOST,
  AUTO_APPROVE_JOIN_REQUESTS,
  WELCOME_IN_GROUP,
  WELCOME_IN_DM,
  PUBLIC_URL,
  WEBHOOK_SECRET,
  WEBHOOK_PATH,
  MODE,
  FORCE_POLLING,
};
