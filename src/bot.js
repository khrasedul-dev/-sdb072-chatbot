const { Telegraf, Markup } = require("telegraf");
const { message } = require("telegraf/filters");

const M = require("./messages");
const {
  ADMIN_USERNAME,
  CHANNEL_ID,
  AUTO_APPROVE_JOIN_REQUESTS,
  WELCOME_IN_GROUP,
  WELCOME_IN_DM,
} = require("./config");

// Update types Telegram will not deliver unless we ask for them by name —
// `chat_member` in particular is opt-in, and it is what catches joins in
// supergroups and channels where no service message is posted.
const ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "channel_post",
  "callback_query",
  "chat_member",
  "my_chat_member",
  "chat_join_request",
];

/* ------------------------------- helpers ------------------------------- */

const escapeHtml = (text) =>
  String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** Turn <tg-emoji id="…">🔥</tg-emoji> back into a plain 🔥. */
const stripCustomEmoji = (html) =>
  String(html ?? "").replace(/<tg-emoji[^>]*>([\s\S]*?)<\/tg-emoji>/g, "$1");

/** Everything a Telegram HTML message holds, as plain readable text. */
const toPlainText = (html) =>
  stripCustomEmoji(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();

/** Fill {name} / {username} / {chat} / {admin} in a message template. */
function render(template, { user, chat } = {}) {
  const firstName = escapeHtml(user?.first_name || "there");
  const mention = user?.id
    ? `<a href="tg://user?id=${user.id}">${firstName}</a>`
    : firstName;

  return String(template ?? "")
    .replace(/\{name\}/g, mention)
    .replace(/\{username\}/g, user?.username ? `@${user.username}` : firstName)
    .replace(/\{chat\}/g, escapeHtml(chat?.title || "our community"))
    .replace(/\{admin\}/g, ADMIN_USERNAME);
}

/**
 * Send an HTML message, and if Telegram rejects the formatting — most often
 * because <tg-emoji> is reserved for bots with a Fragment username — resend it
 * once with plain emoji so the user still receives it.
 */
async function sendHtml(telegram, chatId, html, extra = {}) {
  const options = {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...extra,
  };

  try {
    return await telegram.sendMessage(chatId, html, options);
  } catch (err) {
    const description = err?.response?.description || "";
    const isFormattingError =
      err?.response?.error_code === 400 && /emoji|entit|pars|tag/i.test(description);
    if (!isFormattingError) throw err;

    console.warn(
      `[bot] Telegram rejected the HTML formatting (${description}) — resending with plain emoji.`
    );
    return telegram.sendMessage(chatId, stripCustomEmoji(html), options);
  }
}

/* ------------------------------ keyboards ------------------------------ */

/** Button that opens the admin's DM with the join request already typed out. */
function welcomeKeyboard() {
  const prefilled = encodeURIComponent(toPlainText(M.WELCOME_PREFILLED_DM));
  return Markup.inlineKeyboard([
    [Markup.button.url(M.WELCOME_BUTTON_TEXT, `https://t.me/${ADMIN_USERNAME}?text=${prefilled}`)],
  ]);
}

function linkKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.url(M.LINK_BUTTON_TEXT, M.LINK_BUTTON_URL)],
    [Markup.button.url(`📩 DM @${ADMIN_USERNAME}`, `https://t.me/${ADMIN_USERNAME}`)],
  ]);
}

function ibKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.url(M.IB_BUTTON_TEXT, `https://t.me/${ADMIN_USERNAME}`)],
  ]);
}

/* ------------------------------ welcoming ------------------------------ */

/**
 * The same person can arrive through several updates at once (a service
 * message plus a chat_member update), so remember who was just greeted.
 */
const recentlyWelcomed = new Map();
const WELCOME_COOLDOWN_MS = 60_000;

function claimWelcome(chatId, userId) {
  const key = `${chatId}:${userId}`;
  const now = Date.now();

  if (recentlyWelcomed.size > 500) {
    for (const [k, at] of recentlyWelcomed) {
      if (now - at > WELCOME_COOLDOWN_MS) recentlyWelcomed.delete(k);
    }
  }

  const last = recentlyWelcomed.get(key);
  if (last && now - last < WELCOME_COOLDOWN_MS) return false;

  recentlyWelcomed.set(key, now);
  return true;
}

/**
 * Greet one new member: in the group itself, and privately when Telegram lets
 * us. A private message only goes through if the user has already started the
 * bot, or within the short window Telegram opens after a join request — a
 * failure there is normal and stays quiet.
 */
async function welcomeMember(telegram, { chat, user, dmOnly = false }) {
  const text = render(M.WELCOME_MESSAGE, { user, chat });
  const extra = welcomeKeyboard();
  const where = chat?.title || chat?.id;

  if (!dmOnly && WELCOME_IN_GROUP && ["group", "supergroup"].includes(chat?.type)) {
    try {
      await sendHtml(telegram, chat.id, text, extra);
      console.log(`[bot] Welcomed ${user.first_name} (${user.id}) in "${where}".`);
    } catch (err) {
      console.error(`[bot] Could not post the welcome in "${where}":`, err.message);
    }
  }

  if (WELCOME_IN_DM) {
    try {
      await sendHtml(telegram, user.id, text, extra);
      console.log(`[bot] Sent the welcome DM to ${user.first_name} (${user.id}).`);
    } catch {
      // 403: the user has never opened a chat with the bot. Expected.
    }
  }
}

/* -------------------------------- the bot ------------------------------ */

function createBot(token) {
  const bot = new Telegraf(token, {
    handlerTimeout: 30_000,
    // Telegraf otherwise piggybacks the first API call of each update onto the
    // webhook's own HTTP response, which returns no result — errors would be
    // invisible and the custom-emoji retry below could never fire.
    telegram: { webhookReply: false },
  });

  bot.catch((err, ctx) => {
    console.error(`[bot] Failed to handle ${ctx?.updateType} update:`, err);
  });

  /* --- commands --- */

  bot.start(async (ctx) => {
    await sendHtml(
      ctx.telegram,
      ctx.chat.id,
      render(M.WELCOME_MESSAGE, { user: ctx.from, chat: ctx.chat }),
      welcomeKeyboard()
    );
  });

  bot.command("link", async (ctx) => {
    await sendHtml(
      ctx.telegram,
      ctx.chat.id,
      render(M.LINK_MESSAGE, { user: ctx.from, chat: ctx.chat }),
      linkKeyboard()
    );
  });

  bot.command("ib", async (ctx) => {
    await sendHtml(
      ctx.telegram,
      ctx.chat.id,
      render(M.IB_MESSAGE, { user: ctx.from, chat: ctx.chat }),
      ibKeyboard()
    );
  });

  /* --- admin --- */

  // Only the account named in ADMIN_USERNAME can run the commands below.
  const isAdmin = (ctx) =>
    ADMIN_USERNAME &&
    (ctx.from?.username || "").toLowerCase() === ADMIN_USERNAME.toLowerCase();

  // Publishes the VIP post — text plus the button that DMs the admin — into the
  // channel. `/post` uses CHANNEL_ID; `/post @channel` or `/post -100…`
  // overrides it for one send.
  bot.command("post", async (ctx) => {
    if (!isAdmin(ctx)) return;

    const target = ctx.message.text.split(/\s+/)[1] || CHANNEL_ID;
    if (!target) {
      return ctx.reply(
        "No channel set. Either put CHANNEL_ID in the environment variables, or send " +
          "/post @yourchannel (use the -100… id for a private channel — forward me any " +
          "post from it and I'll tell you the id)."
      );
    }

    try {
      await sendHtml(ctx.telegram, target, M.WELCOME_MESSAGE, welcomeKeyboard());
      await ctx.reply(`Posted to ${target}.`);
    } catch (err) {
      await ctx.reply(
        `Could not post to ${target}: ${err.message}\n\n` +
          "Check that the id is right and that I am an administrator there with " +
          '"Post Messages" permission.'
      );
    }
  });

  // Forwarding any channel post to the bot is the easiest way to learn a private
  // channel's -100… id, which is what CHANNEL_ID needs.
  bot.on(message("forward_origin"), async (ctx) => {
    if (ctx.chat.type !== "private" || !isAdmin(ctx)) return;

    const origin = ctx.message.forward_origin;
    if (origin.type !== "channel") return;

    await ctx.reply(
      `Chat id for "${origin.chat.title}": <code>${origin.chat.id}</code>\n\n` +
        "Set that as CHANNEL_ID, then send /post.",
      { parse_mode: "HTML" }
    );
  });

  /* --- joins --- */

  // Invite links set to "request to join". Approving first is what gives the
  // bot permission to DM someone who has never messaged it.
  bot.on("chat_join_request", async (ctx) => {
    const { chat, from } = ctx.chatJoinRequest;

    if (AUTO_APPROVE_JOIN_REQUESTS) {
      try {
        await ctx.approveChatJoinRequest(from.id);
        console.log(`[bot] Approved ${from.first_name} (${from.id}) for "${chat.title || chat.id}".`);
      } catch (err) {
        console.error("[bot] Could not approve the join request:", err.message);
      }
    }

    claimWelcome(chat.id, from.id);
    await welcomeMember(ctx.telegram, { chat, user: from, dmOnly: true });
  });

  // Service message posted in basic groups and most supergroups.
  bot.on(message("new_chat_members"), async (ctx) => {
    for (const user of ctx.message.new_chat_members) {
      if (user.is_bot) continue;
      if (!claimWelcome(ctx.chat.id, user.id)) continue;
      await welcomeMember(ctx.telegram, { chat: ctx.chat, user });
    }
  });

  // Covers channels and any supergroup with service messages hidden.
  bot.on("chat_member", async (ctx) => {
    const { chat, old_chat_member: before, new_chat_member: after } = ctx.chatMember;
    const user = after.user;
    if (user.is_bot) return;

    const wasOutside = ["left", "kicked"].includes(before.status);
    const isInside = ["member", "administrator", "restricted"].includes(after.status);
    if (!wasOutside || !isInside) return;

    if (!claimWelcome(chat.id, user.id)) return;
    await welcomeMember(ctx.telegram, { chat, user });
  });

  return bot;
}

module.exports = { createBot, ALLOWED_UPDATES, sendHtml, toPlainText, stripCustomEmoji };
