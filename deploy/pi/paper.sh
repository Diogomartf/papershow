#!/usr/bin/env bash
# Papershow's commands on the Pi. install.sh links this script into /usr/local/bin under each
# command's name, and the name it's called by picks the command:
#
#   paper:update           get the latest main and reinstall (--if-newer is the same check the
#                          nightly timer uses). If main hasn't changed, it stops. A local edit to a
#                          tracked file is dropped only when there is something to pull; .env stays.
#   paper:status           what's running, which version, where to open it, what the panel last drew
#   paper:logs [server|panel|update|health] [journalctl options]   follow the logs, both services by default
#   paper:help             list these commands
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

help() {
  cat <<'EOF'
Papershow on this Pi:
  paper:status            what's running, which version, where to open it, what the panel last drew
  paper:logs              follow the logs; paper:logs server, panel, update or health for one
  paper:update            get the latest main and reinstall (it also checks every night on its own)
  paper:help              this list
EOF
}

port() {
  local p
  p=$(systemctl show papershow -p Environment --value 2>/dev/null | tr ' ' '\n' | grep '^PORT=' | cut -d= -f2 || true)
  echo "${p:-5194}"
}

case "$cmd" in
  update)
    # Quiet for the nightly check; someone running it can see the fetch.
    if [ "${1:-}" = --if-newer ]; then
      git -C "$repo" fetch --quiet origin
    else
      git -C "$repo" fetch origin
    fi
    # Nothing new: don't reinstall. That restarts the panel and flashes it for the same picture.
    if [ "$(git -C "$repo" rev-parse HEAD)" = "$(git -C "$repo" rev-parse '@{upstream}')" ]; then
      echo "Already up to date: $(git -C "$repo" log -1 --format='%h %s')"
      exit 0
    fi
    # The checkout follows main. An edit left in a tracked file stops the pull, and the nightly
    # update with it. Drop it only when there is something to pull; .env and other untracked files stay.
    dirty=$(git -C "$repo" status --porcelain --untracked-files=no)
    if [ -n "$dirty" ]; then
      echo "Dropping local changes so main can update:"
      printf '%s\n' "$dirty"
      git -C "$repo" reset --hard HEAD
    fi
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
    # paper.local when its name service runs, and without a port when the server also has port 80.
    web=$(systemctl show papershow -p Environment --value 2>/dev/null | tr ' ' '\n' | grep '^WEB_PORT=' | cut -d= -f2 || true)
    if systemctl is-active --quiet papershow-name; then
      alias=$(systemctl show papershow-name -p Environment --value | tr ' ' '\n' | grep '^NAME=' | cut -d= -f2)
      open="http://$alias.local"
      [ -n "$web" ] || open+=":$p"
      echo "Open:     $open"
      echo "          http://$(hostname).local:$p"
    else
      echo "Open:     http://$(hostname).local:$p"
    fi
    if command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1 &&
      sudo -n tailscale serve status 2>/dev/null | grep -q "127.0.0.1:$p"; then
      name=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
      echo "          https://$name"
    fi
    if systemctl is-enabled --quiet papershow-update.timer 2>/dev/null; then
      checked=$(systemctl show papershow-update -p ExecMainExitTimestamp --value 2>/dev/null || true)
      result=$(systemctl show papershow-update -p Result --value 2>/dev/null || true)
      if [ -z "$checked" ]; then
        echo "Updates:  every night, not checked yet"
      elif [ "$result" = success ]; then
        echo "Updates:  every night, last checked $checked"
      else
        echo "Updates:  every night, but the last one failed ($checked): paper:logs update shows why"
      fi
    else
      echo "Updates:  only with paper:update"
    fi
    if [ -f "$repo/.env" ]; then
      keys=$(grep -oE '^[A-Z_]+=.' "$repo/.env" | cut -d= -f1 | paste -sd' ' - || true)
      echo "Keys:     ${keys:-none set}"
    else
      echo "Keys:     no .env, so AI apps and Stocks show stand-in content"
    fi
    last=$(journalctl -u papershow-panel --no-pager -o cat -g ' drew ' -n 1 2>/dev/null | sed 's/^[0-9-]* \([0-9:]*\),[0-9]* drew/\1/' || true)
    echo "Panel:    ${last:+last drew }${last:-nothing drawn yet}"
    health=$(journalctl -u papershow-health --no-pager -o cat -n 1 2>/dev/null || true)
    echo "Health:   ${health:-not checked yet (paper:logs health)}"
    ;;

  logs)
    units=(-u papershow -u papershow-panel)
    case "${1:-}" in
      server) units=(-u papershow); shift ;;
      panel) units=(-u papershow-panel); shift ;;
      update) units=(-u papershow-update); shift ;;
      health) units=(-u papershow-health); shift ;;
    esac
    # In colour on a terminal; plain when piped, or when you pick journalctl's own output format.
    if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && ! [[ " $* " =~ \ (-o|--output)[\ =] ]]; then
      journalctl "${units[@]}" -n 50 -f -o json "$@" | python3 -u "$repo/deploy/pi/logs.py"
    else
      exec journalctl "${units[@]}" -n 50 -f "$@"
    fi
    ;;

  help | -h | --help)
    help
    ;;

  *)
    help >&2
    exit 1
    ;;
esac
