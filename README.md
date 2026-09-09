# Telegram VIP Bot

Welcomes everyone who joins the channel or group, answers `/start`, `/link` and
`/ib`, and publishes the VIP post with a button that opens the admin's DM with a
message already typed out.

Built on [Telegraf](https://telegraf.js.org/). Runs on a webhook that configures
itself, or on long polling — same command either way.

---

## What it does

| Trigger | What happens |
| --- | --- |
| `/start` in a private chat | Sends the welcome message + **JOIN FREE VIP** button |
| `/link` | Sends the PU Prime signup text + link button + DM button |
| `/ib` | Sends the IB-change instructions + contact button |
| Someone joins a **group** | Welcome posted in the group, and sent as a DM when possible |
| Someone joins a **channel** | Welcome sent as a DM (channels get no per-join post) |
| Someone **requests to join** | Request approved, then the welcome arrives as a DM |
| `/post` (admin only) | Publishes the VIP post into the channel |
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
cp .env.example .env
```

Fill in `BOT_TOKEN`. `ADMIN_USERNAME` and `CHANNEL_ID` are optional but needed
for the DM button and `/post` to point at the right places.

### 3. Add the bot to the channel / group

Add it as an **administrator**. It needs:

- **Post Messages** — to send the welcome and to run `/post`
- **Add Members / Invite Users** — to approve join requests

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

## VPS deployment (this bot's live setup)

Running on the production VPS under PM2, in **long polling** — no webhook,
nothing inbound, nothing for nginx to route.

```
/srv/vip-bot/app          the git checkout (this repo, origin/main)
/srv/vip-bot/app/.env     the token and settings — untracked, never overwritten
/srv/vip-bot/deploy.sh    installs deps and reloads PM2
/var/log/vip-bot/         bot.out.log, bot.error.log, deploy.log
```

PM2 runs it as **`vip-bot`**, one fork instance. One instance is deliberate:
Telegram hands each update to exactly one `getUpdates` caller, so a second copy
would silently take half the joins.

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

Everything the bot says lives in [`src/messages.js`](src/messages.js). Open it,
change the text between the backticks, restart. No database, no dashboard.

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

| Variable | Default | Meaning |
| --- | --- | --- |
| `BOT_TOKEN` | — | **Required.** From BotFather |
| `ADMIN_USERNAME` | `potlood17` | Who the buttons DM, and who may run `/post` |
| `CHANNEL_ID` | — | Target for `/post` |
| `PORT` | `3000` | Health-check port; hosts set this themselves |
| `HOST` | `0.0.0.0` | Interface to bind; use `127.0.0.1` on a shared VPS |
| `WEBHOOK_URL` | auto | Override the detected public URL |
| `BOT_MODE` | auto | `polling` forces long polling |
| `AUTO_APPROVE_JOIN_REQUESTS` | `true` | Approve join requests automatically |
| `WELCOME_IN_GROUP` | `true` | Post the welcome in the group itself |
| `WELCOME_IN_DM` | `true` | Also send the welcome privately |
| `WEBHOOK_SECRET` | derived | Header Telegram signs webhook calls with |

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

**Nothing happens at all after deploying.** Check the logs for
`Bot @name is online in webhook mode`. Two copies of the bot running at once
(say a local `npm run poll` and a deployed instance) fight over updates — stop
one.

**`/post` says chat not found.** The id is wrong, or the bot is not an admin
there. Forward a post from the channel to the bot to confirm the id.

---

## Files

```
index.js            starts the bot — webhook or polling, plus the health endpoint
src/bot.js          every command and join handler
src/messages.js     all the texts and buttons  <- edit this one
src/config.js       environment variables and public-URL detection
deploy/             PM2 ecosystem, deploy.sh and the systemd auto-deploy units
render.yaml         one-click Render deploy
```
