#!/usr/bin/env python3
"""Papershow panel client: puts the server's /live frame on a Waveshare 7.5" V2 (800×480).

It long-polls /live.bin and redraws only when the ETag changes, so the server decides when
the picture changes and the panel never flashes for nothing. See "The panel's contract" in
the README.

  PAPERSHOW_URL   server to follow (http://localhost:5194)
  PANEL_PARTIAL   quick partial refreshes in a row before a full one (10; 0 = always full)
  PANEL_ROTATE    degrees to turn the frame, for a panel mounted upside down (0)
  PANEL_CLEAN_HOUR  hour for the daily deep clean when night mode is off (3)
  PANEL_OUT       write frames to this PNG instead of the panel, to try it without one
"""

import logging
import os
import sys
import time
from datetime import datetime
import urllib.error
import urllib.request

from PIL import Image

W, H = 800, 480
URL = os.environ.get("PAPERSHOW_URL", "http://localhost:5194").rstrip("/") + "/live.bin?wait=1"
PARTIAL = int(os.environ.get("PANEL_PARTIAL", "10"))
ROTATE = int(os.environ.get("PANEL_ROTATE", "0"))
CLEAN_HOUR = int(os.environ.get("PANEL_CLEAN_HOUR", "3"))
CLEAN_EVERY = 20 * 3600  # at most one deep clean per night, even if night starts before midnight
OUT = os.environ.get("PANEL_OUT")

log = logging.getLogger("panel")


def fetch(etag):
    """One long-poll: the server answers when the frame changes, or with 304 after 55 s."""
    req = urllib.request.Request(URL, headers={"User-Agent": "papershow-panel/1"})
    if etag:
        req.add_header("If-None-Match", etag)
    try:
        with urllib.request.urlopen(req, timeout=75) as res:
            return res.status, res.read(), res.headers
    except urllib.error.HTTPError as e:
        if e.code == 304:
            return 304, b"", e.headers
        raise


class Panel:
    """The e-ink display. Full refreshes flash but clear ghosting; partial ones are quiet but leave traces."""

    def __init__(self):
        # Waveshare's driver, the copy known to work on this panel, sits next to this file.
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from waveshare_epd import epd7in5_V2

        self.epd = epd7in5_V2.EPD()

    def show(self, img, full):
        buf = self.epd.getbuffer(img)
        if full:
            self.epd.init()
            self.epd.display(buf)
        else:
            self.epd.init_part()
            self.epd.display_Partial(buf, 0, 0, W, H)
        # Waveshare warns that leaving the panel powered for long damages it, so it sleeps between frames.
        self.epd.sleep()

    def clean(self):
        """White, black, white: driving every pixel all the way both ways clears the ghosting that
        partial and normal full refreshes leave behind. Clearing to white twice only pushes one way."""
        self.epd.init()
        self.epd.Clear()
        self.epd.display(bytearray([0xFF]) * (W * H // 8))  # all black: 1 = ink on the panel's side
        self.epd.Clear()
        self.epd.sleep()


class FilePanel:
    """Stands in for the display: writes each frame to a PNG."""

    def __init__(self, path):
        self.path = path

    def show(self, img, full):
        img.save(self.path)

    def clean(self):
        pass


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    panel = FilePanel(OUT) if OUT else Panel()
    # The logo while the server starts up (apps/server/src/splash.tsx draws it).
    splash = os.path.join(os.path.dirname(os.path.abspath(__file__)), "splash.png")
    panel.show(Image.open(splash).convert("1").rotate(ROTATE), True)
    log.info("following %s", URL)
    etag = source = img = was_asleep = None
    partials = PARTIAL  # the first frame after a start is a full refresh
    cleaned_at = 0.0
    while True:
        try:
            status, body, headers = fetch(etag)
        except OSError as e:
            log.warning("server unreachable (%s); keeping the picture, retrying in 30 s", e)
            time.sleep(30)
            continue

        # The daily deep clean happens as night begins, so it moves with the night hours set on
        # the Dashboard and nobody watches it flash. With night mode off, it runs at CLEAN_HOUR.
        asleep = bool(headers.get("X-Sleep-Until"))
        nightfall = asleep and was_asleep is False
        was_asleep = asleep
        drawable = img is not None or status == 200
        clean = drawable and time.time() - cleaned_at > CLEAN_EVERY and (nightfall or datetime.now().hour == CLEAN_HOUR)
        if clean:
            cleaned_at = time.time()

        if status == 200 and len(body) == W * H // 8:
            # /live.bin is 1 bit per pixel, MSB first, 1 = white: exactly PIL's raw "1" layout.
            img = Image.frombytes("1", (W, H), body).rotate(ROTATE)
            if clean:
                panel.clean()
                log.info("cleaned the panel")
            new_source = headers.get("X-Source")
            # A clock ticking over is the same source and suits a partial refresh. A new picture
            # gets a full one, and so does every PARTIAL-th tick, to clear the ghosting.
            full = clean or new_source is None or new_source != source or partials >= PARTIAL
            panel.show(img, full)
            partials = 0 if full else partials + 1
            etag, source = headers.get("ETag"), new_source
            log.info("drew %s (%s refresh)", new_source or "frame", "full" if full else "partial")
            continue

        # No new frame: if it's time, clean and put the same picture back.
        if clean:
            panel.clean()
            panel.show(img, True)
            partials = 0
            log.info("cleaned the panel")
        if status == 204:
            # Asleep and keeping the last picture. With an ETag we can keep long-polling; without one
            # nothing is on air, so don't spin.
            etag = headers.get("ETag")
            if not etag:
                time.sleep(60)
        elif status != 304:
            log.warning("unexpected answer %s (%d bytes); retrying in 30 s", status, len(body))
            time.sleep(30)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
