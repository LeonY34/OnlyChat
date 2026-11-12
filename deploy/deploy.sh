#!/usr/bin/env bash
# Usage: deploy/deploy.sh <ssh-host>
# Copies the app to /opt/onlychat/app and (re)starts the systemd service.
# Requires Node >= 20 on the server at /opt/onlychat/node (a single binary).
set -euo pipefail
HOST="${1:?usage: deploy.sh <ssh-host>}"
cd "$(dirname "$0")/.."
tar czf - --exclude=.git --exclude=data --exclude=node_modules . | ssh "$HOST" 'set -e
  sudo id onlychat >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin onlychat
  sudo mkdir -p /opt/onlychat/app.new
  sudo tar xzf - -C /opt/onlychat/app.new
  sudo rm -rf /opt/onlychat/app.old; [ -d /opt/onlychat/app ] && sudo mv /opt/onlychat/app /opt/onlychat/app.old
  sudo mv /opt/onlychat/app.new /opt/onlychat/app
  sudo chown -R root:root /opt/onlychat/app
  sudo cp /opt/onlychat/app/deploy/onlychat.service /etc/systemd/system/onlychat.service
  sudo systemctl daemon-reload
  sudo systemctl enable onlychat >/dev/null 2>&1
  sudo systemctl restart onlychat
  sleep 1; systemctl is-active onlychat'
