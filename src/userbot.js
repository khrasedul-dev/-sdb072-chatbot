/**
 * The userbot: a text expander running as the admin's own Telegram account.
 *
 * A bot cannot do this. Bots only see messages addressed to them, and they can
 * never send as a person — so `/ib` typed into a one-to-one conversation with a
 * prospect is invisible to @Scarfxxbot. Reaching those messages means talking to
 * Telegram over MTProto as the account itself, which is what GramJS does.
 *
 * The admin types /link or /ib while chatting to someone; the full text is sent
 * in their place, from their own account, so the prospect sees a normal message.
 */
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

const store = require("./store");
const { render } = require("./format");
const { TELEGRAM_API_ID, TELEGRAM_API_HASH, USERBOT_PRIVATE_ONLY } = require("./config");
const { readEnv } = require("./env-file");

/**
 * Read the session from .env every time rather than caching it at require time
 * — /login rewrites that file, and the userbot has to be able to pick the new
 * one up without restarting the process.
 */
function readSession() {
  const match = readEnv().match(/^USERBOT_SESSION=(.+)$/m);
  return match ? match[1].trim() : "";
}

/**
 * What each shortcut expands to. Same messages the bot sends, so editing
 * messages.js changes both.
 *
 * The one thing that cannot carry over is the inline button: Telegram only lets
 * *bots* attach those. The link inside LINK_MESSAGE is a normal hyperlink, which
 * is what a person sending this by hand would have anyway.
 */
const SNIPPETS = {
  "/link": "LINK_MESSAGE",
  "/ib": "IB_MESSAGE",
  "/vip": "WELCOME_MESSAGE",
};

function createClient(session = readSession()) {
  if (!TELEGRAM_API_ID || !TELEGRAM_API_HASH) {
    throw new Error(
      "TELEGRAM_API_ID and TELEGRAM_API_HASH are missing. Get them from https://my.telegram.org -> API development tools."
    );
  }

  return new TelegramClient(new StringSession(session), TELEGRAM_API_ID, TELEGRAM_API_HASH, {
    connectionRetries: 10,
    retryDelay: 3000,
    autoReconnect: true,
    // Chatty by default, and this runs under PM2 where every line is kept.
    baseLogger: undefined,
  });
}

/**
 * Expand one shortcut.
 *
 * The replacement is sent *before* the command is deleted. The other order —
 * delete then send — loses the text entirely if the send fails, and here the
 * worst case is a stray "/ib" left on screen.
 *
 * Sending a new message rather than editing the old one keeps the "edited"
 * label off a message meant to read as if it were typed out.
 */
async function expand(client, event) {
  const msg = event.message;
  const typed = (msg.text || "").trim().toLowerCase();
  const key = SNIPPETS[typed];
  if (!key) return false;

  // Read at send time, not at startup: an edit made through the bot has to
  // show up here without restarting this process.
  const template = store.get(key);
  if (!template) return false;

  if (USERBOT_PRIVATE_ONLY && !event.isPrivate) return false;

  const chat = await event.getInputChat();
  const who = await msg.getChat().catch(() => null);

  const text = render(template, {
    user: who,
    chat: who,
    // A tg://user mention in a one-to-one chat reads as a template. The bare
    // first name reads like something a person wrote.
    mention: false,
  });

  await client.sendMessage(chat, {
    message: text,
    parseMode: "html",
    linkPreview: false,
    // Keep the threading if the shortcut was typed as a reply.
    replyTo: msg.replyTo?.replyToMsgId,
  });

  try {
    await client.deleteMessages(chat, [msg.id], { revoke: true });
  } catch (err) {
    console.warn(`[userbot] Sent ${typed} but could not remove the command:`, err.message);
  }

  console.log(`[userbot] Expanded ${typed} in chat ${msg.chatId}.`);
  return true;
}

/* --------------------------- running alongside -------------------------- */
// The userbot lives in the same process as the bot, so there is one thing to
// deploy, one log to read, and one in-memory copy of the messages — an edit
// made through the bot is in effect here immediately.
//
// It must never be able to take the bot down with it, though: an expired
// session or an unreachable Telegram is reported and left, and the bot carries
// on answering.

let client = null;
let account = null;

const isRunning = () => Boolean(client);
const runningAs = () => account;

/**
 * Bring the userbot up. Resolves to null — never throws — when there is no
 * usable session; the reason goes to the log, and /login fixes it.
 */
async function startUserbot({ session = readSession() } = {}) {
  if (client) return client;

  if (!session) {
    console.warn("[userbot] Not signed in — /link and /ib will not expand in DMs. Send /login to the bot.");
    return null;
  }

  let candidate = null;
  try {
    candidate = createClient(session);
    await candidate.connect();

    if (!(await candidate.checkAuthorization())) {
      console.warn(
        "[userbot] The saved session is no longer valid — the account was probably signed out " +
          "from Telegram's Devices list. Send /login to the bot to sign in again."
      );
      await candidate.destroy().catch(() => {});
      return null;
    }

    const me = await candidate.getMe();
    account = me.username ? `@${me.username}` : me.firstName;

    candidate.addEventHandler(
      (event) =>
        expand(candidate, event).catch((err) =>
          console.error("[userbot] Could not expand the shortcut:", err.message)
        ),
      new NewMessage({ outgoing: true, incoming: false })
    );

    client = candidate;
    console.log(
      `Userbot:  ${account} (${me.id}) — ${Object.keys(SNIPPETS).join(" ")} in ` +
        `${USERBOT_PRIVATE_ONLY ? "private chats" : "every chat"}`
    );
    return client;
  } catch (err) {
    console.error("[userbot] Could not start:", err.message);
    await candidate?.destroy().catch(() => {});
    return null;
  }
}

async function stopUserbot() {
  if (!client) return;
  const stopping = client;
  client = null;
  account = null;
  await stopping.destroy().catch(() => {});
}

/** Used after /login writes a new session. */
async function restartUserbot(session) {
  await stopUserbot();
  return startUserbot({ session });
}

module.exports = {
  createClient,
  startUserbot,
  stopUserbot,
  restartUserbot,
  isRunning,
  runningAs,
  readSession,
  expand,
  SNIPPETS,
};
