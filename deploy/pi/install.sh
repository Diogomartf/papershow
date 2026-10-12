#!/usr/bin/env bash
# Sets up Papershow on a Raspberry Pi 5 with 64-bit Raspberry Pi OS (Bookworm or later):
# the server and the panel client, both as systemd services that start on boot.
# Run it from a checkout of this repo. It's safe to run again after a `git pull`.
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
user=$(id -un)

# Node with node:sqlite unflagged (22.13+). Node 24 is the current LTS.
if ! node -e 'require("node:sqlite")' 2>/dev/null; then
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
  sed -e "s|@USER@|$user|g" -e "s|@REPO@|$repo|g" "deploy/pi/$unit.service" |
    sudo tee "/etc/systemd/system/$unit.service" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable papershow papershow-panel
sudo systemctl restart papershow papershow-panel

# Reach it from your Mac and phone, at home or away, over HTTPS.
if command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then
  sudo tailscale serve --bg 5194
  echo "Papershow: https://$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
else
  echo "Papershow: http://$(hostname).local:5194  (install Tailscale and run this again for HTTPS anywhere)"
fi
