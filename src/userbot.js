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

const M = require("./messages");
const { render } = require("./format");
const {
  TELEGRAM_API_ID,
  TELEGRAM_API_HASH,
  USERBOT_SESSION,
  USERBOT_PRIVATE_ONLY,
} = require("./config");

/**
 * What each shortcut expands to. Same messages the bot sends, so editing
 * messages.js changes both.
 *
 * The one thing that cannot carry over is the inline button: Telegram only lets
 * *bots* attach those. The link inside LINK_MESSAGE is a normal hyperlink, which
 * is what a person sending this by hand would have anyway.
 */
const SNIPPETS = {
  "/link": M.LINK_MESSAGE,
  "/ib": M.IB_MESSAGE,
  "/vip": M.WELCOME_MESSAGE,
};

function createClient(session = USERBOT_SESSION) {
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
  const template = SNIPPETS[typed];
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

async function startUserbot() {
  if (!USERBOT_SESSION) {
    throw new Error(
      "USERBOT_SESSION is not in .env. Run `npm run userbot:login` once, somewhere you can type the code Telegram sends."
    );
  }

  const client = createClient(USERBOT_SESSION);
  await client.connect();

  if (!(await client.checkAuthorization())) {
    throw new Error(
      "USERBOT_SESSION is no longer valid — the account was probably signed out from Telegram's Devices list. Run `npm run userbot:login` again."
    );
  }

  const me = await client.getMe();
  const label = me.username ? `@${me.username}` : me.firstName;

  client.addEventHandler(
    (event) =>
      expand(client, event).catch((err) =>
        console.error("[userbot] Could not expand the shortcut:", err.message)
      ),
    new NewMessage({ outgoing: true, incoming: false })
  );

  console.log("====================================================");
  console.log(`Userbot running as ${label} (${me.id}).`);
  console.log(`Shortcuts: ${Object.keys(SNIPPETS).join("  ")}`);
  console.log(`Scope: ${USERBOT_PRIVATE_ONLY ? "private chats only" : "every chat"}`);
  console.log("====================================================");

  return client;
}

module.exports = { createClient, startUserbot, expand, SNIPPETS };
