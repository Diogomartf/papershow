// Which image is on /live right now. Pure: same inputs, same answer, so every
// client asking at the same moment agrees without the server keeping a clock.

/** What a slide shows: a drawing from ImageGen, or an app that renders from data. */
export type Source = { kind: "image" | "app"; id: string };

export const sameSource = (a: Source, b: Source) => a.kind === b.kind && a.id === b.id;

export type Slide = {
  /** Unique within the program: a clip's id, or "<entry>~<clip>" once expanded from the show. */
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
  /** No longer used: the program's blocks decide days and hours. Kept as stored. */
  days: number[];
  start: string | null;
  end: string | null;
};

/**
 * Either the program running, or something put on /live with Show now: until `until`, when the program takes
 * over again by itself (no `until`: until you resume it).
 */
/** A pin is outside the program: `by` who put it up, and `from` Draw when it was sent straight from there. */
export type Live =
  | { mode: "rotate" }
  | { mode: "pin"; source: Source; until?: number | null; by?: string | null; from?: "draw" | null };

export type Showing = {
  source: Source;
  /** null when pinned */
  slideId: string | null;
  /** When to look again: the clip ends or its block ends. null = holds until edited. */
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

// ── The program ────────────────────────────────────────────────────────────

/** Which days a block belongs to: Monday to Friday, or Saturday and Sunday. */
export type Days = "weekdays" | "weekend";

/**
 * A time of day and what plays from then until the next block starts: its clips top to bottom, then from the top
 * again. Like a TV channel's listings, one set for weekdays and one for the weekend.
 */
export type Block = { id: string; days: Days; start: string; slides: Slide[] };

/**
 * The time check: a clock that cuts in at the top of every hour, whatever block is on, like a radio station's
 * time signal. It isn't in any block, and the block carries on underneath as if it hadn't.
 */
export type Hourly = { source: Source; durationS: number };

/** The time check's turn on air. It has no clip or entry of its own. */
export const HOURLY = "hourly";

/** The week: weekday blocks, and weekend ones when the weekend is planned on its own (otherwise it plays the weekdays). */
export type Program = { blocks: Block[]; weekendOwn: boolean; hourly: Hourly | null };

/** A block on a given day, in wall-clock time. */
export type Airing = { block: Block; startedAt: number; endsAt: number };

/** `hhmm` on the day of `day`, as epoch ms (local time, so it follows daylight saving). */
const timeOn = (day: number, hhmm: string) => {
  const d = new Date(day);
  const [h, m] = hhmm.split(":").map(Number);
  return d.setHours(h, m, 0, 0);
};

const dayKind = (day: number): Days => ([0, 6].includes(new Date(day).getDay()) ? "weekend" : "weekdays");

/** The blocks that play on the day of `day`, by start time, as epoch ms. */
function blocksOn(program: Program, day: number) {
  const kind = program.weekendOwn ? dayKind(day) : "weekdays";
  return program.blocks
    .filter((b) => b.days === kind)
    .map((b) => ({ block: b, at: timeOn(day, b.start) }))
    .sort((a, b) => a.at - b.at);
}

/** Midnight `n` days from the day of `now`; setDate keeps it right across daylight saving. */
const dayFrom = (now: number, n: number) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d.getTime();
};

/** The block on air at `now`: the last one to start, today or on an earlier day, until the next one starts. */
export function blockAt(program: Program, now = Date.now()): Airing | null {
  let cur: { block: Block; at: number } | undefined;
  for (let n = 0; n >= -7 && !cur; n--) cur = blocksOn(program, dayFrom(now, n)).filter((b) => b.at <= now).at(-1);
  if (!cur) return null;
  let next: number | undefined;
  for (let n = 0; n <= 7 && next === undefined; n++) next = blocksOn(program, dayFrom(now, n)).find((b) => b.at > now)?.at;
  return { block: cur.block, startedAt: cur.at, endsAt: next ?? cur.at + 7 * 24 * 60 * 60_000 };
}

export function showing(live: Live, program: Program, now = Date.now()): Showing | null {
  if (live.mode === "pin" && (!live.until || now < live.until))
    return { source: live.source, slideId: null, endsAt: live.until ?? null, clip: null };

  const air = blockAt(program, now);
  if (!air) return null;

  // On the hour the time check cuts in. Whatever was on gives way until it's over, and hands back at the next hour.
  const hour = new Date(now).setMinutes(0, 0, 0);
  const checked = program.hourly ? hour + program.hourly.durationS * 1000 : hour;
  if (program.hourly && now < checked) {
    const clip = { startedAt: hour, endsAt: checked };
    return { source: program.hourly.source, slideId: HOURLY, endsAt: checked, clip };
  }
  const nextHour = program.hourly ? hour + 60 * 60_000 : Infinity;
  const around = (startedAt: number, endsAt: number) => ({ startedAt: Math.max(startedAt, checked), endsAt: Math.min(endsAt, nextHour) });

  // `slides` arrive in play order, so keep that order. Skipped clips sit out.
  const eligible = air.block.slides.filter((s) => s.enabled);
  if (!eligible.length) return null;
  // One picture holds for the whole block.
  if (eligible.length === 1) {
    const clip = around(air.startedAt, air.endsAt);
    return { source: eligible[0].source, slideId: eligible[0].id, endsAt: clip.endsAt, clip };
  }

  // The block plays from its first clip at its start time, then starts over when it runs out.
  const cycle = eligible.reduce((sum, s) => sum + s.durationS * 1000, 0);
  let t = (now - air.startedAt) % cycle;
  for (const slide of eligible) {
    const ms = slide.durationS * 1000;
    if (t < ms) {
      const clip = around(now - t, Math.min(now + (ms - t), air.endsAt));
      return { source: slide.source, slideId: slide.id, endsAt: clip.endsAt, clip };
    }
    t -= ms;
  }
  return null; // unreachable
}

/** The next few clip changes. */
export function upcoming(program: Program, now = Date.now(), count = 3): { slideId: string; at: number }[] {
  const out: { slideId: string; at: number }[] = [];
  let current = showing({ mode: "rotate" }, program, now);
  // Step through look-again points; minute ticks inside one clip are skipped.
  for (let guard = 0; current?.endsAt && out.length < count && guard < 500; guard++) {
    const at = current.endsAt;
    const next = showing({ mode: "rotate" }, program, at);
    if (next?.slideId && next.slideId !== current.slideId) out.push({ slideId: next.slideId, at });
    current = next;
  }
  return out;
}

/** One clip's turn on air. */
export type Turn = {
  key: string;
  /** The block it plays in. */
  blockId: string;
  entryId: string | null;
  /** The playlist clip, or null for a single image or app in the show. */
  clipId: string | null;
  playlistId: string | null;
  source: Source;
  at: number;
  endsAt: number;
};

/** The turn on air at `t`, if anything is. */
function turnAt(program: Program, t: number): Turn | null {
  const air = blockAt(program, t);
  const s = showing({ mode: "rotate" }, program, t);
  if (!air || !s?.clip || !s.slideId) return null;
  if (s.slideId === HOURLY)
    return { key: HOURLY, blockId: air.block.id, entryId: null, clipId: null, playlistId: null, source: s.source, at: s.clip.startedAt, endsAt: s.clip.endsAt };
  const slide = air.block.slides.find((x) => x.id === s.slideId);
  if (!slide) return null;
  return {
    key: slide.id,
    blockId: air.block.id,
    entryId: slide.entryId ?? null,
    clipId: slide.clipId ?? (slide.entryId ? null : slide.id),
    playlistId: slide.playlistId,
    source: slide.source,
    at: s.clip.startedAt,
    endsAt: s.clip.endsAt,
  };
}

/**
 * What's ahead: the clip on air, the rest of its block's pass, then one pass of each block after it, for the next
 * day or `max` turns. A block that would start over again before it ends is skipped ahead to the next block.
 */
export function sequence(program: Program, now = Date.now(), max = 60): Turn[] {
  const out: Turn[] = [];
  const horizon = now + 24 * 60 * 60_000;
  let seen = new Set<string>();
  let block: number | null = null;
  // The clip the time check cut into: when it picks up again after, it's the same turn going on, not a repeat.
  let cut: string | null = null;
  for (let t = now, guard = 0; out.length < max && t < horizon && guard < 2000; guard++) {
    const air = blockAt(program, t);
    if (!air) break;
    if (air.startedAt !== block) {
      block = air.startedAt;
      seen = new Set();
    }
    const next = turnAt(program, t);
    const resumed = next?.key === cut;
    if (!next || (seen.has(next.key) && !resumed)) {
      // An empty block, or it has come back around: on to the next block.
      t = air.endsAt;
      continue;
    }
    if (next.key === HOURLY) cut = out.at(-1)?.key ?? null;
    else {
      seen.add(next.key);
      cut = null;
    }
    out.push(next);
    t = next.endsAt;
  }
  return out;
}

/**
 * The turn that handed off to whatever is on air. Null when nothing is on, the same picture
 * is just holding, or a gap means it didn't hand straight over.
 */
export function justAired(program: Program, now = Date.now()): Turn | null {
  const cur = turnAt(program, now);
  if (!cur) return null;
  const prev = turnAt(program, cur.at - 1);
  if (!prev || (prev.key === cur.key && prev.blockId === cur.blockId)) return null;
  return prev;
}
