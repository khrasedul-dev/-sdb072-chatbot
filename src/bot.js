const fs = require("fs");
const path = require("path");
const { Telegraf, Markup } = require("telegraf");
const { message } = require("telegraf/filters");

const store = require("./store");
const editor = require("./editor");
const { stripCustomEmoji, toPlainText, render } = require("./format");
const {
  startLogin,
  provideAnswer,
  cancelLogin,
  isLoggingIn,
  sessionStatus,
} = require("./userbot-auth");
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Send an HTML message, working around the two ways Telegram refuses one
 * without the message actually being at fault:
 *
 *  - 400 on the formatting, because <tg-emoji> is reserved for bots that own a
 *    Fragment username. Resent once with plain emoji.
 *  - 429, when a burst of joins goes over the rate limit. Telegram states how
 *    long to wait and that it did NOT send, so waiting and retrying cannot
 *    duplicate anything.
 *
 * A network-level failure is deliberately NOT retried: the message may well
 * have arrived before the connection dropped, and a blind retry would post it
 * twice. Those are left to the caller, which has a second join signal to fall
 * back on.
 */
async function sendHtml(telegram, chatId, html, extra = {}) {
  const options = {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...extra,
  };

  let text = html;
  let strippedEmoji = false;

  for (let attempt = 1; ; attempt++) {
    try {
      return await telegram.sendMessage(chatId, text, options);
    } catch (err) {
      const code = err?.response?.error_code;
      const description = err?.response?.description || "";

      if (code === 400 && !strippedEmoji && /emoji|entit|pars|tag/i.test(description)) {
        console.warn(`[bot] Telegram rejected the HTML formatting (${description}) — resending with plain emoji.`);
        text = stripCustomEmoji(text);
        strippedEmoji = true;
        continue;
      }

      const retryAfter = err?.response?.parameters?.retry_after ?? err?.parameters?.retry_after;
      if (code === 429 && attempt <= 4) {
        const waitMs = (retryAfter ?? attempt) * 1000 + 250;
        console.warn(`[bot] Rate limited on chat ${chatId} — waiting ${waitMs}ms then retrying.`);
        await sleep(waitMs);
        continue;
      }

      // 5xx is Telegram failing on its own side, before the message goes out.
      if (code >= 500 && attempt <= 3) {
        console.warn(`[bot] Telegram returned ${code} (${description}) — retry ${attempt}.`);
        await sleep(attempt * 1000);
        continue;
      }

      throw err;
    }
  }
}

/* ------------------------------ keyboards ------------------------------ */

/** Button that opens the admin's DM with the join request already typed out. */
function welcomeKeyboard() {
  const prefilled = encodeURIComponent(toPlainText(store.get("WELCOME_PREFILLED_DM")));
  return Markup.inlineKeyboard([
    [Markup.button.url(store.get("WELCOME_BUTTON_TEXT"), `https://t.me/${ADMIN_USERNAME}?text=${prefilled}`)],
  ]);
}

function linkKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.url(store.get("LINK_BUTTON_TEXT"), store.get("LINK_BUTTON_URL"))],
    [Markup.button.url(`📩 DM @${ADMIN_USERNAME}`, `https://t.me/${ADMIN_USERNAME}`)],
  ]);
}

function ibKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.url(store.get("IB_BUTTON_TEXT"), `https://t.me/${ADMIN_USERNAME}`)],
  ]);
}

/* --------------------------- the welcomed list -------------------------- */

/**
 * One join reaches the bot through up to three separate updates — the service
 * message, the chat_member update and, for request-to-join links, the join
 * request. Exactly one of them should produce a welcome.
 *
 * This has to survive a restart: every deploy reloads the process, and Telegram
 * re-delivers anything that was in flight. An in-memory set would forget who it
 * had already greeted and welcome them a second time, so the list is kept on
 * disk. Losing the file (a fresh container, a read-only filesystem) degrades to
 * memory-only rather than failing.
 */
const STORE_FILE = path.join(__dirname, "..", "data", "welcomed.json");
const REMEMBER_MS = 7 * 24 * 60 * 60 * 1000;

const welcomed = new Map();
let storeWritable = true;
let saveTimer = null;

function pruneStore(now = Date.now()) {
  for (const [key, at] of welcomed) {
    if (now - at > REMEMBER_MS) welcomed.delete(key);
  }
}

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    for (const [key, at] of Object.entries(raw)) welcomed.set(key, at);
    pruneStore();
    console.log(`[bot] Remembered ${welcomed.size} already-welcomed members.`);
  } catch (err) {
    if (err.code !== "ENOENT") console.warn("[bot] Could not read the welcomed list:", err.message);
  }
}

function saveStore() {
  if (!storeWritable) return;
  try {
    pruneStore();
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    // Write-then-rename, so a crash mid-write cannot leave a half-written file
    // that would parse as empty and re-welcome everybody.
    const tmp = `${STORE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(welcomed)), "utf8");
    fs.renameSync(tmp, STORE_FILE);
  } catch (err) {
    storeWritable = false;
    console.warn("[bot] Cannot persist the welcomed list, staying in memory only:", err.message);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveStore();
  }, 1000);
  saveTimer.unref?.();
}

/** Take responsibility for greeting someone. False means somebody already did. */
function claimWelcome(chatId, userId) {
  const key = `${chatId}:${userId}`;
  if (welcomed.has(key)) return false;
  welcomed.set(key, Date.now());
  scheduleSave();
  return true;
}

/** Hand the claim back when nothing could actually be delivered. */
function releaseWelcome(chatId, userId) {
  welcomed.delete(`${chatId}:${userId}`);
  scheduleSave();
}

loadStore();

/* ------------------------------ welcoming ------------------------------ */

/**
 * Greet one new member: in the group itself, and privately when Telegram lets
 * us. A private message only goes through if the user has already started the
 * bot, or within the window Telegram opens after a join request — a failure
 * there is normal and stays quiet.
 *
 * Returns whether anything actually reached them.
 */
async function welcomeMember(telegram, { chat, user, dmOnly = false }) {
  const text = render(store.get("WELCOME_MESSAGE"), { user, chat });
  const extra = welcomeKeyboard();
  const where = chat?.title || chat?.id;
  let delivered = false;

  if (!dmOnly && WELCOME_IN_GROUP && ["group", "supergroup"].includes(chat?.type)) {
    try {
      await sendHtml(telegram, chat.id, text, extra);
      delivered = true;
      console.log(`[bot] Welcomed ${user.first_name} (${user.id}) in "${where}".`);
    } catch (err) {
      console.error(`[bot] Could not post the welcome in "${where}":`, err.message);
    }
  }

  if (WELCOME_IN_DM) {
    try {
      await sendHtml(telegram, user.id, text, extra);
      delivered = true;
      console.log(`[bot] Sent the welcome DM to ${user.first_name} (${user.id}).`);
    } catch (err) {
      // 403 is the ordinary case: the user has never opened a chat with the
      // bot, so Telegram will not let it start one.
      if (err?.response?.error_code !== 403) {
        console.error(`[bot] Welcome DM to ${user.id} failed:`, err.message);
      }
    }
  }

  return delivered;
}

/** Claim, greet, and give the claim back if nothing got through. */
async function welcomeOnce(telegram, { chat, user, dmOnly = false }) {
  if (!claimWelcome(chat.id, user.id)) return false;

  const delivered = await welcomeMember(telegram, { chat, user, dmOnly });
  if (!delivered) {
    // Let whichever join signal arrives next try again rather than silently
    // dropping this member.
    releaseWelcome(chat.id, user.id);
  }
  return delivered;
}

/* -------------------------------- the bot ------------------------------ */

function createBot(token) {
  const bot = new Telegraf(token, {
    handlerTimeout: 30_000,
    // Telegraf otherwise piggybacks the first API call of each update onto the
    // webhook's own HTTP response, which returns no result — errors would be
    // invisible and the retries above could never fire.
    telegram: { webhookReply: false },
  });

  bot.catch((err, ctx) => {
    console.error(`[bot] Failed to handle ${ctx?.updateType} update:`, err);
  });

  /* --- commands --- */
  // Telegraf matches both `/link` and `/link@thisbot`, so these work in a
  // private chat and in a group without any extra wiring.

  bot.start(async (ctx) => {
    await sendHtml(
      ctx.telegram,
      ctx.chat.id,
      render(store.get("WELCOME_MESSAGE"), { user: ctx.from, chat: ctx.chat }),
      welcomeKeyboard()
    );
  });

  bot.command("link", async (ctx) => {
    await sendHtml(
      ctx.telegram,
      ctx.chat.id,
      render(store.get("LINK_MESSAGE"), { user: ctx.from, chat: ctx.chat }),
      linkKeyboard()
    );
  });

  bot.command("ib", async (ctx) => {
    await sendHtml(
      ctx.telegram,
      ctx.chat.id,
      render(store.get("IB_MESSAGE"), { user: ctx.from, chat: ctx.chat }),
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
      await sendHtml(ctx.telegram, target, store.get("WELCOME_MESSAGE"), welcomeKeyboard());
      await ctx.reply(`Posted to ${target}.`);
    } catch (err) {
      await ctx.reply(
        `Could not post to ${target}: ${err.message}\n\n` +
          "Check that the id is right and that I am an administrator there with " +
          '"Post Messages" permission.'
      );
    }
  });

  /* --- editing the messages from Telegram --- */

  bot.command("edit", async (ctx) => {
    if (!isAdmin(ctx) || ctx.chat.type !== "private") return;
    await editor.showMenu(ctx);
  });

  bot.action(/^edit:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    await editor.beginEdit(ctx, ctx.match[1]);
  });

  bot.command("reset", async (ctx) => {
    if (!isAdmin(ctx) || ctx.chat.type !== "private") return;
    if (!(await editor.resetCurrent(ctx))) {
      await ctx.reply("Nothing being edited. Send /edit first, then /reset to undo that one.");
    }
  });

  /* --- signing the userbot in, without needing a terminal --- */

  bot.command("userbot", async (ctx) => {
    if (!isAdmin(ctx) || ctx.chat.type !== "private") return;
    await ctx.reply(sessionStatus());
  });

  bot.command("login", async (ctx) => {
    if (!isAdmin(ctx)) return;
    if (ctx.chat.type !== "private") {
      // A login code posted in a group would be readable by everyone there.
      return ctx.reply("Send /login in a private chat with me, not in a group.");
    }

    await startLogin({
      userId: ctx.from.id,
      send: (html) => sendHtml(ctx.telegram, ctx.chat.id, html),
      remove: (messageId) => ctx.telegram.deleteMessage(ctx.chat.id, messageId),
    });
  });

  bot.command("cancel", async (ctx) => {
    if (!isAdmin(ctx) || ctx.chat.type !== "private") return;
    if (cancelLogin(ctx.from.id)) return;
    if (editor.cancelEdit(ctx.from.id)) return ctx.reply("Left that message as it was.");
    await ctx.reply("Nothing to cancel.");
  });

  // The admin's plain messages belong to whichever conversation is open — a
  // login in progress, or a message being rewritten. Registered before the
  // other handlers so a login code or a new VIP post never falls through.
  bot.on(message("text"), async (ctx, next) => {
    if (ctx.chat.type !== "private" || !isAdmin(ctx)) return next();

    if (isLoggingIn(ctx.from.id)) {
      // Commands are answers here too: a code or a password could start with a
      // slash, and /cancel has its own handler registered earlier.
      if (ctx.message.text.trim() === "/cancel") return next();
      return provideAnswer(ctx.from.id, ctx.message.text.trim(), ctx.message.message_id);
    }

    if (editor.isEditing(ctx.from.id)) {
      if (["/cancel", "/reset"].includes(ctx.message.text.trim())) return next();
      if (await editor.applyEdit(ctx)) return;
    }

    return next();
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

    await welcomeOnce(ctx.telegram, { chat, user: from, dmOnly: true });
  });

  // Service message posted in basic groups and most supergroups.
  bot.on(message("new_chat_members"), async (ctx) => {
    for (const user of ctx.message.new_chat_members) {
      if (user.is_bot) continue;
      await welcomeOnce(ctx.telegram, { chat: ctx.chat, user });
    }
  });

  // Covers channels and any supergroup with service messages hidden. Telegram
  // only sends this to administrators, which is why the bot has to be one.
  bot.on("chat_member", async (ctx) => {
    const { chat, old_chat_member: before, new_chat_member: after } = ctx.chatMember;
    const user = after.user;
    if (user.is_bot) return;

    const wasOutside = ["left", "kicked"].includes(before.status);
    const isInside = ["member", "administrator", "restricted"].includes(after.status);
    if (!wasOutside || !isInside) return;

    await welcomeOnce(ctx.telegram, { chat, user });
  });

  // The bot itself being added or promoted. Posting the VIP message right then
  // means adding the bot as an administrator is the entire setup: the post the
  // members are meant to click is already there, and seeing it appear confirms
  // the permissions are right.
  bot.on("my_chat_member", async (ctx) => {
    const { chat, old_chat_member: before, new_chat_member: after, from } = ctx.myChatMember;

    const wasActive = ["member", "administrator"].includes(before.status);
    const isActive = ["member", "administrator"].includes(after.status);
    const justArrived = !wasActive && isActive;
    const justPromoted = wasActive && after.status === "administrator" && before.status !== "administrator";
    if (!justArrived && !justPromoted) return;

    // A channel only accepts posts from an administrator, so wait for the
    // promotion rather than failing on the way in.
    if (chat.type === "channel" && after.status !== "administrator") return;

    console.log(
      `[bot] Added to ${chat.type} "${chat.title || chat.id}" as ${after.status}. ` +
        `Chat id: ${chat.id}`
    );

    // Same claim mechanism as members, so a demote-then-promote does not post
    // the message a second time.
    if (!claimWelcome(chat.id, "bot-joined")) return;

    try {
      await sendHtml(ctx.telegram, chat.id, store.get("WELCOME_MESSAGE"), welcomeKeyboard());
      console.log(`[bot] Published the VIP post to "${chat.title || chat.id}".`);
    } catch (err) {
      releaseWelcome(chat.id, "bot-joined");
      console.error(
        `[bot] Could not post in "${chat.title || chat.id}": ${err.message}. ` +
          'The bot needs administrator rights with "Post Messages".'
      );
      return;
    }

    // Tell whoever added it what the chat id is, so CHANNEL_ID can be filled in
    // without hunting for it. Only works if they have opened the bot before.
    try {
      await ctx.telegram.sendMessage(
        from.id,
        `I'm live in "${chat.title || chat.id}" and will welcome everyone who joins.\n\n` +
          `Chat id: <code>${chat.id}</code>`,
        { parse_mode: "HTML" }
      );
    } catch {
      // They have never messaged the bot. The console line above still has it.
    }
  });

  return bot;
}

module.exports = {
  createBot,
  ALLOWED_UPDATES,
  sendHtml,
  toPlainText,
  stripCustomEmoji,
  STORE_FILE,
};
