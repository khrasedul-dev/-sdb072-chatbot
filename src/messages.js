/**
 * ====================================================================
 *  ALL BOT TEXTS LIVE HERE — edit this one file to change any message.
 * ====================================================================
 *
 *  Formatting: Telegram HTML.
 *    <b>bold</b>  <i>italic</i>  <code>mono</code>
 *    <a href="https://example.com">link text</a>
 *    <tg-emoji emoji-id="123">🔥</tg-emoji>  (premium/custom emoji)
 *
 *  Placeholders you can use inside any message:
 *    {name}      -> new member's first name (clickable mention)
 *    {username}  -> @username, or first name when they have none
 *    {chat}      -> group / channel title
 *    {admin}     -> admin username without @
 *
 *  NOTE: <tg-emoji> only renders for bots that own a Fragment username.
 *  If Telegram rejects them the bot automatically re-sends the message
 *  with plain emoji instead, so nothing ever fails to deliver.
 */

// Shown on /start, and to anyone who joins a group/channel or is approved
// through a join request.
const WELCOME_MESSAGE = `🚀 WANT TO JOIN OUR FREE VIP? 🚀

<tg-emoji emoji-id="5224450179368767019">🌎</tg-emoji> CLICK THE BUTTON BELOW TO ENTER A NEW WORLD OF TRADING! <tg-emoji emoji-id="5424972470023104089">🔥</tg-emoji>

<tg-emoji emoji-id="5427168083074628963">💎</tg-emoji> FREE VIP BENEFITS:
<tg-emoji emoji-id="5244837092042750681">📈</tg-emoji> 3–6 trade setups per day
<tg-emoji emoji-id="5256131095094652290">🎯</tg-emoji> High win-rate targets of 80–95%
<tg-emoji emoji-id="5433623479050058279">🧠</tg-emoji> Professional trade analysis
<tg-emoji emoji-id="5411590687663608498">⚡</tg-emoji> Fast signals & market updates
<tg-emoji emoji-id="5456371000239212004">🤝</tg-emoji> 24/7 support & help
<tg-emoji emoji-id="5409048419211682843">💵</tg-emoji> Learn, improve & grow with the community

<tg-emoji emoji-id="5424972470023104089">🔥</tg-emoji> NO MORE TRADING ALONE.
Get access to our signals, analysis and trading community — completely FREE! 🚀

<tg-emoji emoji-id="5231102735817918643">👇</tg-emoji> CLICK THE BUTTON BELOW & ENTER YOUR NEW WORLD <tg-emoji emoji-id="5224450179368767019">🌎</tg-emoji><tg-emoji emoji-id="5296369303661067030">🔒</tg-emoji>

<tg-emoji emoji-id="5215432191156169379">🚨</tg-emoji> Trading involves risk. Past performance does not guarantee future results.`;

const WELCOME_BUTTON_TEXT = "💎 JOIN FREE VIP NOW 💎";

// Text pre-typed into the admin's chat box when the welcome button is tapped.
const WELCOME_PREFILLED_DM = `🔥 I WANT TO JOIN FREE VIP!
☑ 18+
💵 €200–€300+ capital
🚀 Ready to trade & go hard!
👇 LET’S GO! 💎📈`;

// ------------------------------- /link -------------------------------

const LINK_MESSAGE = `<tg-emoji emoji-id="5215432191156169379">🚨</tg-emoji> NEW TO PU PRIME? <tg-emoji emoji-id="5244837092042750681">📈</tg-emoji><tg-emoji emoji-id="5427168083074628963">💎</tg-emoji>

Don’t have a PU Prime account yet and want to join our trading community? 🔥

<tg-emoji emoji-id="5933948939530145209">☑</tg-emoji> 18+ only
<tg-emoji emoji-id="5409048419211682843">💵</tg-emoji> Minimum deposit: €200–€300
<tg-emoji emoji-id="5231200819986047254">📊</tg-emoji> Get started through our official referral link below 👇

<tg-emoji emoji-id="5271604874419647061">🔗</tg-emoji> JOIN PU PRIME:
<a href="https://www.puprime.partners/forex-trading-account/?affid=33772566&amp;utm_source=chatgpt.com">Open PU Prime</a>

<tg-emoji emoji-id="5253742260054409879">✉️</tg-emoji> If you need help setting up your account, DM @{admin}.

<tg-emoji emoji-id="5447644880824181073">⚠️</tg-emoji> Trading involves risk. Only trade with money you can afford to lose.`;

const LINK_BUTTON_TEXT = "🔗 Open PU Prime Account";
const LINK_BUTTON_URL =
  "https://www.puprime.partners/forex-trading-account/?affid=33772566&utm_source=chatgpt.com";

// -------------------------------- /ib --------------------------------

const IB_MESSAGE = `<tg-emoji emoji-id="5375338737028841420">🔄</tg-emoji> CHANGE YOUR IB – PU PRIME <tg-emoji emoji-id="5244837092042750681">📈</tg-emoji><tg-emoji emoji-id="5427168083074628963">💎</tg-emoji>

Want to move your PU Prime account under our IB? Follow these steps 👇

<tg-emoji emoji-id="5382322671679708881">1️⃣</tg-emoji> Go to your PU Prime account settings.
<tg-emoji emoji-id="5381990043642502553">2️⃣</tg-emoji> Select “Better Service” 🛠️
<tg-emoji emoji-id="5381879959335738545">3️⃣</tg-emoji> Enter the IB number: <code>33772566</code>
<tg-emoji emoji-id="5382054253403577563">4️⃣</tg-emoji> In the Reason of Transfer section, enter:

<code>Please move my account under 33772566. I want him to be my main contact at PU Prime.</code>

<tg-emoji emoji-id="5391197405553107640">5️⃣</tg-emoji> Submit your request ✅🔥

<tg-emoji emoji-id="5397782960512444700">📌</tg-emoji> IB Number: <code>33772566</code>
<tg-emoji emoji-id="5443038326535759644">💬</tg-emoji> Reason: Copy the text above exactly.

<tg-emoji emoji-id="5411590687663608498">⚡</tg-emoji> Once submitted, wait for PU Prime to process the request.`;

const IB_BUTTON_TEXT = "📩 Need Help? Contact Admin";

// Short descriptions shown in Telegram's command menu (the "/" list).
const COMMAND_DESCRIPTIONS = [
  { command: "start", description: "Join our FREE VIP 💎" },
  { command: "link", description: "Open a PU Prime account 🔗" },
  { command: "ib", description: "Change your IB to 33772566 🔄" },
];

module.exports = {
  WELCOME_MESSAGE,
  WELCOME_BUTTON_TEXT,
  WELCOME_PREFILLED_DM,
  LINK_MESSAGE,
  LINK_BUTTON_TEXT,
  LINK_BUTTON_URL,
  IB_MESSAGE,
  IB_BUTTON_TEXT,
  COMMAND_DESCRIPTIONS,
};
