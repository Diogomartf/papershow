#!/usr/bin/env bash
# Logs one line on how the Pi is doing: temperature, throttling, Wi-Fi signal, load and free memory.
# papershow-health.timer runs it every 15 minutes, so the journal shows the trend before a problem
# (paper:logs health). Hot or throttled lines are warnings, which paper:logs shows in yellow.
# While the panel is asleep, only on the hour, unless something is wrong.
set -uo pipefail

temp=$(awk '{ printf "%.1f", $1 / 1000 }' /sys/class/thermal/thermal_zone0/temp)
# The firmware's flags (vcgencmd get_throttled): the low bits are now, the same bits << 16 since boot.
flags=$(( $(vcgencmd get_throttled 2>/dev/null | cut -d= -f2 || echo 0) ))
notes=()
(( flags & 0x1 )) && notes+=("under-voltage now")
(( flags & 0x4 )) && notes+=("throttled now")
(( flags & 0x10000 )) && ! (( flags & 0x1 )) && notes+=("under-voltage since boot")
(( flags & 0x40000 )) && ! (( flags & 0x4 )) && notes+=("throttled since boot")
# The Pi slows itself down at 80°C.
warn=
if [ ${#notes[@]} -gt 0 ] || awk -v t="$temp" 'BEGIN { exit !(t >= 75) }'; then warn=yes; fi

# Asleep for the night (or away): the server says so in /live's headers. ?e=1 keeps this out of the
# Dashboard's "last fetched". With the server down it counts as awake, so the lines keep coming.
asleep=$(curl -fs -m 5 -o /dev/null -D - "http://127.0.0.1:${PORT:-5194}/live?e=1" | grep -i '^x-sleep-until:' || true)
if [ -n "$asleep" ] && [ -z "$warn" ] && [ "$(date +%-M)" -ge 15 ]; then
  exit 0
fi

# Signal level in dBm, from the kernel without a scan: -30 is excellent, below -75 is weak.
wifi=$(awk 'NR > 2 { sub(/\.$/, "", $4); print $4 " dBm"; exit }' /proc/net/wireless)
load=$(cut -d' ' -f1 /proc/loadavg)
free=$(awk '/^MemAvailable:/ { printf "%.1f GB", $2 / 1048576 }' /proc/meminfo)

line="${temp}°C · wifi ${wifi:-off} · load $load · $free free"
[ ${#notes[@]} -eq 0 ] || line+=" · $(IFS=,; echo "${notes[*]}" | sed 's/,/, /g')"
[ -z "$asleep" ] || line+=" · asleep"
# <4> marks the line as a warning in the journal.
if [ -n "$warn" ]; then
  echo "<4>$line"
else
  echo "$line"
fi
