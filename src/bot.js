const { Telegraf } = require("telegraf");
const { message } = require("telegraf/filters");

const store = require("./store");
const editor = require("./editor");
const pinned = require("./pinned");
const { sendHtml } = require("./send");
const { welcomeKeyboard, linkKeyboard, ibKeyboard } = require("./keyboards");
const { stripCustomEmoji, toPlainText, render } = require("./format");
const {
  startLogin,
  provideAnswer,
  cancelLogin,
  isLoggingIn,
  sessionStatus,
} = require("./userbot-auth");
const { ADMINS, CHANNEL_ID, AUTO_APPROVE_JOIN_REQUESTS } = require("./config");

// Update types Telegram will not deliver unless we ask for them by name.
// `chat_member` is deliberately absent: the bot no longer reacts to individual
// joins, so there is no reason to be told about every one of them.
const ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "channel_post",
  "callback_query",
  "my_chat_member",
  "chat_join_request",
];

function createBot(token) {
  const bot = new Telegraf(token, {
    handlerTimeout: 30_000,
    // Telegraf otherwise piggybacks the first API call of each update onto the
    // webhook's own HTTP response, which returns no result — errors would be
    // invisible and the retries in send.js could never fire.
    telegram: { webhookReply: false },
  });

  bot.catch((err, ctx) => {
    console.error(`[bot] Failed to handle ${ctx?.updateType} update:`, err);
  });

  /* ------------------------------- commands ------------------------------ */
  // Private chats only. In a group the bot says nothing at all: the client asked
  // for the pinned post to be the group's single message, so a member typing
  // /link there gets no reply and the "/" menu lists nothing.

  bot.start(async (ctx) => {
    if (ctx.chat.type !== "private") return;
    await sendHtml(
      ctx.telegram,
      ctx.chat.id,
      render(store.get("WELCOME_MESSAGE"), { user: ctx.from, chat: ctx.chat }),
      welcomeKeyboard()
    );
  });

  bot.command("link", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    await sendHtml(
      ctx.telegram,
      ctx.chat.id,
      render(store.get("LINK_MESSAGE"), { user: ctx.from, chat: ctx.chat }),
      linkKeyboard()
    );
  });

  bot.command("ib", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    await sendHtml(
      ctx.telegram,
      ctx.chat.id,
      render(store.get("IB_MESSAGE"), { user: ctx.from, chat: ctx.chat }),
      ibKeyboard()
    );
  });

  /* -------------------------------- admin -------------------------------- */

  // Only the accounts in ADMINS can run the commands below. Matched on username
  // or on numeric id, because an account is allowed to have no username.
  const isAdmin = (ctx) => {
    const username = (ctx.from?.username || "").toLowerCase();
    const id = String(ctx.from?.id || "");
    return ADMINS.some((entry) => entry === username || entry === id);
  };

  /**
   * Refuse an admin command out loud when it was sent privately.
   *
   * Silence here is a trap: the command looks broken, and the only way to work
   * out why is to read the source. In a group it stays quiet — members typing
   * an admin command should not get an answer at all.
   */
  async function refuseAdmin(ctx) {
    if (ctx.chat?.type !== "private") return;
    const who = ctx.from?.username ? `@${ctx.from.username}` : `id ${ctx.from?.id}`;
    await ctx.reply(
      `That command is for the admin account, and you are ${who}.\n\n` +
        `Allowed right now: ${ADMINS.map((a) => (/^\d+$/.test(a) ? `id ${a}` : "@" + a)).join(", ")}\n\n` +
        "To add yourself, put your username in ADMINS in src/messages.js and push."
    );
  }

  // Anyone can ask, so there is no guessing about what to add to ADMINS.
  bot.command("whoami", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    const username = ctx.from.username ? `@${ctx.from.username}` : "(none)";
    await ctx.reply(
      `Username: ${username}\nUser id: <code>${ctx.from.id}</code>\n\n` +
        (isAdmin(ctx) ? "You are an admin." : "You are not an admin."),
      { parse_mode: "HTML" }
    );
  });

  /**
   * Put the pinned post into a chat by hand.
   *
   * `/post` inside the group posts there. `/post @channel` or `/post -100…`
   * targets another chat, and with neither it falls back to CHANNEL_ID. Either
   * way the message is pinned and remembered, so /edit keeps it current.
   */
  bot.command("post", async (ctx) => {
    if (!isAdmin(ctx)) return refuseAdmin(ctx);

    const argument = ctx.message.text.split(/\s+/)[1];
    const postable = ["group", "supergroup", "channel"].includes(ctx.chat.type);
    const target = argument || (postable ? ctx.chat.id : CHANNEL_ID);

    if (!target) {
      return ctx.reply(
        "Nowhere to post. Send /post inside the group itself, or /post @yourchannel " +
          "(use the -100… id for a private channel — forward me any post from it and " +
          "I will tell you the id)."
      );
    }

    // Reuse the chat we are already in; otherwise ask for the title so the
    // pinned record and the logs read as more than a bare id.
    let chat = { id: target };
    if (String(target) === String(ctx.chat.id)) {
      chat = ctx.chat;
    } else {
      try {
        chat = await ctx.telegram.getChat(target);
      } catch {
        // Unresolvable for now — posting below will report the real problem.
      }
    }

    const replacing = pinned.has(chat.id);

    try {
      await pinned.postAndPin(ctx.telegram, chat);
    } catch (err) {
      return ctx.reply(
        `Could not post to ${target}: ${err.message}\n\n` +
          "Check that the id is right and that I am an administrator there with " +
          "the Post Messages and Pin Messages permissions."
      );
    }

    const confirmation =
      `Posted in ${chat.title || target} and pinned it.` +
      (replacing
        ? "\n\nThat new message is the one /edit will keep up to date, and the previous one has been unpinned."
        : "\n\nSend /edit whenever you want to rewrite it; the pinned message updates itself.");

    // Run inside a group, /post should leave that group holding nothing but the
    // pinned post — so the command is cleared and the answer goes privately.
    if (["group", "supergroup"].includes(ctx.chat.type)) {
      try {
        await ctx.deleteMessage(ctx.message.message_id);
      } catch {
        // No "Delete Messages" right. The command stays; not worth failing over.
      }
      try {
        await ctx.telegram.sendMessage(ctx.from.id, confirmation);
        return;
      } catch {
        // They have never opened a chat with the bot — answer in the group.
      }
    }

    await ctx.reply(confirmation);
  });

  /* ------------------ editing the messages from Telegram ----------------- */

  bot.command("edit", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    if (!isAdmin(ctx)) return refuseAdmin(ctx);
    await editor.showMenu(ctx);
  });

  bot.action(/^edit:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) {
      // A pop-up, because a tap that does nothing looks like a broken button.
      return ctx.answerCbQuery("That menu belongs to the admin account.", { show_alert: true });
    }
    await ctx.answerCbQuery();
    await editor.beginEdit(ctx, ctx.match[1]);
  });

  bot.command("reset", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    if (!isAdmin(ctx)) return refuseAdmin(ctx);
    if (!(await editor.resetCurrent(ctx))) {
      await ctx.reply("Nothing being edited. Send /edit first, then /reset to undo that one.");
    }
  });

  /* ---------------- signing the userbot in, without a terminal ----------- */

  bot.command("userbot", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    if (!isAdmin(ctx)) return refuseAdmin(ctx);
    await ctx.reply(sessionStatus());
  });

  bot.command("login", async (ctx) => {
    if (!isAdmin(ctx)) return refuseAdmin(ctx);
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
    if (ctx.chat.type !== "private") return;
    if (!isAdmin(ctx)) return refuseAdmin(ctx);
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

  /* -------------------------------- joins -------------------------------- */

  // Nothing is sent to anyone who joins. The client was explicit about this: the
  // pinned post is the only message, and a greeting per member turned the group
  // into a wall of them. This handler only approves the request, when that is on.
  bot.on("chat_join_request", async (ctx) => {
    if (!AUTO_APPROVE_JOIN_REQUESTS) return;

    const { chat, from } = ctx.chatJoinRequest;
    try {
      await ctx.approveChatJoinRequest(from.id);
      console.log(`[bot] Approved ${from.first_name} (${from.id}) for "${chat.title || chat.id}".`);
    } catch (err) {
      console.error("[bot] Could not approve the join request:", err.message);
    }
  });

  // The bot itself being added or promoted. Posting right then means adding the
  // bot as an administrator is the entire setup: the message members are meant
  // to read is already there, and already pinned.
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
      `[bot] Added to ${chat.type} "${chat.title || chat.id}" as ${after.status}. Chat id: ${chat.id}`
    );

    // One post per chat, ever. A demote-then-promote, or Telegram redelivering
    // the update after a deploy, must not produce a second pinned message.
    if (pinned.has(chat.id)) {
      console.log(`[bot] "${chat.title || chat.id}" already has a post — leaving it alone.`);
      return;
    }

    try {
      await pinned.postAndPin(ctx.telegram, chat);
    } catch (err) {
      console.error(
        `[bot] Could not post in "${chat.title || chat.id}": ${err.message}. ` +
          "The bot needs administrator rights with Post Messages."
      );
      return;
    }

    // Tell whoever added it what the chat id is, so CHANNEL_ID can be filled in
    // without hunting for it. Only works if they have opened the bot before.
    try {
      await ctx.telegram.sendMessage(
        from.id,
        `Posted and pinned the message in "${chat.title || chat.id}".\n\n` +
          `Chat id: <code>${chat.id}</code>\n\n` +
          "Send /edit any time to rewrite it — the pinned message updates itself.",
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
};
