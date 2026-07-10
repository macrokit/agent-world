#!/usr/bin/env bash
# Deploy the Agent World hub to a production server (bare-metal / VM path).
#
# Mirrors the macrokit website deploy: rsync the repo, build on the box, install
# the systemd unit + nginx vhost, restart. Connection details come from the
# environment — nothing about a specific server is committed.
#
# Required env:
#   AW_SSH_HOST     e.g. ubuntu@203.0.113.10
#   AW_DOMAIN       e.g. hub.example.com
# Optional:
#   AW_SSH_KEY      path to the private key (default: ssh-agent / ~/.ssh)
#   AW_REMOTE_ROOT  default /opt/agent-world
#
# This script is idempotent. First run on a fresh box: run it, then obtain TLS
# with `sudo certbot --nginx -d $AW_DOMAIN`, then re-run to reload.
set -euo pipefail

: "${AW_SSH_HOST:?set AW_SSH_HOST=user@host}"
: "${AW_DOMAIN:?set AW_DOMAIN=hub.example.com}"
REMOTE_ROOT="${AW_REMOTE_ROOT:-/opt/agent-world}"
SSH_OPTS=(-o ServerAliveInterval=30)
[[ -n "${AW_SSH_KEY:-}" ]] && SSH_OPTS+=(-i "$AW_SSH_KEY")

HERE="$(cd "$(dirname "$0")/../.." && pwd)"  # repo root (agent-world/)

echo "==> rsync core/ and studio/ -> $AW_SSH_HOST:$REMOTE_ROOT"
rsync -avz --delete \
  --exclude 'node_modules' --exclude 'dist' --exclude '*.key' \
  --exclude 'journal.jsonl' --exclude '.git' \
  -e "ssh ${SSH_OPTS[*]}" \
  "$HERE/core" "$HERE/studio" \
  "$AW_SSH_HOST:$REMOTE_ROOT/"

echo "==> build on the box + install unit/vhost + (re)start"
ssh "${SSH_OPTS[@]}" "$AW_SSH_HOST" AW_DOMAIN="$AW_DOMAIN" REMOTE_ROOT="$REMOTE_ROOT" bash <<'REMOTE'
set -euo pipefail
command -v node >/dev/null || { echo "node not installed on the server" >&2; exit 1; }
command -v pnpm >/dev/null || sudo corepack enable

id aw >/dev/null 2>&1 || sudo useradd --system --create-home aw
sudo mkdir -p /var/lib/agent-world
sudo chown -R aw:aw /var/lib/agent-world "$REMOTE_ROOT"

cd "$REMOTE_ROOT/core"   && pnpm install --frozen-lockfile=false && pnpm -r build
cd "$REMOTE_ROOT/studio" && pnpm install --frozen-lockfile=false && pnpm -r build

# systemd unit
sudo cp "$REMOTE_ROOT/studio/deploy/aw-hub.service" /etc/systemd/system/aw-hub.service
sudo sed -i "s#/opt/agent-world#$REMOTE_ROOT#g" /etc/systemd/system/aw-hub.service
sudo systemctl daemon-reload
sudo systemctl enable aw-hub
sudo systemctl restart aw-hub

# nginx vhost (domain substituted from the committed template)
sudo sed "s/hub.example.com/$AW_DOMAIN/g" "$REMOTE_ROOT/studio/deploy/nginx/hub.conf" \
  | sudo tee "/etc/nginx/sites-available/$AW_DOMAIN" >/dev/null
sudo ln -sf "/etc/nginx/sites-available/$AW_DOMAIN" "/etc/nginx/sites-enabled/$AW_DOMAIN"
if sudo nginx -t 2>/dev/null; then
  sudo systemctl reload nginx
  echo "nginx reloaded"
else
  echo "NOTE: nginx config test failed — likely TLS certs not yet issued."
  echo "      Run: sudo certbot --nginx -d $AW_DOMAIN   then re-run this script."
fi

echo "==> hub status"
sudo systemctl --no-pager --lines=5 status aw-hub || true
curl -fsS http://127.0.0.1:7800/healthz && echo
REMOTE

echo "==> done. Verify: https://$AW_DOMAIN/healthz  and  https://$AW_DOMAIN/ (Observatory)"
