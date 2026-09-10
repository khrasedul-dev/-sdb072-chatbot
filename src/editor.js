/**
 * Editing the bot's messages from Telegram.
 *
 * The admin sends /edit, picks a message, and types the replacement the way
 * they would type any Telegram message — bold, links, and the premium emoji
 * from their own keyboard. What arrives is plain text plus entities;
 * entitiesToHtml turns it back into the HTML the bot stores and re-sends, so
 * every custom emoji id survives the round trip.
 */
const { Markup } = require("telegraf");

const store = require("./store");
const pinned = require("./pinned");
const { messageToHtml, escapeHtml } = require("./entities");

/** One edit at a time per admin: userId -> { key } */
const editing = new Map();

/**
 * The keys the pinned post is built from: its text, its button label, and the
 * DM that button pre-types. Changing any of them has to change the message
 * already pinned in the group — that is the point of pinning one message
 * instead of greeting every arrival.
 */
const PINNED_KEYS = ["WELCOME_MESSAGE", "WELCOME_BUTTON_TEXT", "WELCOME_PREFILLED_DM"];

/**
 * Push a just-saved change out to every pinned post. Never throws: the edit is
 * already saved, and a chat the bot has been removed from must not turn a
 * successful edit into an error.
 */
async function syncPinned(ctx, key) {
  if (!PINNED_KEYS.includes(key) || pinned.count() === 0) return;

  try {
    const updated = await pinned.refreshAll(ctx.telegram);
    if (updated === 1) {
      await ctx.reply("The pinned message has been updated too.");
    } else if (updated > 1) {
      await ctx.reply(`The pinned message has been updated in ${updated} chats too.`);
    }
  } catch (err) {
    await ctx.reply(`Saved, but the pinned message could not be updated: ${err.message}`);
  }
}

const isEditing = (userId) => editing.has(userId);

function cancelEdit(userId) {
  return editing.delete(userId);
}

/** Shorten a message for a menu row without cutting a tag in half. */
function preview(html, max = 60) {
  const plain = String(html ?? "")
    .replace(/<tg-emoji[^>]*>([\s\S]*?)<\/tg-emoji>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? plain.slice(0, max - 1) + "…" : plain || "(empty)";
}

function menuKeyboard() {
  const rows = store.KEYS.map((key) => [
    Markup.button.callback(
      `${store.isEdited(key) ? "✏️" : "•"} ${store.EDITABLE[key].label}`,
      `edit:${key}`
    ),
  ]);
  return Markup.inlineKeyboard(rows);
}

async function showMenu(ctx) {
  if (!store.isConnected()) {
    return ctx.reply(
      "Not connected to MongoDB, so edits cannot be saved.\n\n" +
        "Check MONGODB_URI in the server's .env, then restart the bot."
    );
  }

  const when = await store.history();
  const lines = store.KEYS.map((key) => {
    const at = when[key]?.updatedAt;
    const stamp = at ? new Date(at).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "original";
    return `<b>${store.EDITABLE[key].label}</b>\n<i>${stamp}</i> — ${escapeHtml(preview(store.get(key), 45))}`;
  });

  await ctx.reply(
    "<b>Which message do you want to change?</b>\n\n" +
      lines.join("\n\n") +
      "\n\n✏️ marks the ones already edited.",
    { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...menuKeyboard() }
  );
}

/** The admin tapped a row in the menu. */
async function beginEdit(ctx, key) {
  if (!store.EDITABLE[key]) return;

  editing.set(ctx.from.id, { key });
  const { label, kind } = store.EDITABLE[key];

  const how = {
    html:
      "Send the new message the way you want it to look — <b>bold</b>, links and " +
      "your premium emoji all come through exactly as you type them.",
    text: "Send the new text. This one goes inside a button, so plain text only.",
    url: "Send the new link, starting with <code>https://</code>.",
  }[kind];

  await ctx.reply(
    `<b>${escapeHtml(label)}</b>\n\nCurrently:\n${store.get(key) || "<i>(empty)</i>"}\n\n` +
      `━━━━━━━━━━\n${how}\n\n/cancel to leave it alone, /reset to go back to the original.`,
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
  );
}

/**
 * The admin's next message is the replacement.
 * Returns true when it was consumed as an edit.
 */
async function applyEdit(ctx) {
  const pending = editing.get(ctx.from.id);
  if (!pending) return false;

  const { key } = pending;
  const { label, kind } = store.EDITABLE[key];

  // For an html message, rebuild the source from the entities so nothing the
  // admin typed is lost. For the plain kinds, the raw text is the value.
  const value = kind === "html" ? messageToHtml(ctx.message) : (ctx.message.text || "").trim();

  if (!value) {
    await ctx.reply("That came through empty. Send the new text, or /cancel.");
    return true;
  }

  if (kind === "url" && !/^https?:\/\/\S+$/i.test(value)) {
    await ctx.reply("That is not a link. It has to start with http:// or https://. Try again, or /cancel.");
    return true;
  }

  // Telegram refuses anything over 4096 characters, and the HTML is what counts.
  if (value.length > 4096) {
    await ctx.reply(
      `That is ${value.length} characters once the formatting is included, and Telegram's limit is 4096. ` +
        "Shorten it and send again, or /cancel."
    );
    return true;
  }

  editing.delete(ctx.from.id);

  try {
    await store.set(key, value, ctx.from.username || String(ctx.from.id));
  } catch (err) {
    await ctx.reply(`Could not save it: ${err.message}`);
    return true;
  }

  await ctx.reply(`<b>${escapeHtml(label)}</b> saved. This is what people will see:`, { parse_mode: "HTML" });

  // Send it back exactly as it will go out. If Telegram rejects the formatting
  // here, it would have rejected it in front of a member — better to find out
  // now, and to say which part is at fault.
  try {
    await ctx.reply(value, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  } catch (err) {
    await ctx.reply(
      `Saved, but Telegram would not render it back: ${err.response?.description || err.message}\n\n` +
        "Send /edit and try again if that looks wrong."
    );
  }

  await syncPinned(ctx, key);

  return true;
}

/** /reset while an edit is open: drop the override for that key. */
async function resetCurrent(ctx) {
  const pending = editing.get(ctx.from.id);
  if (!pending) return false;

  editing.delete(ctx.from.id);
  try {
    await store.reset(pending.key);
    await ctx.reply(`${store.EDITABLE[pending.key].label} is back to the original text.`);
    // A reset changes the text just as much as an edit does.
    await syncPinned(ctx, pending.key);
  } catch (err) {
    await ctx.reply(`Could not reset it: ${err.message}`);
  }
  return true;
}

module.exports = { showMenu, beginEdit, applyEdit, resetCurrent, isEditing, cancelEdit, preview };
