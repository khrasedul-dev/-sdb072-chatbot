/**
 * Turning a Telegram message back into the HTML that produced it.
 *
 * This is what makes the messages editable from Telegram. The admin writes the
 * new text in Telegram — bold, links, and above all the premium emoji picked
 * from their own keyboard — and Telegram delivers it as plain text plus a list
 * of entities. Storing the plain text alone would throw the formatting away;
 * storing it as HTML keeps every custom emoji id, so the bot and the userbot can
 * send exactly what was typed.
 *
 * Offsets from Telegram are counted in UTF-16 code units, which is also how
 * JavaScript indexes a string — so text[offset] lines up with no conversion.
 * An emoji is two of those units; walking unit by unit and re-joining the halves
 * is safe because the escaping below only touches ASCII.
 */

const escapeHtml = (text) =>
  String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/**
 * Entity types that carry formatting. The ones left out — url, mention,
 * hashtag, bot_command, email, phone_number, cashtag — are things Telegram
 * detects in plain text and will detect again on the way out, so wrapping them
 * would only add noise.
 */
const TAGS = {
  bold: () => ["<b>", "</b>"],
  italic: () => ["<i>", "</i>"],
  underline: () => ["<u>", "</u>"],
  strikethrough: () => ["<s>", "</s>"],
  spoiler: () => ["<tg-spoiler>", "</tg-spoiler>"],
  blockquote: () => ["<blockquote>", "</blockquote>"],
  expandable_blockquote: () => ["<blockquote expandable>", "</blockquote>"],
  code: () => ["<code>", "</code>"],
  pre: (e) =>
    e.language
      ? [`<pre><code class="language-${escapeHtml(e.language)}">`, "</code></pre>"]
      : ["<pre>", "</pre>"],
  text_link: (e) => [`<a href="${escapeHtml(e.url)}">`, "</a>"],
  text_mention: (e) => [`<a href="tg://user?id=${e.user?.id}">`, "</a>"],
  custom_emoji: (e) => [`<tg-emoji emoji-id="${escapeHtml(e.custom_emoji_id)}">`, "</tg-emoji>"],
};

/**
 * Rebuild the HTML source of a message.
 *
 * @param {string} text      message.text or message.caption
 * @param {Array}  entities  message.entities or message.caption_entities
 */
function entitiesToHtml(text, entities = []) {
  const source = String(text ?? "");
  const usable = (entities || [])
    .filter((e) => TAGS[e.type])
    .map((e) => ({ ...e, end: e.offset + e.length }))
    .filter((e) => e.length > 0 && e.offset >= 0 && e.end <= source.length);

  if (!usable.length) return escapeHtml(source);

  // Outer first at a shared offset: a longer run has to wrap a shorter one, or
  // the tags interleave instead of nesting.
  usable.sort((a, b) => a.offset - b.offset || b.length - a.length);

  let out = "";
  let next = 0;
  const open = []; // innermost last

  for (let pos = 0; pos <= source.length; pos++) {
    while (open.length && open[open.length - 1].end === pos) {
      out += open.pop().close;
    }

    while (next < usable.length && usable[next].offset === pos) {
      const entity = usable[next++];
      const [openTag, closeTag] = TAGS[entity.type](entity);

      // Telegram normally nests entities, but a run that reaches past its
      // parent would produce crossed tags. Clip it to the parent instead of
      // emitting HTML no parser will accept.
      const parent = open[open.length - 1];
      const end = parent ? Math.min(entity.end, parent.end) : entity.end;
      if (end <= pos) continue;

      out += openTag;
      open.push({ end, close: closeTag });
    }

    if (pos === source.length) break;
    // One UTF-16 unit at a time. Half of a surrogate pair passes through
    // untouched and rejoins its partner on the next iteration.
    out += escapeHtml(source[pos]);
  }

  return out;
}

/** Pull the HTML out of a whole message object, text or caption. */
function messageToHtml(message) {
  if (!message) return "";
  if (typeof message.text === "string") return entitiesToHtml(message.text, message.entities);
  if (typeof message.caption === "string") return entitiesToHtml(message.caption, message.caption_entities);
  return "";
}

module.exports = { entitiesToHtml, messageToHtml, escapeHtml };
