import type { AppRow } from "../db.ts";
import { renderFrame, renderingOriginal, type Frame } from "../render.ts";
import ai, { funFact, haiku, quoteOfTheDay, wordOfTheDay } from "./ai.tsx";
import aiclock from "./aiclock.tsx";
import clock from "./clock.tsx";
import crypto from "./crypto.tsx";
import { nytimes, wsj } from "./news.tsx";
import photos from "./photos.tsx";
import stocks from "./stocks.tsx";
import techmeme from "./techmeme.tsx";
import webnews from "./webnews.tsx";
import type { AppDef } from "./types.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApp = AppDef<any, any>;

export const APPS: Record<string, AnyApp> = Object.fromEntries(
  [clock, aiclock, wordOfTheDay, funFact, haiku, quoteOfTheDay, ai, nytimes, wsj, techmeme, webnews, crypto, stocks, photos].map((a) => [a.kind, a as AnyApp]),
);

/** What the Apps page needs to list kinds and build their forms. */
export const catalog = () =>
  Object.values(APPS).map(({ kind, name, category, description, source, defaults, fields, mock, periodMs }) => ({
    kind,
    name,
    category,
    source,
    description,
    defaults,
    fields,
    mock,
    periodMs,
  }));

/** Stored config over the app's defaults, keeping only keys the app knows, with the right types. */
export function configFor(def: AnyApp, raw: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = { ...def.defaults };
  for (const f of def.fields) {
    const v = raw[f.key];
    if (v === undefined) continue;
    if (f.type === "toggle") out[f.key] = !!v;
    else if (f.type === "list")
      out[f.key] = (Array.isArray(v) ? v : String(v).split(","))
        .map((x) => String(x).trim().toLowerCase())
        .filter(Boolean);
    else if (f.type === "picks")
      out[f.key] = [...new Set(Array.isArray(v) ? v.map(String) : [])]
        .filter((x) => f.options.some((o) => o.value === x))
        .slice(0, f.max);
    else if (f.type === "select") out[f.key] = f.options.some((o) => o.value === v) ? v : def.defaults[f.key];
    else out[f.key] = String(v).trim();
  }
  return out;
}

async function render(def: AnyApp, config: Record<string, unknown>, at: Date, pngScale = 1): Promise<Frame> {
  const data = await def.data(config, at);
  return renderFrame(def.view({ config, data, now: at }), def.dither, { pngScale });
}

/**
 * The stretch of time `now` falls in, during which an instance shows one frame: its own schedule when it has one
 * (`slotFor`), else even periods from the epoch, so they land on the clock.
 */
function slotOf(def: AnyApp, config: Record<string, unknown>, now: number): { start: number; end: number } {
  if (def.slotFor) return def.slotFor(config, now);
  const period = def.periodFor?.(config) ?? def.periodMs;
  const start = Math.floor(now / period) * period;
  return { start, end: start + period };
}

// One frame per app instance per period. Concurrent requests share the same render.
const cache = new Map<string, { key: string; frame: Promise<Frame> }>();

/** The frame an app shows right now, and when it can next change. */
export async function appFrame(app: AppRow, now = Date.now()): Promise<{ frame: Frame; nextAt: number }> {
  const def = APPS[app.kind];
  if (!def) throw new Error(`unknown app kind: ${app.kind}`);
  const config = configFor(def, app.config);
  const slot = slotOf(def, config, now);
  const key = `${slot.start}:${slot.end}:${app.updatedAt}`;
  let entry = cache.get(app.id);
  if (entry?.key !== key) {
    // Render as of the start of the period, so every request in it agrees.
    entry = { key, frame: render(def, config, new Date(slot.start)) };
    cache.set(app.id, entry);
    entry.frame.catch(() => cache.get(app.id) === entry && cache.delete(app.id));
  }
  return { frame: await entry.frame, nextAt: slot.end };
}

/** Render unsaved settings, for the Apps page preview. `original`: pictures in full colour, for the full-resolution view. */
export function previewFrame(kind: string, raw: Record<string, unknown>, { original = false } = {}) {
  const def = APPS[kind];
  if (!def) throw new Error(`unknown app kind: ${kind}`);
  const config = configFor(def, raw);
  const at = new Date(slotOf(def, config, Date.now()).start);
  return original ? renderingOriginal(() => render(def, config, at, 2)) : render(def, config, at);
}

// Frames for other moments (the dashboard's "up next"), kept apart from the live cache.
const ahead = new Map<string, Promise<Frame>>();

/** How an app will look at time `at`: same period alignment as live, so it matches what will air. */
export function appFrameAt(app: AppRow, at: number): Promise<Frame> {
  const def = APPS[app.kind];
  if (!def) throw new Error(`unknown app kind: ${app.kind}`);
  const config = configFor(def, app.config);
  const slot = slotOf(def, config, at);
  const key = `${app.id}:${slot.start}:${slot.end}:${app.updatedAt}`;
  let frame = ahead.get(key);
  if (!frame) {
    frame = render(def, config, new Date(slot.start));
    ahead.set(key, frame);
    frame.catch(() => ahead.delete(key));
    if (ahead.size > 64) ahead.delete(ahead.keys().next().value!);
  }
  return frame;
}

export function forgetApp(id: string) {
  cache.delete(id);
  for (const key of ahead.keys()) if (key.startsWith(`${id}:`)) ahead.delete(key);
}
