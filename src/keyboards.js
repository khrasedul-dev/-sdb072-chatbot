/**
 * The inline keyboards, in one place so the bot, the /post command and the
 * pinned-post refresher all build exactly the same buttons.
 */
const { Markup } = require("telegraf");

const store = require("./store");
const { toPlainText } = require("./format");
const { ADMIN_USERNAME } = require("./config");

/** Button that opens the admin's DM with the join message already typed out. */
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

module.exports = { welcomeKeyboard, linkKeyboard, ibKeyboard };
