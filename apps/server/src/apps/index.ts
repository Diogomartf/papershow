import type { AppRow } from "../db.ts";
import { renderFrame, type Frame } from "../render.ts";
import ai from "./ai.tsx";
import aiclock from "./aiclock.tsx";
import clock from "./clock.tsx";
import crypto from "./crypto.tsx";
import nytimes from "./nytimes.tsx";
import stocks from "./stocks.tsx";
import techmeme from "./techmeme.tsx";
import type { AppDef } from "./types.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApp = AppDef<any, any>;

export const APPS: Record<string, AnyApp> = Object.fromEntries(
  [clock, aiclock, ai, crypto, stocks, nytimes, techmeme].map((a) => [a.kind, a as AnyApp]),
);

/** What the Apps page needs to list kinds and build their forms. */
export const catalog = () =>
  Object.values(APPS).map(({ kind, name, description, defaults, fields, mock, periodMs }) => ({
    kind,
    name,
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

async function render(def: AnyApp, config: Record<string, unknown>, at: Date): Promise<Frame> {
  const data = await def.data(config, at);
  return renderFrame(def.view({ config, data, now: at }), def.dither);
}

// One frame per app instance per period. Concurrent requests share the same render.
const cache = new Map<string, { key: string; frame: Promise<Frame> }>();

/** The frame an app shows right now, and when it can next change. */
export async function appFrame(app: AppRow, now = Date.now()): Promise<{ frame: Frame; nextAt: number }> {
  const def = APPS[app.kind];
  if (!def) throw new Error(`unknown app kind: ${app.kind}`);
  const bucket = Math.floor(now / def.periodMs);
  const key = `${bucket}:${app.updatedAt}`;
  let entry = cache.get(app.id);
  if (entry?.key !== key) {
    // Render as of the start of the period, so every request in it agrees.
    entry = { key, frame: render(def, configFor(def, app.config), new Date(bucket * def.periodMs)) };
    cache.set(app.id, entry);
    entry.frame.catch(() => cache.get(app.id) === entry && cache.delete(app.id));
  }
  return { frame: await entry.frame, nextAt: (bucket + 1) * def.periodMs };
}

/** Render unsaved settings, for the Apps page preview. */
export function previewFrame(kind: string, config: Record<string, unknown>) {
  const def = APPS[kind];
  if (!def) throw new Error(`unknown app kind: ${kind}`);
  const bucket = Math.floor(Date.now() / def.periodMs);
  return render(def, configFor(def, config), new Date(bucket * def.periodMs));
}

// Frames for other moments (the dashboard's "up next"), kept apart from the live cache.
const ahead = new Map<string, Promise<Frame>>();

/** How an app will look at time `at`: same period alignment as live, so it matches what will air. */
export function appFrameAt(app: AppRow, at: number): Promise<Frame> {
  const def = APPS[app.kind];
  if (!def) throw new Error(`unknown app kind: ${app.kind}`);
  const bucket = Math.floor(at / def.periodMs);
  const key = `${app.id}:${bucket}:${app.updatedAt}`;
  let frame = ahead.get(key);
  if (!frame) {
    frame = render(def, configFor(def, app.config), new Date(bucket * def.periodMs));
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
