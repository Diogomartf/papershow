"""Colours paper:logs for a terminal, so it's easy to skim: reads `journalctl -o json` on stdin and
prints one line per entry, as the time, which service, and the message. Problems are red, warnings
yellow, and what went right (a frame drawn, the server up, an update) green.

    journalctl -u papershow -u papershow-panel -o json -f | python3 deploy/pi/logs.py
"""

import json
import re
import sys
from datetime import datetime

DIM, BOLD, OFF = "\033[2m", "\033[1m", "\033[0m"
RED, GREEN, YELLOW, BLUE, MAGENTA, CYAN = (f"\033[{n}m" for n in (31, 32, 33, 34, 35, 36))

SERVICES = {
    "papershow.service": ("server", CYAN),
    "papershow-panel.service": ("panel", MAGENTA),
    "papershow-update.service": ("update", BLUE),
    "papershow-name.service": ("name", BLUE),
}
BAD = re.compile(r"error|fail|traceback|exception|unreachable|refused|rejected|denied|EADDRINUSE|fatal", re.I)
WARN = re.compile(r"warn|retrying|stand-in|unexpected|timed? ?out|skipp", re.I)
GOOD = re.compile(r"^(drew|cleaned|server on|also on|following|up to date)|ready to use|updated!|installed!", re.I)
# The panel stamps its own lines with the time; the journal's is enough.
STAMP = re.compile(r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d+ ")
# Escapes already in a message (the install's summary has its own colours).
ESCAPES = re.compile(r"\033\[[0-9;]*m")


def line(entry: dict) -> str:
    when = datetime.fromtimestamp(int(entry.get("__REALTIME_TIMESTAMP", 0)) / 1e6)
    unit = entry.get("_SYSTEMD_UNIT") or entry.get("UNIT") or ""
    name, colour = SERVICES.get(unit, (entry.get("SYSLOG_IDENTIFIER", "system"), DIM))
    message = entry.get("MESSAGE") or ""
    if isinstance(message, list):  # bytes that weren't valid text
        message = bytes(message).decode(errors="replace")
    message = ESCAPES.sub("", STAMP.sub("", message))
    priority = int(entry.get("PRIORITY", 6))
    if priority <= 3 or BAD.search(message):
        message = f"{RED}{message}{OFF}"
    elif priority == 4 or WARN.search(message):
        message = f"{YELLOW}{message}{OFF}"
    elif GOOD.search(message):
        message = f"{GREEN}{message}{OFF}"
    return f"{DIM}{when:%b %d %H:%M:%S}{OFF} {colour}{BOLD}{name:<7}{OFF} {message}"


for raw in sys.stdin:
    try:
        print(line(json.loads(raw)), flush=True)
    except ValueError:
        print(raw, end="", flush=True)
