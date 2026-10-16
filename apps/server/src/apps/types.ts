import type { DitherMode } from "@papershow/scene";
import type { JSX } from "#jsx/jsx-runtime";

/** One setting in an app's form. The Apps page builds its UI from these. */
export type Field =
  | { key: string; label: string; type: "text"; placeholder?: string; hint?: string }
  | { key: string; label: string; type: "textarea"; placeholder?: string; hint?: string }
  | { key: string; label: string; type: "toggle"; hint?: string }
  | { key: string; label: string; type: "select"; options: { value: string; label: string }[]; hint?: string }
  /** Comma-separated in the form, an array in the config. */
  | { key: string; label: string; type: "list"; placeholder?: string; hint?: string }
  /** Tap to pick several of `options`, kept in the order picked; an array in the config. */
  | { key: string; label: string; type: "picks"; options: { value: string; label: string }[]; max?: number; hint?: string };

/** Where an app is listed when you add one. */
export type Category = "clock" | "ai" | "news" | "markets";

export type AppDef<C extends Record<string, unknown>, D> = {
  kind: string;
  name: string;
  category: Category;
  description: string;
  /** Where its data comes from, shown next to the app's type, e.g. "CoinGecko". */
  source: string;
  defaults: C;
  fields: Field[];
  /** The frame can change at most this often; renders are cached per period, aligned to the clock. */
  periodMs: number;
  /** When an instance's settings choose how often it changes; otherwise `periodMs`. */
  periodFor?: (config: C) => number;
  /** When its settings also choose when the periods start: the slot `now` falls in, as epoch ms. Beats `periodFor`. */
  slotFor?: (config: C, now: number) => { start: number; end: number };
  /** How long it stays on when added, if not the usual 15 minutes. A clock only needs a minute. */
  clipS?: number;
  /** True while `data` returns made-up numbers instead of calling a real source. */
  mock: boolean;
  data(config: C, now: Date): D | Promise<D>;
  view(props: { config: C; data: D; now: Date }): JSX.Element;
  /** Vector art thresholds cleanly; photos want dithering. */
  dither?: DitherMode;
};

export const defineApp = <C extends Record<string, unknown>, D>(def: AppDef<C, D>) => def;

/** Every app draws on the panel's 800×480 white sheet in black. */
export const sheet = {
  width: 800,
  height: 480,
  display: "flex",
  background: "#fff",
  color: "#000",
  fontFamily: "Inter",
  // satori defaults to content-box: without this, padding grows the sheet past the panel.
  boxSizing: "border-box",
} as const;

// ── Helpers shared by apps ─────────────────────────────────────────────────

/** Wall-clock parts in a time zone (falls back to the server's if the zone is unknown). */
export function clockParts(now: Date, timeZone: string, hour12 = false) {
  const zone = isZone(timeZone) ? timeZone : undefined;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hour12,
      weekday: "long",
      day: "numeric",
      month: "long",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    hour: parts.hour as string,
    minute: parts.minute as string,
    period: (parts.dayPeriod as string | undefined)?.toUpperCase(),
    date: `${parts.weekday}, ${parts.day} ${parts.month}`,
  };
}

export function isZone(tz: string) {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Smooth, repeatable wobble in [-1, 1] for mock data: the same seed and time
 * always give the same value, so every client sees the same "price".
 */
export function wobble(seed: string, t: number) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) | 0;
  const p = (h % 1000) / 1000;
  return (Math.sin(t / 7 + p * 6.28) * 0.6 + Math.sin(t / 2.3 + p * 12.1) * 0.3 + Math.sin(t / 0.9 + p * 3.7) * 0.1);
}

export const money = (n: number, currency = "USD") =>
  n.toLocaleString("en-US", { style: "currency", currency, maximumFractionDigits: n < 1 ? 4 : 2 });

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", mdash: "—", ndash: "–", hellip: "…",
};

/** Text out of feed or page markup: CDATA unwrapped, tags dropped, entities decoded. */
export const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();

/** Source Serif averages about half an em per character, at both weights. */
const fits = (text: string, size: number, width: number) => text.length * size * 0.5 <= width;

/**
 * Splits text into the lines it takes at `size` px in `width` px, for fitting serif type to a box before
 * satori lays it out. A word wider than the box is broken with a hyphen, so it can't run off the panel.
 */
export function wrap(text: string, size: number, width: number) {
  const pieces = (word: string): string[] => {
    if (fits(word, size, width) || word.length <= 1) return [word];
    const out: string[] = [];
    let rest = word;
    while (rest.length) {
      if (fits(rest, size, width)) {
        out.push(rest);
        break;
      }
      let n = rest.length - 1;
      while (n > 1 && !fits(`${rest.slice(0, n)}-`, size, width)) n--;
      const take = Math.max(n, 1);
      out.push(`${rest.slice(0, take)}-`);
      rest = rest.slice(take);
    }
    return out;
  };
  const out: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    for (const piece of pieces(word)) {
      const line = out.length ? `${out.at(-1)} ${piece}` : piece;
      if (out.length && fits(line, size, width)) out[out.length - 1] = line;
      else out.push(piece);
    }
  }
  return out;
}

/** Lines from `wrap`, joined so a hyphen we inserted stays and satori can break there. */
const joinWrapped = (lines: string[]) =>
  lines.reduce((s, line) => (s ? (s.endsWith("-") ? s + line : `${s} ${line}`) : line), "");

/** As much of `text` as fits in `rows` lines (see `wrap`), cut at a word with "…"; "" when nothing fits. */
export function clip(text: string, rows: number, size: number, width: number) {
  const lines = wrap(text, size, width);
  if (lines.length <= rows) return joinWrapped(lines);
  return rows > 0 ? `${joinWrapped(lines.slice(0, rows)).replace(/[\s,;:.-]+\S*$/, "")}…` : "";
}

/**
 * The largest of `sizes` (biggest first) whose wrapped lines are no taller than `maxH`.
 * At the smallest size, lines that still don't fit are cut, so the block cannot run past the panel.
 */
export function linesInto(text: string, width: number, maxH: number, sizes: number[], lineHeight = 1.1): { size: number; lines: string[] } {
  const rowsAt = (size: number) => Math.max(1, Math.floor(maxH / Math.max(size * lineHeight, 1)));
  for (const size of sizes) {
    const lines = wrap(text, size, width);
    if (lines.length <= rowsAt(size)) return { size, lines };
  }
  const size = sizes.at(-1) ?? 16;
  const rows = rowsAt(size);
  return { size, lines: wrap(clip(text, rows, size, width), size, width).slice(0, rows) };
}
