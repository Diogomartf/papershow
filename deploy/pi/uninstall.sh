#!/usr/bin/env bash
# Takes Papershow off the Pi: stops and removes its services (server, panel, and the paper.local
# name) and the paper: commands, blanks the panel, and removes its Tailscale address. Your drawings
# and shows stay in /var/lib/papershow unless you pass --purge. Node, pnpm's cache, the Python
# libraries, avahi, SPI and Tailscale itself stay too: other things on the Pi may use them. Run
# deploy/pi/install.sh to put it all back.
#
#   deploy/pi/uninstall.sh            # keep the data
#   deploy/pi/uninstall.sh --purge    # delete it as well
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
port=$(systemctl show papershow -p Environment --value 2>/dev/null | tr ' ' '\n' | grep '^PORT=' | cut -d= -f2 || true)
port=${port:-5194}

sudo systemctl disable --now papershow-name papershow-panel papershow 2>/dev/null || true
for unit in papershow papershow-panel papershow-name; do
  sudo rm -rf "/etc/systemd/system/$unit.service" "/etc/systemd/system/$unit.service.d"
done
sudo systemctl daemon-reload
echo "Removed the papershow, papershow-panel and papershow-name services."

for name in update status logs help; do
  link=/usr/local/bin/paper:$name
  if [[ "$(readlink "$link" 2>/dev/null)" == */deploy/pi/paper.sh ]]; then sudo rm -f "$link"; fi
done
echo "Removed the paper: commands."

# Leave the panel white rather than showing a frozen Papershow frame.
if [ -e /dev/spidev0.0 ]; then
  (cd "$repo/apps/panel" && python3 -c '
from waveshare_epd import epd7in5_V2
epd = epd7in5_V2.EPD(); epd.init(); epd.Clear(); epd.sleep()
') && echo "Blanked the panel." || echo "Couldn't blank the panel; it keeps its last picture." >&2
fi

# Only undo Tailscale serve if it serves Papershow and nothing else.
if command -v tailscale >/dev/null; then
  serving=$(sudo tailscale serve status 2>/dev/null || true)
  if grep -q "127.0.0.1:$port" <<<"$serving"; then
    if [ "$(grep -c 'proxy' <<<"$serving")" -le 1 ]; then
      sudo tailscale serve reset
      echo "Removed the Tailscale address."
    else
      echo "Tailscale serves other things too, so it was left alone. Remove Papershow's entry with 'tailscale serve' (see: sudo tailscale serve status)."
    fi
  fi
fi

if [ "${1:-}" = --purge ]; then
  sudo rm -rf /var/lib/papershow
  echo "Deleted the data in /var/lib/papershow."
elif [ -d /var/lib/papershow ]; then
  echo "Kept your drawings and shows in /var/lib/papershow (--purge deletes them)."
fi

echo "Done. The code is still in $repo: delete it with 'rm -rf $repo' if you're done with it."
