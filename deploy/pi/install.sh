#!/usr/bin/env bash
# Sets up Papershow on a Raspberry Pi 5 with 64-bit Raspberry Pi OS (Bookworm or later):
# the server and the panel client, both as systemd services that start on boot.
# Run it from a checkout of this repo, anywhere in your home folder. It's safe to run again after
# a `git pull`, and it leaves the rest of a Pi you already use alone.
#
#   PAPERSHOW_PORT=8080 deploy/pi/install.sh    # if something else already uses 5194
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
user=$(id -un)
port=${PAPERSHOW_PORT:-5194}

if [ "$(uname -m)" != aarch64 ]; then
  echo "Papershow needs 64-bit Raspberry Pi OS (this is $(uname -m))." >&2
  exit 1
fi
# The port must be free, unless it's Papershow itself from an earlier install.
if ss -ltn "sport = :$port" | grep -q LISTEN && ! systemctl is-active --quiet papershow; then
  echo "Port $port is taken. Pick another: PAPERSHOW_PORT=8080 deploy/pi/install.sh" >&2
  exit 1
fi

# Node with node:sqlite unflagged (22.13+). Node 24 is the current LTS. This replaces an older
# system Node, which other things on the Pi may use; a newer one is left as it is.
if ! node -e 'require("node:sqlite")' 2>/dev/null; then
  command -v node >/dev/null && echo "Upgrading Node $(node -v) to 24 (Papershow needs node:sqlite)."
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
command -v pnpm >/dev/null || sudo npm install -g pnpm

cd "$repo"
pnpm install --frozen-lockfile
pnpm build

# The panel: SPI on, and Python libraries from apt (Pi 5 GPIO goes through gpiozero and lgpio).
# Waveshare's driver is in apps/panel/waveshare_epd.
sudo raspi-config nonint do_spi 0
sudo apt-get install -y python3-pil python3-spidev python3-gpiozero python3-lgpio

# Only one thing can drive the panel. Old scripts on a cron would fight the client over SPI.
if crontab -l 2>/dev/null | grep -qE 'epd|e-ink|e_ink'; then
  echo "Warning: your crontab still has e-ink jobs. Remove them (crontab -e) so they don't draw over Papershow." >&2
fi

for unit in papershow papershow-panel; do
  sed -e "s|@USER@|$user|g" -e "s|@REPO@|$repo|g" -e "s|@PORT@|$port|g" "deploy/pi/$unit.service" |
    sudo tee "/etc/systemd/system/$unit.service" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable papershow papershow-panel
sudo systemctl restart papershow papershow-panel

echo "Papershow: http://$(hostname).local:$port"

# Reach it from your Mac and phone, at home or away, over HTTPS. A Pi you already use may serve
# other things through Tailscale; that setup is left alone.
if command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then
  name=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
  serving=$(sudo tailscale serve status 2>/dev/null || true)
  if grep -q "127.0.0.1:$port" <<<"$serving"; then
    echo "Tailscale: already serving Papershow (sudo tailscale serve status shows where)"
  elif [ -z "$serving" ] || grep -q "No serve config" <<<"$serving"; then
    sudo tailscale serve --bg "$port"
    echo "Tailscale: https://$name"
  else
    echo "Tailscale already serves something else on this Pi, so it was left alone. To add Papershow on its own port:"
    echo "  sudo tailscale serve --bg --https=8443 $port    # then https://$name:8443"
  fi
else
  echo "Install Tailscale and run this again to reach it from anywhere over HTTPS."
fi
