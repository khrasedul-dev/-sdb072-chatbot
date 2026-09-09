/**
 * Text helpers shared by the bot and the userbot, so a message written once in
 * messages.js reads the same whichever account sends it.
 */
const { ADMIN_USERNAME } = require("./config");

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

/**
 * Fill {name} / {username} / {chat} / {admin} in a message template.
 *
 * `mention: false` for the userbot — a tg://user link renders as an underlined
 * mention, which looks like a bot template in a one-to-one conversation. The
 * plain first name reads like something a person typed.
 */
function render(template, { user, chat, mention = true } = {}) {
  const firstName = escapeHtml(user?.first_name || user?.firstName || "there");
  const named =
    mention && user?.id ? `<a href="tg://user?id=${user.id}">${firstName}</a>` : firstName;

  return String(template ?? "")
    .replace(/\{name\}/g, named)
    .replace(/\{username\}/g, user?.username ? `@${user.username}` : firstName)
    .replace(/\{chat\}/g, escapeHtml(chat?.title || "our community"))
    .replace(/\{admin\}/g, ADMIN_USERNAME);
}

module.exports = { escapeHtml, stripCustomEmoji, toPlainText, render };
