#!/usr/bin/env bash
#
# Install dependencies and restart the VIP bot from whatever is checked out.
#
#   /srv/vip-bot/deploy.sh            install + reload
#   /srv/vip-bot/deploy.sh --pull     fetch origin/main first (the timer uses this)
#
# Safe to run twice. Never touches .env — it is untracked, and `git reset`
# leaves ignored files alone.
set -euo pipefail

APP=/srv/vip-bot/app
LOG=/var/log/vip-bot/deploy.log
mkdir -p "$(dirname "$LOG")"
exec > >(tee -a "$LOG") 2>&1
echo "───────────── $(date -u '+%Y-%m-%d %H:%M:%S UTC') deploy start"

cd "$APP"

if [ "${1:-}" = "--pull" ]; then
  # The repo carries its own ssh key via core.sshCommand, so this never reads
  # ~/.ssh/config and cannot collide with anything else on the box.
  if ! git fetch --quiet origin main 2>/dev/null; then
    echo "FATAL: cannot reach GitHub."
    echo "  Add this server's deploy key (read access is enough) under the"
    echo "  repository's Settings -> Deploy keys:"
    echo "  $(cat /root/.ssh/vipbot_deploy.pub 2>/dev/null || echo '/root/.ssh/vipbot_deploy.pub missing')"
    exit 1
  fi
  LOCAL=$(git rev-parse HEAD)
  REMOTE=$(git rev-parse origin/main)
  if [ "$LOCAL" = "$REMOTE" ]; then
    echo "already at $(git log --oneline -1)"
    exit 0
  fi
  echo "updating $LOCAL -> $REMOTE"
  git reset --hard --quiet origin/main
fi

echo "### at $(git log --oneline -1)"

echo "### install"
# --omit=dev: there is no build step and no test runner in production.
npm ci --omit=dev --no-audit --no-fund --loglevel=error

echo "### restart"
if pm2 describe vip-bot >/dev/null 2>&1; then
  pm2 reload deploy/ecosystem.config.cjs --update-env
else
  pm2 start deploy/ecosystem.config.cjs
fi

# --force so saving this app's state never prompts about the others already
# under PM2 on this host.
pm2 save --force >/dev/null

echo "───────────── deploy done $(date -u '+%H:%M:%S UTC')"
