// Which image is on /live right now. Pure: same inputs, same answer, so every
// client asking at the same moment agrees without the server keeping a clock.

export type Slide = {
  id: string;
  imageId: string;
  position: number;
  durationS: number;
  enabled: boolean;
  /** 0 = Sunday … 6 = Saturday */
  days: number[];
  /** 'HH:MM' local time; both null = all day. start > end wraps past midnight. */
  start: string | null;
  end: string | null;
};

/** Either a chosen image held on /live, or the playlist rotating. */
export type Live = { mode: "rotate" } | { mode: "pin"; imageId: string };

export type Showing = {
  imageId: string;
  /** null when pinned */
  slideId: string | null;
  /** When to look again: the clip ends, or a time window may open or close. null = holds until edited. */
  endsAt: number | null;
  /** Where the current clip sits in wall-clock time, for the playhead. */
  clip: { startedAt: number; endsAt: number } | null;
};

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export function isActive(slide: Slide, at: Date): boolean {
  if (!slide.enabled || !slide.days.includes(at.getDay())) return false;
  if (!slide.start || !slide.end) return true;
  const now = at.getHours() * 60 + at.getMinutes();
  const from = minutes(slide.start);
  const to = minutes(slide.end);
  return from <= to ? now >= from && now < to : now >= from || now < to;
}

/** Seconds until the next minute boundary, when a time window could open or close. */
const toNextMinute = (now: number) => 60_000 - (now % 60_000);

export function showing(live: Live, slides: Slide[], now = Date.now()): Showing | null {
  if (live.mode === "pin") return { imageId: live.imageId, slideId: null, endsAt: null, clip: null };

  const at = new Date(now);
  const eligible = slides.filter((s) => isActive(s, at)).sort((a, b) => a.position - b.position);
  const windowed = slides.some((s) => s.start && s.end);
  if (!eligible.length) return null;

  // Rotate on wall-clock time: offset into the cycle picks the slide.
  const cycle = eligible.reduce((sum, s) => sum + s.durationS * 1000, 0);
  let t = now % cycle;
  for (const slide of eligible) {
    const ms = slide.durationS * 1000;
    if (t < ms) {
      const clip = { startedAt: now - t, endsAt: now + (ms - t) };
      // A single clip never changes on its own.
      let endsAt: number | null = eligible.length === 1 ? null : clip.endsAt;
      if (windowed) endsAt = Math.min(endsAt ?? Infinity, now + toNextMinute(now));
      return { imageId: slide.imageId, slideId: slide.id, endsAt, clip };
    }
    t -= ms;
  }
  return null; // unreachable
}

/** The next few clip changes, for the admin's "up next". */
export function upcoming(slides: Slide[], now = Date.now(), count = 3): { slideId: string; at: number }[] {
  const out: { slideId: string; at: number }[] = [];
  let current = showing({ mode: "rotate" }, slides, now);
  // Step through look-again points; minute ticks inside one clip are skipped.
  for (let guard = 0; current?.endsAt && out.length < count && guard < 500; guard++) {
    const at = current.endsAt;
    const next = showing({ mode: "rotate" }, slides, at);
    if (next?.slideId && next.slideId !== current.slideId) out.push({ slideId: next.slideId, at });
    current = next;
  }
  return out;
}
