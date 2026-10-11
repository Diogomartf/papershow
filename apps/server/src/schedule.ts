// Which image is on /live right now. Pure: same inputs, same answer, so every
// client asking at the same moment agrees without the server keeping a clock.

/** What a slide shows: a drawing from ImageGen, or an app that renders from data. */
export type Source = { kind: "image" | "app"; id: string };

export const sameSource = (a: Source, b: Source) => a.kind === b.kind && a.id === b.id;

export type Slide = {
  /** Unique within the loop: a clip's id, or "<entry>~<clip>" once expanded from the show. */
  id: string;
  /** Null for an image or app placed in the show on its own. */
  playlistId: string | null;
  /** The show entry this came from (set once expanded). */
  entryId?: string;
  /** The playlist clip behind it, if any (set once expanded). */
  clipId?: string | null;
  source: Source;
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
export type Live = { mode: "rotate" } | { mode: "pin"; source: Source };

export type Showing = {
  source: Source;
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

/** Inside a daily 'HH:MM'–'HH:MM' window; start > end wraps past midnight. */
function inWindow(start: string, end: string, at: Date) {
  const now = at.getHours() * 60 + at.getMinutes();
  const from = minutes(start);
  const to = minutes(end);
  if (from === to) return false;
  return from < to ? now >= from && now < to : now >= from || now < to;
}

export function isActive(slide: Slide, at: Date): boolean {
  if (!slide.enabled || !slide.days.includes(at.getDay())) return false;
  if (!slide.start || !slide.end) return true;
  return inWindow(slide.start, slide.end, at);
}

// ── Night ──────────────────────────────────────────────────────────────────

/** Hours when the panel sleeps, and what it shows meanwhile ("off" keeps the last picture). */
export type Sleep = { enabled: boolean; start: string; end: string; screen: "moon" | "blank" | "off" };

export const DEFAULT_SLEEP: Sleep = { enabled: false, start: "23:00", end: "07:00", screen: "moon" };

/** If the panel is asleep at `now`, when it wakes; otherwise null. */
export function sleepUntil(sleep: Sleep, now = Date.now()): number | null {
  const at = new Date(now);
  if (!sleep.enabled || !inWindow(sleep.start, sleep.end, at)) return null;
  const [h, m] = sleep.end.split(":").map(Number);
  const wake = new Date(at);
  wake.setHours(h, m, 0, 0);
  if (wake.getTime() <= now) wake.setDate(wake.getDate() + 1);
  return wake.getTime();
}

/** Seconds until the next minute boundary, when a time window could open or close. */
const toNextMinute = (now: number) => 60_000 - (now % 60_000);

export function showing(live: Live, slides: Slide[], now = Date.now()): Showing | null {
  if (live.mode === "pin") return { source: live.source, slideId: null, endsAt: null, clip: null };

  const at = new Date(now);
  // `slides` arrive in play order (playlist by playlist), so keep that order.
  const eligible = slides.filter((s) => isActive(s, at));
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
      return { source: slide.source, slideId: slide.id, endsAt, clip };
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

/** One clip's turn on air. */
export type Turn = {
  key: string;
  entryId: string | null;
  /** The playlist clip, or null for a single image or app in the show. */
  clipId: string | null;
  playlistId: string | null;
  source: Source;
  at: number;
  endsAt: number;
};

/**
 * The loop from now: the clip on air, then every change after it until the loop
 * comes back around (or `max` turns). Time windows are respected along the way.
 */
export function sequence(slides: Slide[], now = Date.now(), max = 60): Turn[] {
  const byId = new Map(slides.map((s) => [s.id, s]));
  const turn = (t: number): Turn | null => {
    const s = showing({ mode: "rotate" }, slides, t);
    const slide = s?.slideId ? byId.get(s.slideId) : undefined;
    if (!s?.clip || !slide) return null;
    return {
      key: slide.id,
      entryId: slide.entryId ?? null,
      clipId: slide.clipId ?? (slide.entryId ? null : slide.id),
      playlistId: slide.playlistId,
      source: slide.source,
      at: s.clip.startedAt,
      endsAt: s.clip.endsAt,
    };
  };
  const first = turn(now);
  if (!first) return [];
  const out = [first];
  for (let t = first.endsAt; out.length < max; ) {
    const next = turn(t);
    if (!next || (next.key === first.key && out.length > 1)) break;
    out.push(next);
    t = next.endsAt;
  }
  return out;
}
