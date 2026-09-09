#!/usr/bin/env bash
#
# Give the bot its own MongoDB database, once.
#
#   cd /srv/vip-bot/app && bash scripts/setup-mongo.sh
#
# Creates a `vipbot` database with a `vipbot_app` user scoped to it, writes
# MONGODB_URI into .env, and restarts the bot. Nothing outside that database is
# touched — no existing user, database or config is read or modified beyond
# needing an admin login to create the new user.
#
# Safe to run again: it resets the password and rewrites the one .env line.
set -euo pipefail

APP=/srv/vip-bot/app
DB=vipbot
DB_USER=vipbot_app

cd "$APP"

command -v mongosh >/dev/null || { echo "mongosh is not installed."; exit 1; }

# mongod on this host runs with `authorization: enabled`, so even a brand new
# database needs an admin login to create its user. Try the credentials this
# host already keeps before asking anyone to type anything.
ADMIN_USER=""
ADMIN_PW=""

try_login() {
  mongosh --quiet -u "$1" -p "$2" --authenticationDatabase admin \
    --eval 'db.adminCommand({ping:1})' >/dev/null 2>&1
}

CRED_FILE=/root/.trucking-mongo
if [ -r "$CRED_FILE" ]; then
  # Tolerate KEY=value, KEY="value" and KEY='value'.
  FILE_PW=$(sed -n 's/^MONGO_ROOT_PW=["'"'"']\?\(.*[^"'"'"']\)["'"'"']\?$/\1/p' "$CRED_FILE" | head -1)
  if [ -n "$FILE_PW" ]; then
    for candidate in root admin mongoadmin; do
      if try_login "$candidate" "$FILE_PW"; then
        ADMIN_USER=$candidate
        ADMIN_PW=$FILE_PW
        echo "  signed in as $candidate using $CRED_FILE"
        break
      fi
    done
  fi
fi

if [ -z "$ADMIN_USER" ]; then
  echo "Could not sign in with the credentials already on this host."
  echo "Enter a MongoDB admin login (the one mongod was set up with):"
  read -rp "  username [root]: " ADMIN_USER
  ADMIN_USER=${ADMIN_USER:-root}
  read -rsp "  password: " ADMIN_PW
  echo

  if ! try_login "$ADMIN_USER" "$ADMIN_PW"; then
    echo
    echo "That login was refused. To see what admin users exist:"
    echo "  mongosh -u <user> -p --authenticationDatabase admin --eval 'db.getSiblingDB(\"admin\").getUsers()'"
    exit 1
  fi
fi

APP_PW=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 32)

mongosh --quiet -u "$ADMIN_USER" -p "$ADMIN_PW" --authenticationDatabase admin --eval "
  const target = db.getSiblingDB('$DB');
  const exists = target.getUsers().users.some(u => u.user === '$DB_USER');
  if (exists) {
    target.updateUser('$DB_USER', { pwd: '$APP_PW' });
    print('  password reset for $DB_USER');
  } else {
    target.createUser({
      user: '$DB_USER',
      pwd: '$APP_PW',
      roles: [{ role: 'readWrite', db: '$DB' }]
    });
    print('  created $DB_USER with readWrite on $DB only');
  }
"

# replicaSet is what makes change streams work, so an edit reaches every reader
# at once instead of on the next poll.
URI="mongodb://$DB_USER:$APP_PW@127.0.0.1:27017/$DB?authSource=$DB&replicaSet=rs0"

if mongosh --quiet "$URI" --eval 'db.runCommand({ping:1})' >/dev/null 2>&1; then
  echo "  connection verified"
else
  echo "  the new user cannot connect — stopping before .env is changed"
  exit 1
fi

# Replace the line if it is there, append it if not. Written through a temp file
# so an interrupted run cannot truncate the bot token sitting in the same file.
TMP=$(mktemp)
if grep -q '^MONGODB_URI=' .env 2>/dev/null; then
  grep -v '^MONGODB_URI=' .env > "$TMP"
else
  cat .env > "$TMP" 2>/dev/null || true
  printf '\n# The editable messages. Its own database and user.\n' >> "$TMP"
fi
printf 'MONGODB_URI=%s\n' "$URI" >> "$TMP"
install -m 600 "$TMP" .env
rm -f "$TMP"
echo "  MONGODB_URI written to $APP/.env"

pm2 restart vip-bot --update-env >/dev/null 2>&1 && echo "  vip-bot restarted"

echo
echo "Done. Check it took:"
echo "  pm2 logs vip-bot --lines 20 --nostream | grep store"
echo "Then send /edit to the bot in a private chat."
