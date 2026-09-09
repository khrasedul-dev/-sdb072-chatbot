# Telegram VIP Bot

One process, two halves, one set of messages:

- **The bot** ([Telegraf](https://telegraf.js.org/)) — welcomes everyone who
  joins the channel or group, answers `/start`, `/link` and `/ib`, and publishes
  the VIP post with a button that opens the admin's DM with a message already
  typed out.
- **The userbot** ([GramJS](https://gram.js.org/)) — runs as the admin's own
  account so that typing `/link` or `/ib` while chatting to a prospect sends the
  full text in its place. See [The userbot](#the-userbot).

Both run in the same Node process and read the same messages out of MongoDB,
so a text edited once changes everywhere at once.

---

## What it does

| Trigger | What happens |
| --- | --- |
| `/start` in a private chat | Sends the welcome message + **JOIN FREE VIP** button |
| `/link` | Sends the PU Prime signup text + link button + DM button — works in groups too |
| `/ib` | Sends the IB-change instructions + contact button — works in groups too |
| Someone joins a **group** | Welcome posted in the group, and sent as a DM when possible |
| Someone joins a **channel** | Welcome sent as a DM (channels get no per-join post) |
| Someone **requests to join** | Request approved, then the welcome arrives as a DM |
| Bot added as **administrator** | Posts the VIP message there immediately, and DMs the chat id to whoever added it |
| `/post` (admin only) | Publishes the VIP post into the channel again |
| `/edit` (admin only) | Rewrite any message from Telegram, premium emoji and all |
| `/whoami` | Your username and id — what to put in `ADMINS` |
| `/login` (admin only) | Signs the userbot in from Telegram — no terminal |
| `/userbot` (admin only) | Says whether the userbot has a working session |
| Admin forwards a channel post to the bot | Bot replies with that channel's id |

The **JOIN FREE VIP** button opens `t.me/<admin>` with the join request
pre-typed, so the new member only has to press send.

---

## Setup

### 1. Create the bot

Talk to [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
That is all BotFather is needed for; join events do not depend on privacy mode,
only on the bot being an administrator (step 3).

### 2. Configure

```bash
cp .env.example .env     # then fill in BOT_TOKEN
```

`.env` holds **secrets only** — the bot token, and the userbot's API
credentials. Everything else lives at the top of
[`src/messages.js`](src/messages.js), next to the texts it belongs with:

```js
const ADMIN_USERNAME = "potlood17";   // who the buttons DM
const CHANNEL_ID = "";                // where /post publishes
const WELCOME_IN_GROUP = true;        // welcome new members in the group
```

That way changing the admin or the channel is a push, not an SSH session. An
environment variable of the same name still wins if a host ever needs to
override one.

### 3. Add the bot to the channel / group

Add it as an **administrator**. That is the whole setup — the bot posts the VIP
message there straight away and welcomes everyone who joins from then on, in
any chat, with nothing to configure per chat.

It needs:

- **Post Messages** — to send the welcome and to run `/post`
- **Add Members / Invite Users** — to approve join requests

Administrator rights are also what makes Telegram deliver `chat_member` join
updates at all. In a channel that is the only signal a join happened, so
without them channel joins are invisible to the bot.

### 4. Run it

```bash
npm install
npm start
```

---

## Webhook or polling

The bot picks the mode by itself:

- A hosting platform exposes a public URL → **webhook**, and the bot calls
  `setWebhook` on startup. Nothing to configure.
- No public URL (your laptop) → **long polling**.

It reads the URL from whichever variable the platform provides:
`RENDER_EXTERNAL_URL`, `RAILWAY_PUBLIC_DOMAIN`, `KOYEB_PUBLIC_DOMAIN`,
`VERCEL_URL`, `FLY_APP_NAME`, `CYCLIC_URL`, `SPACE_HOST`, `WEBSITE_HOSTNAME`.
Set `WEBHOOK_URL` yourself to override it — a custom domain, or an ngrok tunnel
while testing.

To force polling anywhere:

```bash
npm run poll          # or set BOT_MODE=polling
```

The webhook endpoint sits on an unguessable path derived from the bot token and
verifies Telegram's `x-telegram-bot-api-secret-token` header, so nobody else can
push fake updates into it.

---

## Free hosting

Any host that runs a Node process and gives you a URL works. `render.yaml` and
`Procfile` are included.

**Render (free)**

1. Push this folder to GitHub.
2. Render → **New +** → **Blueprint** → pick the repo.
3. Set `BOT_TOKEN` (and `CHANNEL_ID`) when prompted. Deploy.

The webhook sets itself from `RENDER_EXTERNAL_URL` on the first boot.

**Keeping a free instance awake.** Free plans sleep after ~15 minutes idle, and
a sleeping instance answers the first webhook slowly. `GET /` is a health
endpoint — point a free pinger such as [UptimeRobot](https://uptimerobot.com) at
`https://your-app.onrender.com/` every 5 minutes and it stays up.

Railway, Koyeb and Fly.io work the same way: set `BOT_TOKEN`, deploy, done.

---

## Changing the messages from Telegram

The texts are not fixed in the code. Send **`/edit`** to the bot in a private
chat, pick a message, and type the replacement the way you would type any
Telegram message.

**Premium emoji come through exactly as typed.** Telegram delivers a message as
plain text plus a list of entities — offsets saying "custom emoji 5424… covers
these two characters". [`src/entities.js`](src/entities.js) turns that back into
the HTML source, so every custom emoji id is stored and re-sent byte for byte.
Bold, italics, links and code survive the same way.

After saving, the bot sends the message back exactly as members will see it. If
Telegram will not render it, you find out there rather than in front of a client.

| | |
| --- | --- |
| `/edit` | The menu of what can be changed |
| `/cancel` | Leave the message as it was |
| `/reset` | Put the original text back (while editing one) |

What can be edited: the welcome/VIP post, its button label, the pre-typed DM,
the `/link` message with its button label and URL, and the `/ib` message with
its button label.

### First-time setup

One command on the server, once:

```bash
cd /srv/vip-bot/app && bash scripts/setup-mongo.sh
```

It asks for the MongoDB admin login, creates a `vipbot` database with a
`vipbot_app` user scoped to it, writes `MONGODB_URI` into `.env` and restarts
the bot. Until that has run, the bot serves the seed texts and `/edit` says it
cannot save.

### Where they are kept

MongoDB, in its own `vipbot` database with its own user — nothing else on the
host is touched. The collection is `vipbot_messages`, so pointing `MONGODB_URI`
at a database another app already uses is safe too. [`src/messages.js`](src/messages.js) still holds all the texts,
but as the **seed**: what is in Mongo wins, and `/reset` drops back to the seed.

Reads come from an in-memory copy, so nothing on the send path waits on a
database, and a change stream keeps that copy current. **If MongoDB is
unreachable the bot keeps running on the seeds** — losing the ability to edit is
an inconvenience, going silent is an outage.

### One thing the bot cannot do

A **bot** may only send custom emoji if it owns a username bought on
[Fragment](https://fragment.com). @Scarfxxbot does not, so anything *it* sends —
the welcome, `/link` and `/ib` in a group, `/post` — arrives with the plain
fallback emoji. The bot notices Telegram's refusal and re-sends automatically, so
the message always lands.

The **userbot** is the account itself, and the account has Premium, so `/link`,
`/ib` and `/vip` typed in a DM go out with the real premium emoji.

Same stored text either way. The only fix for the bot half is to buy it a
Fragment username.

---

## The userbot

The bot cannot do this half. A bot only ever sees messages addressed to it, and
it can never send **as a person** — so `/ib` typed into a one-to-one chat with a
prospect is invisible to it. Reaching those messages means talking to Telegram
over MTProto as the account itself, which is what GramJS does.

The admin types a shortcut while chatting to someone; the full text is sent in
its place, from their own account. The prospect sees an ordinary message.

| Shortcut | Sends |
| --- | --- |
| `/link` | The PU Prime signup text |
| `/ib` | The IB-change instructions |
| `/vip` | The welcome/VIP text |

Only in one-to-one chats — in a group the bot already answers `/link`, and both
firing would send it twice. Flip `USERBOT_PRIVATE_ONLY=false` to change that.

**Two differences from the bot's version of the same message:**

- **No inline button.** Telegram only lets *bots* attach those. The PU Prime
  link inside `/link` is an ordinary hyperlink, which is what a person sending
  this by hand would have anyway.
- **Premium emoji actually render.** `<tg-emoji>` needs either Telegram Premium
  or a Fragment username. The account has Premium; the bot does not — so the
  custom emoji show up here and get flattened to plain ones when the bot sends
  the same text.

### Signing in

Two ways in. Both end up writing the same `USERBOT_SESSION` line into `.env`.

#### From Telegram — no terminal needed

Send **`/login`** to the bot in a private chat. It walks through the phone
number, the code and the two-step password, then saves the session and starts
the userbot itself.

This is the one to use when the session stops working and you are not at a
machine with SSH. `/userbot` says whether a session is saved; `/cancel` aborts.

Two things it does that matter:

- **Every message you type is deleted as soon as it is read** — the phone
  number, the code and the password never stay in the chat history.
- **It asks for the code with spaces between the digits** — `1 2 3 4 5`, not
  `12345`. Telegram invalidates any login code that appears in a Telegram chat
  as a plain number; that is an anti-phishing measure and it fires on your own
  chat with your own bot too. Spacing the digits is what gets a usable code
  through.

Only the account in `ADMIN_USERNAME` can start it, and only in a private chat —
in a group the code would be readable by everyone there.

#### From a terminal

**1. Register an app** at [my.telegram.org](https://my.telegram.org) → API
development tools. Put the two values in `.env`:

```ini
TELEGRAM_API_ID=1234567
TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef
```

These are separate from the BotFather token, and they identify the *app*, not
the account — the same pair works for any account you sign in.

**2. Sign in.** Telegram sends a login code, so this needs a real terminal:

```bash
npm run userbot:login
```

It asks for the phone number, the code Telegram sends, and the two-step password
if the account has one. On success it writes `USERBOT_SESSION=…` **into `.env`
itself** — the only place the userbot looks. Existing lines are left alone, and
running it again asks before replacing a session that is already there.

**3. Run it:**

```bash
npm run userbot
```

(`/login` from Telegram covers steps 2 and 3 by itself; the api id and hash from
step 1 still have to be in `.env` either way.)

The userbot runs inside the same process as the bot, so there is nothing
separate to start. Without a valid session it reports that in the log and the
bot carries on answering — `/link` and `/ib` simply do not expand in DMs until
`/login` fixes it. `.env` is never touched by a deploy, so the session survives
every push.

### Before you run this

**The session string is the account.** Anyone holding it is signed in, without a
password or a code. It lives in `.env`, which is gitignored and written
`chmod 600` — keep it that way, and never paste it into a chat or an issue.
To cut it off: Telegram → Settings → Devices → terminate the session.

**Automating a personal account carries a ban risk.** Telegram tolerates
self-automation like this, but the account — not a disposable bot — is what gets
limited if it looks like spam. Expanding snippets in conversations you are
already having is the safe end of that; blasting the same text at strangers is
not.

**There may be no need for any of this.** Telegram Business, included with
Premium, has *Quick Replies* built in: Settings → Business → Quick Replies, save
a shortcut, and typing `/ib` in a private chat sends it. Officially supported,
no code, no session, no ban risk. If the account has Premium it is worth trying
that first — this userbot exists for the cases where it does not fit.

---

## Never missed, never doubled

One person joining reaches the bot as up to three separate updates — the
service message, the `chat_member` update, and a join request. Exactly one of
them should produce a welcome, and none of them should be lost.

**Not missed:**

- All three signals are handled, so a join is caught however it arrives.
- The polling loop keeps its backlog across a restart (`dropPendingUpdates:
  false`). A deploy reloads PM2 for about two seconds; anyone who joins in that
  window is still welcomed afterwards.
- A `429` rate limit — likely when a burst of people join at once — is waited
  out and retried. Telegram states how long to wait and that it did not send,
  so retrying cannot duplicate anything. Same for `5xx`.
- If every send for one member fails, the bot forgets it tried, so the next
  signal for that person retries instead of writing them off.

**Not doubled:**

- Whichever signal arrives first claims the member; the others see the claim
  and stay quiet.
- That list lives in `data/welcomed.json`, not just in memory, so it survives
  the restart on every deploy. Without it, a re-delivered update would greet
  someone a second time. Entries are kept for 7 days and pruned.
- The file is written by rename, so a crash mid-write cannot leave a truncated
  file that reads as empty and re-welcomes everyone.
- A network error is deliberately *not* retried: the message may have arrived
  before the connection dropped, and a blind retry would post it twice.

`data/` is gitignored, so a deploy never overwrites it.

---

## VPS deployment (this bot's live setup)

Running on the production VPS under PM2, in **long polling** — no webhook,
nothing inbound, nothing for nginx to route.

```
/srv/vip-bot/app          the git checkout (this repo, origin/main)
/srv/vip-bot/app/.env     secrets — untracked, never overwritten by a deploy
/srv/vip-bot/deploy.sh    installs deps and reloads PM2
/var/log/vip-bot/         bot.out.log, bot.error.log, deploy.log
mongodb://…/vipbot        the edited messages
```

PM2 runs one app, **`vip-bot`**, one fork instance — the Telegraf bot and the
GramJS userbot both live inside it. One instance is deliberate: Telegram hands
each update to exactly one `getUpdates` caller, so a second copy would silently
take half the joins.

```bash
pm2 logs vip-bot            # follow
pm2 restart vip-bot         # restart
pm2 describe vip-bot        # status
```

The health server binds `127.0.0.1:3101` — port 3000 already belongs to another
app on that host, and loopback keeps this one off the public internet.

### Push to deploy

`vip-bot-deploy.timer` checks GitHub every minute and, when `origin/main` has
moved, resets to it, runs `npm ci --omit=dev` and reloads PM2. So:

```bash
git push origin main        # that is the whole deploy
```

Give it up to a minute, then `pm2 logs vip-bot` or
`tail /var/log/vip-bot/deploy.log`.

The service updates `deploy.sh` from the repo *before* running it, so changes to
the deploy process itself also ship by push.

```bash
systemctl status vip-bot-deploy.timer     # is it armed
systemctl start vip-bot-deploy.service    # deploy right now, do not wait
```

`.env` is gitignored, so `git reset --hard` never touches it — change a setting
there and `pm2 restart vip-bot`.

The server reads GitHub with its own key at `/root/.ssh/vipbot_deploy`, wired
through this repo's `core.sshCommand`. It never reads `~/.ssh/config`, so it
cannot collide with anything else deploying on the same box.

---

## Editing the messages

Everything the bot says — and every non-secret setting — lives in
[`src/messages.js`](src/messages.js). Open it, change the text between the
backticks, push. No database, no dashboard, no `.env` edit.

**Formatting** is Telegram HTML:

```html
<b>bold</b>  <i>italic</i>  <code>monospace</code>
<a href="https://example.com">link text</a>
```

**Placeholders** work in any message:

| Placeholder | Becomes |
| --- | --- |
| `{name}` | The member's first name, as a clickable mention |
| `{username}` | `@theirname`, or their first name if they have none |
| `{chat}` | The group or channel title |
| `{admin}` | The value of `ADMIN_USERNAME` |

### Premium (custom) emoji

The messages use `<tg-emoji emoji-id="…">🔥</tg-emoji>` tags. Telegram only
renders these **for bots that own a username bought on
[Fragment](https://fragment.com)** — having Premium on your own account is not
enough.

You do not have to worry about it either way: if Telegram rejects the custom
emoji, the bot immediately resends the same message with the normal emoji
instead, so the message always arrives. Watch the logs for
`Telegram rejected the HTML formatting` to know which one you are getting.

To grab the tag for a premium emoji: send it to yourself in Telegram, then
copy its id from the message — or drop the `<tg-emoji>` wrapper entirely and
keep the plain emoji.

---

## Publishing the VIP post to the channel

1. Make sure the bot is an admin in the channel.
2. Set `CHANNEL_ID`:
   - Public channel → `@yourchannel`
   - Private channel → forward any post from it to the bot in a private chat.
     The bot replies with the `-100…` id. Put that in `CHANNEL_ID` and restart.
3. DM the bot `/post`.

One-off target without changing the config: `/post @otherchannel`.

Only the account in `ADMIN_USERNAME` can run it; for everyone else the command
does nothing.

---

## Settings

**`.env` — secrets, never committed:**

| Variable | Meaning |
| --- | --- |
| `BOT_TOKEN` | **Required.** From BotFather |
| `MONGODB_URI` | Where the edited messages live |
| `MONGODB_COLLECTION` | Collection name, default `vipbot_messages` |
| `TELEGRAM_API_ID` | Userbot only. From my.telegram.org |
| `TELEGRAM_API_HASH` | Userbot only. From my.telegram.org |
| `USERBOT_SESSION` | Written by `npm run userbot:login` |

**[`src/messages.js`](src/messages.js) — settings and seed texts, edited with a push:**

| Setting | Default | Meaning |
| --- | --- | --- |
| `ADMIN_USERNAME` | `potlood17` | Who the buttons open a chat with |
| `ADMINS` | `["potlood17"]` | Who may run the admin commands (usernames or ids) |
| `CHANNEL_ID` | `""` | Target for `/post` |
| `AUTO_APPROVE_JOIN_REQUESTS` | `true` | Approve join requests automatically |
| `WELCOME_IN_GROUP` | `true` | Post the welcome in the group itself |
| `WELCOME_IN_DM` | `true` | Also send the welcome privately |
| `USERBOT_PRIVATE_ONLY` | `true` | Expand shortcuts in one-to-one chats only |

**Where the process runs** — set by `deploy/ecosystem.config.cjs` on the VPS, or
by the platform on a cloud host. Nothing to put in `.env`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Health-check port |
| `HOST` | `0.0.0.0` | Interface to bind; `127.0.0.1` on a shared VPS |
| `BOT_MODE` | auto | `polling` forces long polling |
| `WEBHOOK_URL` | auto | Override the detected public URL |
| `WEBHOOK_SECRET` | derived | Header Telegram signs webhook calls with |

Any of the `src/messages.js` settings can still be overridden by an environment
variable of the same name.

---

## Troubleshooting

**Nobody gets welcomed in a group or channel.** The bot is not an
administrator there. Telegram only sends `chat_member` join updates to admins,
and in a channel that update is the only signal a join happened. Promote the
bot and try again.

**Channel joiners get nothing.** A bot cannot message someone who has never
opened a chat with it. The fix is to switch the channel's invite link to
**"Request to join"** — approving the request is what opens the DM. Everyone
joining through a plain link will only see the pinned VIP post.

**/link and /ib stopped expanding in DMs.** The userbot session was signed out
— Telegram's Devices list, or a password change. Send `/login` to the bot to
sign back in; `/userbot` confirms the state first.

**An admin command does nothing.** You are not in `ADMINS`. Send `/whoami` to
the bot — it replies with your username and id — then add that to `ADMINS` in
[`src/messages.js`](src/messages.js) and push. In a private chat the bot now
says this itself rather than staying silent.

**Nothing happens at all after deploying.** Check the logs for
`Bot @name is online in webhook mode`. Two copies of the bot running at once
(say a local `npm run poll` and a deployed instance) fight over updates — stop
one.

**`/post` says chat not found.** The id is wrong, or the bot is not an admin
there. Forward a post from the channel to the bot to confirm the id.

---

## Files

```
index.js                  starts both halves, plus the health endpoint
src/bot.js                every command and join handler (Telegraf)
src/userbot.js            the /link and /ib expander (GramJS)
src/store.js              the messages, in MongoDB, cached in memory
src/editor.js             the /edit conversation
src/entities.js           Telegram message -> HTML, premium emoji intact
src/userbot-auth.js       the /login conversation
src/env-file.js           the careful .env rewriter both logins share
src/messages.js           settings + the seed texts
src/format.js             placeholder and HTML helpers both halves share
src/config.js             environment variables and public-URL detection
scripts/userbot-login.js  sign-in from a terminal, as an alternative to /login
deploy/                   PM2 ecosystem, deploy.sh and the systemd auto-deploy units
render.yaml               one-click Render deploy
```
