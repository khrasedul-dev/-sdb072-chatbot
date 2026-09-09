/**
 * Signing the userbot in from inside a Telegram chat with the bot.
 *
 * The CLI login needs a terminal. When the session expires — someone clears the
 * account's devices, or Telegram invalidates it — that means finding a machine
 * with SSH access before /link and /ib work again. This runs the same GramJS
 * login as a conversation with @Scarfxxbot instead, so it can be fixed from a
 * phone.
 *
 * Only the admin can start it, only in a private chat, and every message
 * carrying a phone number, code or password is deleted as soon as it is read.
 */
const { exec } = require("child_process");
const path = require("path");

const { createClient } = require("./userbot");
const { writeSessionToEnv, hasSession } = require("./env-file");
const { TELEGRAM_API_ID, TELEGRAM_API_HASH } = require("./config");

const ROOT = path.join(__dirname, "..");
const TIMEOUT_MS = 5 * 60 * 1000;

/** One login at a time per admin, keyed by their user id. */
const conversations = new Map();

const isLoggingIn = (userId) => conversations.has(userId);

/** Route an admin's reply into a login in progress. True if it was consumed. */
function provideAnswer(userId, text, messageId) {
  const conversation = conversations.get(userId);
  if (!conversation) return false;
  conversation.answer(text, messageId);
  return true;
}

function cancelLogin(userId) {
  const conversation = conversations.get(userId);
  if (!conversation) return false;
  conversation.cancel();
  return true;
}

/**
 * Telegram invalidates a login code the moment it is sent as a Telegram
 * message — an anti-phishing measure, and it fires on our own chat too. Typing
 * the digits apart dodges the pattern match, so that is what we ask for and
 * anything non-numeric is stripped back out here.
 */
const digitsOnly = (text) => String(text).replace(/\D/g, "");

/**
 * Bring the userbot up with the session that was just written. Best effort: on
 * a machine without PM2 the session is still saved, and the next start picks it
 * up.
 */
function restartUserbot() {
  const command =
    "pm2 describe vip-userbot >/dev/null 2>&1 " +
    "&& pm2 restart vip-userbot --update-env " +
    "|| pm2 start deploy/ecosystem.config.cjs --only vip-userbot";

  return new Promise((resolve) => {
    exec(command, { cwd: ROOT, timeout: 30_000 }, (err) => {
      if (err) return resolve(false);
      exec("pm2 save --force", { cwd: ROOT, timeout: 30_000 }, () => resolve(true));
    });
  });
}

/**
 * Run the whole login as a conversation.
 *
 * `send` posts a message to the admin, `remove` deletes one of their messages.
 * GramJS drives the order: it calls back for the phone, then the code, then the
 * password only if the account has two-step on, and asks again by itself when a
 * code is mistyped.
 */
async function startLogin({ userId, send, remove }) {
  if (conversations.has(userId)) {
    await send("A login is already in progress. Finish it, or send /cancel.");
    return;
  }

  if (!TELEGRAM_API_ID || !TELEGRAM_API_HASH) {
    await send(
      "TELEGRAM_API_ID and TELEGRAM_API_HASH are missing from the server's .env.\n\n" +
        "Get them from my.telegram.org → API development tools, add them, then try again."
    );
    return;
  }

  let resolveAnswer = null;
  let finished = false;

  const cleanup = () => {
    finished = true;
    clearTimeout(timer);
    conversations.delete(userId);
  };

  const timer = setTimeout(() => {
    if (finished) return;
    cleanup();
    resolveAnswer?.(null);
    send("Login timed out after 5 minutes. Send /login to start again.").catch(() => {});
  }, TIMEOUT_MS);
  timer.unref?.();

  /** Wait for the admin's next message. */
  const waitForAnswer = () =>
    new Promise((resolve) => {
      resolveAnswer = resolve;
    });

  /**
   * Ask, then wait. The waiting promise is armed before the question goes out,
   * so an answer that arrives immediately is not missed.
   */
  const ask = (question) => {
    const answer = waitForAnswer();
    send(question).catch(() => {});
    return answer;
  };

  conversations.set(userId, {
    answer(text, messageId) {
      // These messages hold a phone number, a login code or a password. None of
      // them should stay in the chat history.
      if (messageId) remove(messageId).catch(() => {});
      const resolve = resolveAnswer;
      resolveAnswer = null;
      resolve?.(text);
    },
    cancel() {
      cleanup();
      resolveAnswer?.(null);
      send("Login cancelled.").catch(() => {});
    },
  });

  const required = (value, what) => {
    if (value === null || value === undefined || value === "") {
      throw new Error(`Cancelled before the ${what} was given.`);
    }
    return value;
  };

  const client = createClient("");

  try {
    await send(
      "<b>Signing the userbot in</b>\n\n" +
        "This logs in the account that sends /link and /ib — your own account, " +
        "not the bot.\n\n" +
        "Send /cancel at any point. Everything you type here is deleted as soon " +
        "as I read it.\n\n" +
        "<b>Phone number?</b> With the country code, e.g. <code>+31612345678</code>"
    );

    // The opening message above already asked for the number, so the first
    // callback just waits; a second call means Telegram rejected it.
    let phoneAlreadyAsked = true;

    await client.start({
      phoneNumber: async () => {
        const answer = phoneAlreadyAsked
          ? await waitForAnswer()
          : await ask("<b>Phone number?</b> With the country code, e.g. <code>+31612345678</code>");
        phoneAlreadyAsked = false;
        return required(answer, "phone number").replace(/[^\d+]/g, "");
      },

      phoneCode: async () => {
        const answer = await ask(
          "Telegram has sent a login code.\n\n" +
            "<b>Type it with spaces between the digits</b> — <code>1 2 3 4 5</code>, not <code>12345</code>.\n\n" +
            "Telegram cancels any code that appears in a chat as a plain number, " +
            "so a code sent the normal way will simply not work."
        );
        return digitsOnly(required(answer, "code"));
      },

      password: async () => {
        const answer = await ask(
          "This account has two-step verification.\n\n<b>Cloud password?</b>"
        );
        return required(answer, "password");
      },

      onError: async (err) => {
        const message = err?.errorMessage || err?.message || String(err);
        if (/PHONE_CODE_INVALID/i.test(message)) {
          await send("That code was not accepted. Try again — digits spaced apart.");
          return false; // let GramJS ask once more
        }
        if (/PHONE_CODE_EXPIRED/i.test(message)) {
          await send("That code has expired. Send /login to start again.");
          return true;
        }
        await send(`Telegram said: <code>${message}</code>`);
        return true;
      },
    });

    const me = await client.getMe();
    const session = client.session.save();
    writeSessionToEnv(session);
    cleanup();

    await send(
      `Signed in as <b>${me.username ? "@" + me.username : me.firstName}</b>.\n\n` +
        "Session saved. Starting the userbot…"
    );

    const restarted = await restartUserbot();
    await send(
      restarted
        ? "Userbot is running. Try /ib in a chat with someone — it should expand."
        : "Session is saved, but I could not start the userbot from here. " +
            "Run <code>pm2 start deploy/ecosystem.config.cjs --only vip-userbot</code> on the server."
    );
  } catch (err) {
    cleanup();
    const message = err?.errorMessage || err?.message || String(err);
    if (!/Cancelled before/.test(message)) {
      await send(`Login failed: <code>${message}</code>\n\nSend /login to try again.`).catch(() => {});
    }
  } finally {
    // This client existed only to obtain the session; the long-running userbot
    // is a separate process that reads it back from .env.
    try {
      await client.destroy();
    } catch {
      // Already gone, or never connected.
    }
  }
}

/** One-line summary for the admin's /userbot command. */
function sessionStatus() {
  if (!TELEGRAM_API_ID || !TELEGRAM_API_HASH) {
    return "Not configured — TELEGRAM_API_ID and TELEGRAM_API_HASH are missing from .env.";
  }
  return hasSession()
    ? "A session is saved. If /link and /ib have stopped expanding, send /login to sign in again."
    : "No session saved. Send /login to sign in.";
}

module.exports = { startLogin, provideAnswer, cancelLogin, isLoggingIn, sessionStatus, digitsOnly };
