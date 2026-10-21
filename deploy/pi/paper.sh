#!/usr/bin/env bash
# Papershow's commands on the Pi. install.sh links this script into /usr/local/bin under each
# command's name, and the name it's called by picks the command:
#
#   paper:update           get the latest release and reinstall, or the newest commit when the checkout
#                          is on a branch (--if-newer is the same check the nightly timer uses). If
#                          there's nothing new, it stops. A local edit to a tracked file is dropped
#                          only when there is something to update to; .env stays. A release that isn't
#                          signed with a key in /etc/papershow/allowed_signers is refused.
#   paper:channel [releases|main|<branch>]   what updates follow: releases (the default), or every
#                          commit on a branch, as a dev. It switches now and reinstalls if the code changed.
#   paper:status           what's running, which version, where to open it, what the panel last drew
#   paper:logs [server|panel|update|health] [journalctl options]   follow the logs, both services by default
#   paper:help             list these commands and how to use them; paper:<command> --help does too
#
# Or call it directly: deploy/pi/paper.sh status. deploy/pi/paper.sh version prints the version
# alone, for install.sh.
set -euo pipefail

repo=$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)
cmd=$(basename "$0")
cmd=${cmd#paper:}
if [ "$cmd" = paper.sh ]; then
  cmd=${1:-}
  shift || true
fi

# The brand blue (--focus in the web app), on a terminal and without NO_COLOR.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  blue=$'\e[1;38;2;62;99;221m' bold=$'\e[1m' dim=$'\e[2m' off=$'\e[0m'
else
  blue= bold= dim= off=
fi

help() {
  cat <<EOF
$blue
  ████   ███  ████  █████ ████   ████ █   █  ███  █   █
  █   █ █   █ █   █ █     █   █ █     █   █ █   █ █   █
  ████  █████ ████  ████  ████   ███  █████ █   █ █ █ █
  █     █   █ █     █     █  █      █ █   █ █   █ █ █ █
  █     █   █ █     █████ █   █ ████  █   █  ███   █ █
$off
  $blue$(version)$off  An e-ink slideshow, on this Pi.

${blue}CHECK ON IT$off
  ${bold}paper:status$off              what's running and where to open it, the version
                            and whether a newer one is out, the last frame drawn
  ${bold}paper:logs$off                follow the server and panel logs (Ctrl-C stops)
  ${bold}paper:logs server$off         only one: server, panel, update (nightly updates)
                            or health (the temperature every 15 minutes)
  ${bold}paper:logs panel -n 200$off   journalctl options go after: the last 200 lines

${blue}UPDATE$off
  ${bold}paper:update$off              get the latest release and reinstall; if there's
                            nothing new, it stops. .env stays. The Pi also does
                            this every night on its own
  ${bold}paper:channel$off             say what updates follow
  ${bold}paper:channel main$off        follow every commit on main (dev)
  ${bold}paper:channel releases$off    go back to releases, the default
  ${bold}paper:channel <branch>$off    follow a branch, to try a PR on the real panel

${blue}HELP$off
  ${bold}paper:help$off                this list; paper:<command> --help works too

${dim}Keys and settings are in $repo/.env
More: https://github.com/Diogomartf/papershow#commands-on-the-pi$off
EOF
}

# A checkout on a branch follows it; one on a tag (detached, as the one-line install leaves it)
# follows releases.
on_branch() { git -C "$repo" symbolic-ref -q HEAD >/dev/null; }

# The newest release: the highest vX.Y.Z tag, leaving out pre-releases like v1.0.0-rc1.
latest() { git -C "$repo" tag -l 'v*' --sort=-v:refname | grep -v -- - | head -1 || true; }

# Releases are signed, and a Pi installs only those signed with a key it already trusts: the list
# install.sh pins in /etc/papershow on the first install. Without it, anyone who could push a tag to
# GitHub could put code on every Pi, and the nightly update runs the install with sudo.
signers=/etc/papershow/allowed_signers
signed() { git -C "$repo" -c gpg.ssh.allowedSignersFile="$signers" verify-tag "$1" >/dev/null 2>&1; }
unsigned() {
  if [ -f "$signers" ]; then
    echo "$1 isn't signed with a Papershow release key, so it wasn't installed. This Pi stays on $(version)." >&2
  else
    echo "$signers is missing, so releases can't be checked. Run $repo/deploy/pi/install.sh to put it back." >&2
  fi
  exit 1
}

# v0.4.0 on a release, v0.4.0+3 three commits after it, the commit alone before the first release.
version() {
  local described count
  described=$(git -C "$repo" describe --tags --match 'v*' --long 2>/dev/null) || {
    git -C "$repo" log -1 --format=%h
    return
  }
  count=${described%-g*}
  count=${count##*-}
  if [ "$count" = 0 ]; then echo "${described%-*-g*}"; else echo "${described%-*-g*}+$count"; fi
}

# What the commit is: for GitHub's "Merge pull request #29 from …", the PR's number and title.
summary() {
  local subject
  subject=$(git -C "$repo" log -1 --format=%s)
  if [[ "$subject" =~ ^Merge\ pull\ request\ (#[0-9]+) ]]; then
    subject="${BASH_REMATCH[1]} $(git -C "$repo" log -1 --format=%b | head -1)"
  fi
  echo "$subject"
}

# What updates go to, for paper:status and paper:channel.
following() {
  if on_branch; then echo "the newest $(git -C "$repo" branch --show-current)"; else echo "the latest release"; fi
}

# An edit left in a tracked file stops an update, and the nightly one with it. Drop it only when there
# is something to update to; .env and other untracked files stay.
drop_edits() {
  local dirty
  dirty=$(git -C "$repo" status --porcelain --untracked-files=no)
  if [ -n "$dirty" ]; then
    echo "Dropping local changes so Papershow can update:"
    printf '%s\n' "$dirty"
    git -C "$repo" reset --hard HEAD
  fi
}

port() {
  local p
  p=$(systemctl show papershow -p Environment --value 2>/dev/null | tr ' ' '\n' | grep '^PORT=' | cut -d= -f2 || true)
  echo "${p:-5194}"
}

# paper:update --help shouldn't update, and paper:logs --help shouldn't hand it to journalctl.
case "${1:-}" in -h | --help) cmd=help ;; esac

case "$cmd" in
  update)
    # Quiet for the nightly check; someone running it can see the fetch. No --force: releases are never moved,
    # so a tag that changed on GitHub is refused, and the update stops there instead of installing it as root.
    if [ "${1:-}" = --if-newer ]; then
      git -C "$repo" fetch --quiet --tags origin
    else
      git -C "$repo" fetch --tags origin
    fi
    if on_branch; then
      target='@{upstream}'
    else
      target=$(latest)
      if [ -z "$target" ]; then
        echo "No release to update to. Follow main instead: git -C $repo switch main" >&2
        exit 1
      fi
    fi
    # Nothing new: don't reinstall. That restarts the panel and flashes it for the same picture.
    if [ "$(git -C "$repo" rev-parse HEAD)" = "$(git -C "$repo" rev-parse "$target^{commit}")" ]; then
      echo "Already up to date: $(version) $(summary)"
      exit 0
    fi
    on_branch || signed "$target" || unsigned "$target"
    drop_edits
    if on_branch; then
      git -C "$repo" pull --ff-only
    else
      echo "Updating $(version) to $target"
      git -C "$repo" switch --quiet --detach "$target"
    fi
    # The new copy of install.sh, so changes to the install itself apply in this run.
    exec "$repo/deploy/pi/install.sh"
    ;;

  channel)
    if [ -z "${1:-}" ]; then
      echo "Updates go to $(following)."
      echo "paper:channel main follows every commit on main (dev); paper:channel releases goes back."
      exit 0
    fi
    git -C "$repo" fetch --quiet --tags origin
    before=$(git -C "$repo" rev-parse HEAD)
    if [ "$1" = releases ]; then
      target=$(latest)
      if [ -z "$target" ]; then
        echo "There's no release yet, so this Pi stays on $(following)." >&2
        exit 1
      fi
      signed "$target" || unsigned "$target"
      [ "$before" = "$(git -C "$repo" rev-parse "$target^{commit}")" ] || drop_edits
      git -C "$repo" switch --quiet --detach "$target"
    else
      if ! git -C "$repo" rev-parse --verify --quiet "origin/$1" >/dev/null; then
        echo "There's no branch $1 on GitHub. paper:channel releases, main, or a branch's name." >&2
        exit 1
      fi
      [ "$before" = "$(git -C "$repo" rev-parse "origin/$1")" ] || drop_edits
      # Creates the branch from GitHub's the first time, and tracks it.
      git -C "$repo" switch --quiet "$1"
      git -C "$repo" pull --quiet --ff-only
    fi
    echo "Updates now go to $(following): $(version) $(summary)"
    # Commits on a branch aren't signed with the release key (GitHub signs its own merges), so they're taken as they are.
    on_branch && echo "Commits on a branch aren't checked like releases: this is for trying unreleased code. paper:channel releases goes back."
    # Reinstall only if the code changed: a restart flashes the panel.
    [ "$(git -C "$repo" rev-parse HEAD)" = "$before" ] || exec "$repo/deploy/pi/install.sh"
    ;;

  status)
    p=$(port)
    echo "Version:  $(version) ($(git -C "$repo" log -1 --format='%h, %cr'))"
    echo "          $(summary)"
    # A quick look for something newer; offline or slow, skip it.
    if timeout 5 git -C "$repo" fetch --quiet --tags origin 2>/dev/null; then
      if on_branch; then
        behind=$(git -C "$repo" rev-list --count 'HEAD..@{upstream}' 2>/dev/null || echo 0)
        if [ "$behind" -gt 0 ]; then echo "          $behind commit(s) behind: run paper:update"; fi
      else
        newest=$(latest)
        if [ -n "$newest" ] && [ "$(git -C "$repo" rev-parse HEAD)" != "$(git -C "$repo" rev-parse "$newest^{commit}")" ]; then
          echo "          $newest is out: run paper:update"
        fi
      fi
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
    to="to $(following)"
    if systemctl is-enabled --quiet papershow-update.timer 2>/dev/null; then
      checked=$(systemctl show papershow-update -p ExecMainExitTimestamp --value 2>/dev/null || true)
      result=$(systemctl show papershow-update -p Result --value 2>/dev/null || true)
      if [ -z "$checked" ]; then
        echo "Updates:  every night $to, not checked yet"
      elif [ "$result" = success ]; then
        echo "Updates:  every night $to, last checked $checked"
      else
        echo "Updates:  every night, but the last one failed ($checked): paper:logs update shows why"
      fi
    else
      echo "Updates:  only with paper:update, $to"
    fi
    if [ -f "$repo/.env" ]; then
      keys=$(grep -oE '^[A-Z_]+=.' "$repo/.env" | cut -d= -f1 | paste -sd' ' - || true)
      echo "Keys:     ${keys:-none set}"
    else
      echo "Keys:     no .env, so AI apps and Stocks show stand-in content"
    fi
    last=$(journalctl -u papershow-panel --no-pager -o cat -g ' drew ' -n 1 2>/dev/null | sed 's/^[0-9-]* \([0-9:]*\),[0-9]* drew/\1/' || true)
    echo "Panel:    ${last:+last drew }${last:-nothing drawn yet}"
    # Its own lines, not systemd's "Started" and "Finished" around each run.
    health=$(journalctl _SYSTEMD_UNIT=papershow-health.service --no-pager -o cat -n 1 2>/dev/null || true)
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

  version)
    echo "$(version) $(summary)"
    ;;

  help | -h | --help)
    help
    ;;

  *)
    help >&2
    exit 1
    ;;
esac
