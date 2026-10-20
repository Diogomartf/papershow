#!/usr/bin/env bash
# Logs one line on how the Pi is doing: temperature, throttling, Wi-Fi signal, load and free memory.
# papershow-health.timer runs it every 5 minutes, so the journal shows the trend before a problem
# (paper:logs health). Hot or throttled lines are warnings, which paper:logs shows in yellow.
set -uo pipefail

temp=$(awk '{ printf "%.1f", $1 / 1000 }' /sys/class/thermal/thermal_zone0/temp)
# The firmware's flags (vcgencmd get_throttled): the low bits are now, the same bits << 16 since boot.
flags=$(( $(vcgencmd get_throttled 2>/dev/null | cut -d= -f2 || echo 0) ))
notes=()
(( flags & 0x1 )) && notes+=("under-voltage now")
(( flags & 0x4 )) && notes+=("throttled now")
(( flags & 0x10000 )) && ! (( flags & 0x1 )) && notes+=("under-voltage since boot")
(( flags & 0x40000 )) && ! (( flags & 0x4 )) && notes+=("throttled since boot")
# Signal level in dBm, from the kernel without a scan: -30 is excellent, below -75 is weak.
wifi=$(awk 'NR > 2 { sub(/\.$/, "", $4); print $4 " dBm"; exit }' /proc/net/wireless)
load=$(cut -d' ' -f1 /proc/loadavg)
free=$(awk '/^MemAvailable:/ { printf "%.1f GB", $2 / 1048576 }' /proc/meminfo)

line="${temp}°C · wifi ${wifi:-off} · load $load · $free free"
[ ${#notes[@]} -eq 0 ] || line+=" · $(IFS=,; echo "${notes[*]}" | sed 's/,/, /g')"
# <4> marks the line as a warning in the journal. The Pi slows itself down at 80°C.
if [ ${#notes[@]} -gt 0 ] || awk -v t="$temp" 'BEGIN { exit !(t >= 75) }'; then
  echo "<4>$line"
else
  echo "$line"
fi
