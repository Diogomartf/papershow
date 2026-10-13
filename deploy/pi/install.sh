#!/usr/bin/env bash
# Sets up Papershow on a Raspberry Pi 5 with 64-bit Raspberry Pi OS (Bookworm or later):
# the server and the panel client, both as systemd services that start on boot.
# It's safe to run again, and it leaves the rest of a Pi you already use alone.
#
# From a checkout:   deploy/pi/install.sh
# Or in one line, without one: it clones the repo to ~/papershow (or updates it) and carries on.
#   gh api repos/Diogomartf/papershow/contents/deploy/pi/install.sh -H "Accept: application/vnd.github.raw" | bash
#
#   PAPERSHOW_PORT=8080     if something else already uses 5194
#   PAPERSHOW_NAME=paper    its name on the local network: http://paper.local
#   PAPERSHOW_DIR=~/x       where the one-line install puts the checkout (~/papershow)
#   PAPERSHOW_BRANCH=main   which branch it checks out (main)
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)
if [ ! -f "$here/install.sh" ] || [ ! -f "$here/../../package.json" ]; then
  # Piped in, not run from a checkout: get the code, then run the checkout's copy of this script.
  # Everything here reads from /dev/null, because the rest of this script is still waiting on stdin.
  dir=${PAPERSHOW_DIR:-$HOME/papershow}
  branch=${PAPERSHOW_BRANCH:-main}
  command -v git >/dev/null || sudo apt-get install -y git </dev/null
  if [ -d "$dir/.git" ]; then
    git -C "$dir" fetch --quiet origin </dev/null
    git -C "$dir" switch --quiet "$branch" </dev/null
    git -C "$dir" pull --quiet --ff-only </dev/null
  elif command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
    gh repo clone Diogomartf/papershow "$dir" -- --branch "$branch" </dev/null
  else
    # Works once the repo is public; until then, `gh auth login` first.
    git clone --branch "$branch" https://github.com/Diogomartf/papershow.git "$dir" </dev/null
  fi
  exec bash "$dir/deploy/pi/install.sh" </dev/null
fi

repo=$(cd "$here/../.." && pwd)
user=$(id -un)
port=${PAPERSHOW_PORT:-5194}
name=${PAPERSHOW_NAME:-paper}

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
# The pnpm that wrote pnpm-lock.yaml (v7; newer ones can't read it frozen), through npx so a
# pnpm the Pi already has stays as it is.
pnpm() { npx --yes pnpm@7 "$@"; }

cd "$repo"
pnpm install --frozen-lockfile
pnpm build

# The panel: SPI on, and Python libraries from apt (Pi 5 GPIO goes through gpiozero and lgpio).
# Waveshare's driver is in apps/panel/waveshare_epd.
sudo raspi-config nonint do_spi 0
sudo apt-get install -y python3-pil python3-spidev python3-gpiozero python3-lgpio

# http://paper.local: the name over mDNS (avahi, as for <hostname>.local), and port 80 so it needs no port.
sudo apt-get install -y avahi-daemon avahi-utils
# Port 80 only if it's free, or Papershow's own from an earlier install: a web server already there stays.
web_port=80
owner=$(sudo ss -ltnpH "sport = :80" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)
if [ -n "$owner" ] && ! grep -q papershow.service "/proc/$owner/cgroup" 2>/dev/null; then
  echo "Port 80 is in use by something else, so Papershow stays on port $port: http://$name.local:$port" >&2
  web_port=
fi
# The name only if no other device answers to it already; this Pi's own hostname needs no alias.
ip=$(ip -4 route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p')
taken=$(timeout 5 avahi-resolve -4 -n "$name.local" 2>/dev/null | cut -f2 || true)
if [ "$name" = "$(hostname)" ]; then
  publish=
elif [ -n "$taken" ] && [ "$taken" != "$ip" ] && ! systemctl is-active --quiet papershow-name; then
  echo "$name.local is already another device on your network ($taken), so Papershow keeps $(hostname).local. Pick another: PAPERSHOW_NAME=paper2 deploy/pi/install.sh" >&2
  publish=
  name=$(hostname)
else
  publish=yes
fi


# Already set up means this run is an update; it changes only the last line of the output.
[ -f /etc/systemd/system/papershow.service ] && action=updated || action=installed
for unit in papershow papershow-panel papershow-name; do
  sed -e "s|@USER@|$user|g" -e "s|@REPO@|$repo|g" -e "s|@PORT@|$port|g" -e "s|@WEB_PORT@|$web_port|g" -e "s|@NAME@|$name|g" \
    "deploy/pi/$unit.service" | sudo tee "/etc/systemd/system/$unit.service" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable papershow papershow-panel
sudo systemctl restart papershow papershow-panel
if [ -n "$publish" ]; then
  sudo systemctl enable papershow-name
  sudo systemctl restart papershow-name
else
  sudo systemctl disable --now papershow-name 2>/dev/null || true
fi

# paper:update, paper:status, paper:logs and paper:help, as links to the checkout's script so they update
# with it. A command of the same name that isn't ours is left alone.
chmod +x deploy/pi/paper.sh
for name in update status logs help; do
  link=/usr/local/bin/paper:$name
  if { [ -e "$link" ] || [ -L "$link" ]; } && [[ "$(readlink "$link")" != */deploy/pi/paper.sh ]]; then
    echo "$link already exists and isn't Papershow's, so it was left alone." >&2
  else
    sudo ln -sfn "$repo/deploy/pi/paper.sh" "$link"
  fi
done

# Reach it from your Mac and phone, at home or away, over HTTPS. Tailscale is a VPN, so ask before
# installing it; with no one at the keyboard, skip it. A Pi you already use may serve other things
# through Tailscale; that setup is left alone.
if ! command -v tailscale >/dev/null && [ -r /dev/tty ]; then
  read -rp "Install Tailscale, to open Papershow from anywhere? [Y/n] " answer </dev/tty || answer=n
  if [[ ! "$answer" =~ ^[Nn] ]]; then
    curl -fsSL https://tailscale.com/install.sh | sh
  fi
fi
if command -v tailscale >/dev/null && ! tailscale status >/dev/null 2>&1 && [ -r /dev/tty ]; then
  echo "Log in to Tailscale: open the link below."
  sudo tailscale up </dev/tty || true
fi
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
  echo "Without Tailscale, Papershow is only reachable at home. Run this again to set it up."
fi

# Only one thing can drive the panel: anything else that draws on it (old scripts on a cron, a
# timer, another program) fights the client over SPI and puts its own pictures up. Look everywhere
# such a thing could live, and say what to do. Nothing is removed: these may be yours to keep.
panel='epd|e-ink|e_ink|eink|waveshare|spidev|pi-e-ink'
others=()
while read -r line; do others+=("your crontab:   $line"); done < <(crontab -l 2>/dev/null | grep -v '^\s*#' | grep -iE "$panel" || true)
while read -r line; do others+=("root's crontab: $line"); done < <(sudo crontab -l 2>/dev/null | grep -v '^\s*#' | grep -iE "$panel" || true)
while read -r line; do others+=("$line"); done < <(sudo grep -iEs "$panel" /etc/crontab /etc/cron.d/* 2>/dev/null | grep -v ':\s*#' || true)
while read -r unit; do
  others+=("systemd unit:   $unit (sudo systemctl disable --now $unit)")
done < <(grep -liE "$panel" /etc/systemd/system/*.service /etc/systemd/system/*.timer ~/.config/systemd/user/*.service ~/.config/systemd/user/*.timer 2>/dev/null |
  xargs -r -n1 basename | grep -v '^papershow' || true)
for fd in $(sudo find /proc/[0-9]*/fd -lname '/dev/spidev*' 2>/dev/null); do
  pid=$(cut -d/ -f3 <<<"$fd")
  cmd=$(tr '\0' ' ' </proc/"$pid"/cmdline 2>/dev/null || true)
  grep -q 'apps/panel/panel.py' <<<"$cmd" || others+=("running now:    pid $pid: $cmd")
done
if [ ${#others[@]} -gt 0 ]; then
  echo
  echo "Heads up: these may also draw on the panel and fight Papershow over it:"
  printf '  %s\n' "${others[@]}" | sort -u
  echo "Remove the ones that do. For cron: crontab -l > ~/crontab.backup, then crontab -e (sudo crontab -e for root's)."
  echo "If you used pi-e-ink: crontab -l | grep -v pi-e-ink | crontab -"
fi

# Say it's ready only once the server answers: it takes a few seconds to start after the restart.
echo
for _ in $(seq 30); do
  curl -fs -o /dev/null "http://127.0.0.1:$port/api/state" && break
  sleep 1
done
open="http://$name.local"
[ -n "$web_port" ] || open+=":$port"
if curl -fs -o /dev/null "http://127.0.0.1:$port/api/state"; then
  echo "Papershow $action! Ready to use."
  echo "  Version:   $(git -C "$repo" log -1 --format='%h %s')"
  echo "  Open:      $open"
  echo "  Commands:  paper:help lists them"
else
  echo "Papershow $action, but the server isn't answering yet. paper:status and paper:logs server show why." >&2
fi
