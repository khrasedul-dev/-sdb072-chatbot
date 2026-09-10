/**
 * One pinned post per chat, kept up to date.
 *
 * The client did not want a message every time somebody joined — that turned
 * the group into a wall of welcomes. They want ONE message, pinned, that new
 * members read when they arrive. So the bot posts it once (when it is added to
 * the chat, or when an admin sends /post), pins it, and remembers where it put
 * it.
 *
 * Remembering is the whole point: when the welcome text is rewritten from
 * Telegram with /edit, every pinned post is edited in place. The client changes
 * the message once and the pin updates itself — no repost, no second pin, no
 * unpinning and pinning again.
 *
 * The list lives on disk because a deploy reloads the process, and a forgotten
 * pin would mean a duplicate post the next time the bot was promoted.
 */
const fs = require("fs");
const path = require("path");

const store = require("./store");
const { render } = require("./format");
const { welcomeKeyboard } = require("./keyboards");
const { sendHtml, editHtml } = require("./send");

const STORE_FILE = path.join(__dirname, "..", "data", "pinned.json");

/** chat id (as a string, because JSON keys are) -> { messageId, title, at } */
const pins = new Map();
let writable = true;

/** Chat ids are negative numbers; JSON turns them into strings on the way out. */
const asChatId = (key) => (/^-?\d+$/.test(key) ? Number(key) : key);

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    for (const [chatId, record] of Object.entries(raw)) pins.set(chatId, record);
    if (pins.size) console.log(`[pinned] Tracking ${pins.size} pinned post(s).`);
  } catch (err) {
    if (err.code !== "ENOENT") console.warn("[pinned] Could not read the pinned list:", err.message);
  }
}

function save() {
  if (!writable) return;
  try {
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    // Write-then-rename, so a crash mid-write cannot leave a half-written file
    // that parses as empty and makes the bot post all over again.
    const tmp = `${STORE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(pins), null, 2), "utf8");
    fs.renameSync(tmp, STORE_FILE);
  } catch (err) {
    writable = false;
    console.warn("[pinned] Cannot persist the pinned list, staying in memory only:", err.message);
  }
}

/** Is there already a post being maintained in this chat? */
const has = (chatId) => pins.has(String(chatId));

const get = (chatId) => pins.get(String(chatId));

function remember(chatId, messageId, title) {
  pins.set(String(chatId), { messageId, title: title || null, at: Date.now() });
  save();
}

function forget(chatId) {
  if (pins.delete(String(chatId))) save();
}

/** The post as it should look right now, from whatever /edit last saved. */
const welcomeText = (chat) => render(store.get("WELCOME_MESSAGE"), { chat });

/**
 * Post the message into a chat, pin it, and remember it.
 *
 * A failed pin is not a failed post: the message is still tracked, so /edit
 * keeps it current, and the admin can pin it by hand. Only the send failing is
 * an error worth propagating.
 */
async function postAndPin(telegram, chat, { pin = true } = {}) {
  const previous = get(chat.id);

  const message = await sendHtml(telegram, chat.id, welcomeText(chat), welcomeKeyboard());
  remember(chat.id, message.message_id, chat.title);

  // Telegram keeps a *list* of pinned messages, so pinning a replacement
  // without unpinning the old one leaves the chat with two. The client asked
  // for one message pinned — this keeps it at one.
  if (previous && previous.messageId !== message.message_id) {
    try {
      await telegram.unpinChatMessage(chat.id, previous.messageId);
    } catch (err) {
      console.warn(`[pinned] Could not unpin the previous post in ${chat.id}: ${err.message}`);
    }
  }

  if (pin) {
    try {
      // Silent: the post is for people arriving later, not a notification for
      // everyone already in the chat.
      await telegram.pinChatMessage(chat.id, message.message_id, { disable_notification: true });
      console.log(`[pinned] Posted and pinned in "${chat.title || chat.id}".`);
    } catch (err) {
      console.warn(
        `[pinned] Posted in "${chat.title || chat.id}" but could not pin it: ${err.message}. ` +
          'The bot needs the "Pin Messages" right.'
      );
    }
  }

  return message;
}

/**
 * Re-render every pinned post from the current text and buttons. Called after
 * the admin edits any part of the welcome post from Telegram.
 *
 * A post that has been deleted is quietly forgotten rather than retried
 * forever. Returns how many were updated.
 */
async function refreshAll(telegram) {
  if (!telegram || pins.size === 0) return 0;

  let updated = 0;
  for (const [key, record] of [...pins]) {
    const chat = { id: asChatId(key), title: record.title };
    try {
      await editHtml(telegram, chat.id, record.messageId, welcomeText(chat), welcomeKeyboard());
      updated++;
    } catch (err) {
      const description = err?.response?.description || err.message || "";
      if (/not found|can't be edited|MESSAGE_ID_INVALID/i.test(description)) {
        console.warn(`[pinned] The post in "${record.title || key}" is gone — forgetting it.`);
        forget(key);
      } else {
        console.error(`[pinned] Could not update the post in "${record.title || key}": ${description}`);
      }
    }
  }
  return updated;
}

/** How many posts are being maintained, for the /edit confirmation. */
const count = () => pins.size;

load();

module.exports = {
  postAndPin,
  refreshAll,
  remember,
  forget,
  has,
  get,
  count,
  welcomeText,
  STORE_FILE,
};
