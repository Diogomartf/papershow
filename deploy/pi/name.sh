#!/usr/bin/env bash
# Publishes <name>.local for this Pi over mDNS, alongside its own hostname, so Papershow opens at
# http://paper.local. Run by papershow-name.service, which restarts it hourly to follow a new address.
set -euo pipefail

name=$1
# The address the Pi reaches the network from: the LAN one, not Tailscale's or a container's.
ip=$(ip -4 route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p')
if [ -z "$ip" ]; then
  echo "No network address yet." >&2
  exit 1
fi
exec avahi-publish -a -R "$name.local" "$ip"
