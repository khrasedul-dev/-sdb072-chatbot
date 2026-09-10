/**
 * Sending and editing Telegram HTML messages, with the retries that keep a
 * message from being lost to a temporary refusal.
 *
 * Both helpers work around the same three cases:
 *   - 400 on <tg-emoji>, which only bots with a Fragment username may send.
 *     Resent once with the plain fallback emoji.
 *   - 429, a burst over the rate limit. Telegram says how long to wait and that
 *     it did NOT send, so waiting and retrying cannot duplicate anything.
 *   - 5xx, Telegram failing on its own side before the message goes out.
 *
 * A network-level failure is deliberately NOT retried here: the message may
 * have arrived before the connection dropped, and a blind retry would post it
 * twice.
 */
const { stripCustomEmoji } = require("./format");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const EMOJI_REFUSAL = /emoji|entit|pars|tag/i;

/** Send a new HTML message. Returns the sent message. */
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

      if (code === 400 && !strippedEmoji && EMOJI_REFUSAL.test(description)) {
        console.warn(`[send] Telegram rejected the HTML (${description}) — resending with plain emoji.`);
        text = stripCustomEmoji(text);
        strippedEmoji = true;
        continue;
      }

      const retryAfter = err?.response?.parameters?.retry_after ?? err?.parameters?.retry_after;
      if (code === 429 && attempt <= 4) {
        const waitMs = (retryAfter ?? attempt) * 1000 + 250;
        console.warn(`[send] Rate limited on chat ${chatId} — waiting ${waitMs}ms then retrying.`);
        await sleep(waitMs);
        continue;
      }

      if (code >= 500 && attempt <= 3) {
        console.warn(`[send] Telegram returned ${code} (${description}) — retry ${attempt}.`);
        await sleep(attempt * 1000);
        continue;
      }

      throw err;
    }
  }
}

/**
 * Edit an existing message in place. Same emoji / rate-limit handling as
 * sendHtml, plus the two outcomes only an edit has:
 *   "message is not modified" — the new content equals the old, nothing to do,
 *     returned as null rather than thrown.
 *   "message to edit not found" / "can't be edited" — rethrown, so the caller
 *     can forget a message that has been deleted.
 */
async function editHtml(telegram, chatId, messageId, html, extra = {}) {
  const options = {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...extra,
  };

  let text = html;
  let strippedEmoji = false;

  for (let attempt = 1; ; attempt++) {
    try {
      return await telegram.editMessageText(chatId, messageId, undefined, text, options);
    } catch (err) {
      const code = err?.response?.error_code;
      const description = err?.response?.description || "";

      if (/message is not modified/i.test(description)) return null;

      if (code === 400 && !strippedEmoji && EMOJI_REFUSAL.test(description)) {
        text = stripCustomEmoji(text);
        strippedEmoji = true;
        continue;
      }

      const retryAfter = err?.response?.parameters?.retry_after ?? err?.parameters?.retry_after;
      if (code === 429 && attempt <= 4) {
        await sleep((retryAfter ?? attempt) * 1000 + 250);
        continue;
      }

      if (code >= 500 && attempt <= 3) {
        await sleep(attempt * 1000);
        continue;
      }

      throw err;
    }
  }
}

module.exports = { sendHtml, editHtml, sleep };
