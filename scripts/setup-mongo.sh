#!/usr/bin/env bash
#
# Give the bot its own MongoDB, fully isolated from anything else on the host.
#
#   cd /srv/vip-bot/app && sudo bash scripts/setup-mongo.sh
#
# It runs a SECOND mongod — its own port (27018), its own data directory, its
# own auth — so the database another app on this box already runs (on 27017) is
# never touched: not its config, not its users, not its data. This one exists
# only for the eight editable messages.
#
# Idempotent: run it again and it just resets the app password and rewrites the
# one line in .env.
set -euo pipefail

APP=/srv/vip-bot/app
PORT=27018
DATA=/var/lib/mongodb-vipbot
LOGDIR=/var/log/mongodb-vipbot
CONF=/etc/mongod-vipbot.conf
UNIT=/etc/systemd/system/mongod-vipbot.service
DB=vipbot
DB_USER=vipbot_app

command -v mongod >/dev/null || { echo "mongod is not installed."; exit 1; }
command -v mongosh >/dev/null || { echo "mongosh is not installed."; exit 1; }

# The mongodb service account that ships with the server package owns the files.
MONGO_USER=mongodb
id "$MONGO_USER" >/dev/null 2>&1 || MONGO_USER=root

echo "### directories"
mkdir -p "$DATA" "$LOGDIR"
chown -R "$MONGO_USER":"$MONGO_USER" "$DATA" "$LOGDIR"

echo "### config for the dedicated instance"
cat > "$CONF" <<CONF
# A second mongod, only for the VIP bot's editable messages.
# Nothing to do with the instance on 27017.
storage:
  dbPath: $DATA
  wiredTiger:
    engineConfig:
      # Small footprint: this holds a handful of tiny documents.
      cacheSizeGB: 0.25
systemLog:
  destination: file
  path: $LOGDIR/mongod.log
  logAppend: true
net:
  port: $PORT
  bindIp: 127.0.0.1
security:
  authorization: enabled
CONF

echo "### systemd service"
cat > "$UNIT" <<UNIT
[Unit]
Description=MongoDB for the VIP bot (isolated instance on $PORT)
After=network-online.target
Wants=network-online.target

[Service]
User=$MONGO_USER
Group=$MONGO_USER
ExecStart=/usr/bin/mongod --config $CONF
Restart=on-failure
RestartSec=5
LimitNOFILE=64000

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now mongod-vipbot >/dev/null 2>&1 || systemctl restart mongod-vipbot

echo "### waiting for it to accept connections"
for i in $(seq 1 30); do
  # Any reply — even an auth error — means the server is up and listening.
  if mongosh --quiet --port "$PORT" --eval 'db.runCommand({ping:1})' 2>&1 | grep -qiE 'ok|auth'; then
    break
  fi
  sleep 1
  [ "$i" = 30 ] && { echo "mongod did not come up — see $LOGDIR/mongod.log"; exit 1; }
done

APP_PW=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 32)
CRED=/root/.vipbot-mongo

# The localhost exception on a fresh instance permits exactly one action —
# creating the first user — and then closes. So: try to create the admin user
# through it. Success means this is a new instance; failure (users already
# exist) sends us to the authenticated path with the password saved last time.
echo "### app user"
ROOT_PW=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 32)
if mongosh --quiet --port "$PORT" --eval \
     "db.getSiblingDB('admin').createUser({user:'vipbot_root',pwd:'$ROOT_PW',roles:['root']})" \
     >/dev/null 2>&1; then
  printf 'MONGO_VIPBOT_ROOT_PW=%s\n' "$ROOT_PW" > "$CRED"
  chmod 600 "$CRED"
  echo "  created the admin user for this instance"
else
  ROOT_PW=$(sed -n 's/^MONGO_VIPBOT_ROOT_PW=\(.*\)$/\1/p' "$CRED" 2>/dev/null | head -1)
  [ -n "$ROOT_PW" ] || { echo "  instance already has users but $CRED is missing its admin password — cannot continue"; exit 1; }
  echo "  admin user already exists — reusing it"
fi

# Create or reset the scoped app user, authenticated as our own admin.
mongosh --quiet --port "$PORT" -u vipbot_root -p "$ROOT_PW" --authenticationDatabase admin --eval "
  const d = db.getSiblingDB('$DB');
  d.getUser('$DB_USER')
    ? d.updateUser('$DB_USER', { pwd: '$APP_PW' })
    : d.createUser({ user: '$DB_USER', pwd: '$APP_PW', roles: [{ role: 'readWrite', db: '$DB' }] });
  print('  $DB_USER ready with readWrite on $DB');
"

URI="mongodb://$DB_USER:$APP_PW@127.0.0.1:$PORT/$DB?authSource=$DB"

echo "### verify the app user can read and write"
# getCollection, because mongosh treats a db property that starts with "_" as
# an internal and hands back undefined.
mongosh --quiet "$URI" --eval "
  const probe = db.getCollection('setup_probe');
  probe.insertOne({ t: new Date() });
  probe.deleteMany({});
  print('  ok');
" || { echo "the new user cannot connect — stopping before .env is changed"; exit 1; }

echo "### write MONGODB_URI into .env"
cd "$APP"
TMP=$(mktemp)
grep -v '^MONGODB_URI=' .env 2>/dev/null > "$TMP" || true
grep -q '^# The editable messages' "$TMP" 2>/dev/null || printf '\n# The editable messages, in the bot'"'"'s own isolated mongod.\n' >> "$TMP"
printf 'MONGODB_URI=%s\n' "$URI" >> "$TMP"
install -m 600 "$TMP" .env
rm -f "$TMP"
echo "  done"

pm2 restart vip-bot --update-env >/dev/null 2>&1 && echo "### vip-bot restarted"

echo
echo "Check it took:"
echo "  pm2 logs vip-bot --lines 20 --nostream | grep store"
echo "Then send /edit to the bot from @tmaxfxx or @rased485."
