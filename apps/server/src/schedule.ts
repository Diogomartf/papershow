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

/**
 * Either the playlists rotating, or something put on /live with Show now: until `until`, when the playlists take
 * over again by themselves (no `until`: until you resume them).
 */
export type Live = { mode: "rotate" } | { mode: "pin"; source: Source; until?: number | null };

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

/**
 * Hours when the panel sleeps, and what it shows meanwhile ("off" keeps the last picture). `away` turns the
 * panel off for days (a holiday, a weekend out) until it's switched back, or until the morning of `back`.
 */
export type Sleep = {
  enabled: boolean;
  start: string;
  end: string;
  screen: "moon" | "blank" | "off";
  away: boolean;
  /** 'YYYY-MM-DD' local date when away ends, at the night's wake-up time; null = until switched back. */
  back: string | null;
};

export const DEFAULT_SLEEP: Sleep = { enabled: false, start: "23:00", end: "07:00", screen: "moon", away: false, back: null };

/** If the panel is away at `now`, when it comes back: 0 when it waits to be switched back. Otherwise null. */
export function awayUntil(sleep: Sleep, now = Date.now()): number | null {
  if (!sleep.away) return null;
  if (!sleep.back) return 0;
  const [y, mo, d] = sleep.back.split("-").map(Number);
  const [h, m] = sleep.end.split(":").map(Number);
  const back = new Date(y, mo - 1, d, h, m).getTime();
  return now < back ? back : null;
}

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

// ── Repeats ────────────────────────────────────────────────────────────────

/**
 * A show entry that interrupts the loop instead of taking turns in it: every `everyM` minutes on the clock (a
 * single image or app), or at set `times` each day (also a whole playlist, its clips back to back).
 */
export type Repeat = {
  id: string;
  clips: { id: string; source: Source; durationS: number; clipId: string | null; playlistId: string | null }[];
  everyM?: number | null;
  /** 'HH:MM' local times, sorted. */
  times?: string[] | null;
};

/** Choices that divide the day evenly, so "every hour" lands on the hour. */
export const REPEAT_EVERY = [15, 30, 60, 120, 180];

const DAY = 24 * 60 * 60_000;
const midnightOf = (now: number) => new Date(now).setHours(0, 0, 0, 0);
/** `hhmm` on the day of `day`, as epoch ms (local time, so it follows daylight saving). */
const timeOn = (day: number, hhmm: string) => {
  const d = new Date(day);
  const [h, m] = hhmm.split(":").map(Number);
  return d.setHours(h, m, 0, 0);
};

/** When the latest slot began, at or before `now`. */
function slotStart(r: Repeat, now: number) {
  if (r.times?.length) {
    const today = r.times.map((t) => timeOn(now, t)).filter((t) => t <= now);
    return today.length ? Math.max(...today) : timeOn(midnightOf(now) - DAY / 2, r.times.at(-1)!);
  }
  const midnight = midnightOf(now);
  const every = r.everyM! * 60_000;
  return midnight + Math.floor((now - midnight) / every) * every;
}

/** When the next slot begins, after `now`. */
function nextSlot(r: Repeat, now: number) {
  if (r.times?.length) {
    const today = r.times.map((t) => timeOn(now, t)).filter((t) => t > now);
    return today.length ? Math.min(...today) : timeOn(midnightOf(now) + DAY * 1.5, r.times[0]);
  }
  return slotStart(r, now) + r.everyM! * 60_000;
}

/**
 * How long a slot lasts: its clips back to back, but at least a minute short of the next slot, so the loop
 * always gets a turn.
 */
function repeatMs(r: Repeat) {
  const total = r.clips.reduce((n, c) => n + c.durationS * 1000, 0);
  if (!r.times?.length) return Math.min(total, (r.everyM! - 1) * 60_000);
  const mins = r.times.map(minutes);
  const gaps = mins.map((m, i) => (i + 1 < mins.length ? mins[i + 1] - m : mins[0] + 24 * 60 - m));
  return Math.min(total, (Math.min(...gaps) - 1) * 60_000);
}

/** The slide id of a repeat's clip: the entry's own for a single image or app, "<entry>~<clip>" for a playlist's. */
const repeatSlideId = (r: Repeat, c: Repeat["clips"][number]) => (c.clipId ? `${r.id}~${c.clipId}` : r.id);

/** The repeat on air at `now`, if any, and which of its clips; the first in show order wins a tie. */
function repeatAt(repeats: Repeat[], now: number) {
  for (const r of repeats) {
    const startedAt = slotStart(r, now);
    const ends = startedAt + repeatMs(r);
    if (now >= ends) continue;
    let at = startedAt;
    for (const c of r.clips) {
      const until = Math.min(at + c.durationS * 1000, ends);
      if (now < until) return { r, c, clip: { startedAt: at, endsAt: until } };
      at = until;
    }
  }
  return null;
}

/** Seconds until the next minute boundary, when a time window could open or close. */
const toNextMinute = (now: number) => 60_000 - (now % 60_000);

export function showing(live: Live, slides: Slide[], now = Date.now(), repeats: Repeat[] = []): Showing | null {
  if (live.mode === "pin" && (!live.until || now < live.until))
    return { source: live.source, slideId: null, endsAt: live.until ?? null, clip: null };

  // A repeat takes over for its slot; the loop keeps time underneath and resumes where the clock says.
  const rep = repeatAt(repeats, now);
  if (rep) return { source: rep.c.source, slideId: repeatSlideId(rep.r, rep.c), endsAt: rep.clip.endsAt, clip: rep.clip };

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
      if (repeats.length) {
        // On air between the last repeat and the next one.
        const lastEnd = Math.max(...repeats.map((r) => slotStart(r, now) + repeatMs(r)));
        const next = Math.min(...repeats.map((r) => nextSlot(r, now)));
        clip.startedAt = Math.max(clip.startedAt, lastEnd);
        clip.endsAt = Math.min(clip.endsAt, next);
        endsAt = Math.min(endsAt ?? Infinity, next);
      }
      return { source: slide.source, slideId: slide.id, endsAt, clip };
    }
    t -= ms;
  }
  return null; // unreachable
}

/** The next few clip changes, for the admin's "up next". */
export function upcoming(slides: Slide[], now = Date.now(), count = 3, repeats: Repeat[] = []): { slideId: string; at: number }[] {
  const out: { slideId: string; at: number }[] = [];
  let current = showing({ mode: "rotate" }, slides, now, repeats);
  // Step through look-again points; minute ticks inside one clip are skipped.
  for (let guard = 0; current?.endsAt && out.length < count && guard < 500; guard++) {
    const at = current.endsAt;
    const next = showing({ mode: "rotate" }, slides, at, repeats);
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
 * comes back around (or `max` turns). Time windows and repeats are respected along the way.
 */
export function sequence(slides: Slide[], now = Date.now(), max = 60, repeats: Repeat[] = []): Turn[] {
  const byId = new Map(slides.map((s) => [s.id, s]));
  // Every clip a repeat can show, by the slide id it airs under.
  const repeatById = new Map(repeats.flatMap((r) => r.clips.map((c) => [repeatSlideId(r, c), { r, c }] as const)));
  const turn = (t: number): Turn | null => {
    const s = showing({ mode: "rotate" }, slides, t, repeats);
    if (!s?.clip || !s.slideId) return null;
    const rep = repeatById.get(s.slideId);
    if (rep)
      return {
        key: s.slideId,
        entryId: rep.r.id,
        clipId: rep.c.clipId,
        playlistId: rep.c.playlistId,
        source: rep.c.source,
        at: s.clip.startedAt,
        endsAt: s.clip.endsAt,
      };
    const slide = byId.get(s.slideId);
    if (!slide) return null;
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
  const nextRepeat = (t: number) => Math.min(...repeats.map((r) => nextSlot(r, t)));
  // Only repeats and nothing on air yet: start from the next one.
  const first = turn(now) ?? (repeats.length ? turn(nextRepeat(now)) : null);
  if (!first) return [];
  const out = [first];
  if (!repeats.length) {
    for (let t = first.endsAt; out.length < max; ) {
      const next = turn(t);
      if (!next || (next.key === first.key && out.length > 1)) break;
      out.push(next);
      t = next.endsAt;
    }
    return out;
  }
  // With repeats the same clip can come back after an interruption, so look ahead by time instead:
  // one time around the loop, or until every repeat has come up at least once.
  const at = new Date(now);
  const cycle = slides.filter((s) => isActive(s, at)).reduce((sum, s) => sum + s.durationS * 1000, 0);
  // A repeat on the clock: until it has come round. One at set times: through it and one more time around the
  // loop, but only when it airs within a time around (or there's no loop); hours away, it would list the loop all day.
  const reach = (r: Repeat) => {
    const until = nextSlot(r, first.at) - first.at + repeatMs(r);
    if (!r.times?.length) return r.everyM! * 60_000;
    return !cycle ? until : until - repeatMs(r) <= cycle ? until + cycle : 0;
  };
  const horizon = first.at + Math.max(cycle, ...repeats.map(reach));
  for (let t = first.endsAt; out.length < max && t < horizon; ) {
    const next = turn(t);
    if (!next) {
      // Nothing in the loop: skip ahead to the next repeat.
      if (nextRepeat(t) >= horizon) break;
      t = nextRepeat(t);
      continue;
    }
    out.push(next);
    t = next.endsAt;
  }
  return out;
}
