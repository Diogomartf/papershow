#!/usr/bin/env bash
# Papershow's commands on the Pi. install.sh links this script into /usr/local/bin under each
# command's name, and the name it's called by picks the command:
#
#   paper:update           get the latest main and reinstall
#   paper:status           what's running, which version, where to open it, what the panel last drew
#   paper:logs [server|panel] [journalctl options]   follow the logs, both services by default
#
# Or call it directly: deploy/pi/paper.sh status
set -euo pipefail

repo=$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)
cmd=$(basename "$0")
cmd=${cmd#paper:}
if [ "$cmd" = paper.sh ]; then
  cmd=${1:-}
  shift || true
fi

port() {
  local p
  p=$(systemctl show papershow -p Environment --value 2>/dev/null | grep -o 'PORT=[0-9]*' | cut -d= -f2 || true)
  echo "${p:-5194}"
}

case "$cmd" in
  update)
    git -C "$repo" pull --ff-only
    # The new copy of install.sh, so changes to the install itself apply in this run.
    exec "$repo/deploy/pi/install.sh"
    ;;

  status)
    p=$(port)
    echo "Version:  $(git -C "$repo" log -1 --format='%h %s (%cr)')"
    # A quick look for a newer main; offline or slow, skip it.
    if timeout 5 git -C "$repo" fetch --quiet origin 2>/dev/null; then
      behind=$(git -C "$repo" rev-list --count 'HEAD..@{upstream}' 2>/dev/null || echo 0)
      if [ "$behind" -gt 0 ]; then echo "          $behind commit(s) behind: run paper:update"; fi
    fi
    for pair in server:papershow panel:papershow-panel; do
      unit=${pair#*:}
      state=$(systemctl is-active "$unit" 2>/dev/null || true)
      since=$(systemctl show "$unit" -p ActiveEnterTimestamp --value 2>/dev/null || true)
      printf '%-9s %s%s\n' "${pair%%:*}:" "$state" "${since:+ since $since}"
    done
    echo "Open:     http://$(hostname).local:$p"
    if command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1 &&
      sudo -n tailscale serve status 2>/dev/null | grep -q "127.0.0.1:$p"; then
      name=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
      echo "          https://$name"
    fi
    if [ -f "$repo/.env" ]; then
      keys=$(grep -oE '^[A-Z_]+=.' "$repo/.env" | cut -d= -f1 | paste -sd' ' - || true)
      echo "Keys:     ${keys:-none set}"
    else
      echo "Keys:     no .env, so AI apps and Stocks show stand-in content"
    fi
    last=$(journalctl -u papershow-panel --no-pager -o cat -g ' drew ' -n 1 2>/dev/null | sed 's/^[0-9-]* \([0-9:]*\),[0-9]* drew/\1/' || true)
    echo "Panel:    ${last:+last drew }${last:-nothing drawn yet}"
    ;;

  logs)
    units=(-u papershow -u papershow-panel)
    case "${1:-}" in
      server) units=(-u papershow); shift ;;
      panel) units=(-u papershow-panel); shift ;;
    esac
    exec journalctl "${units[@]}" -n 50 -f "$@"
    ;;

  *)
    echo "Usage: paper:update | paper:status | paper:logs [server|panel]" >&2
    exit 1
    ;;
esac
