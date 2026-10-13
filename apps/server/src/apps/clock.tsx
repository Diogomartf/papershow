import * as store from "../db.ts";
import { doodleImage } from "../render.ts";
import { clockParts, defineApp, sheet, type Field } from "./types.ts";

// XL runs the time edge to edge; Large fills the panel with room around it; the others leave more.
const SCALE = { small: 0.55, medium: 0.78, large: 1, xl: 1.32 } as const;

/** How often the doodles move: a new arrangement each minute, hour or day. */
const SHUFFLE = { minute: 60_000, hour: 60 * 60_000, day: 24 * 60 * 60_000 } as const;

type Box = { x: number; y: number; w: number; h: number };
type Doodle = { src: string; width: number; height: number; x: number; y: number; turn: number };

/** A repeatable random sequence from a string: the same minute gives the same doodles to everyone asking. */
function random(seed: string) {
  let a = 0;
  for (const c of seed) a = (Math.imul(a ^ c.charCodeAt(0), 2654435761) + 1) | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The free space around the time: the corners above and below it, and the sides. Sized from the time's rough
 * extent (Inter Light digits run about 0.6 em), so XL, which spans the panel, leaves only thin bands.
 */
function freeSpace(k: number, hour12: boolean, showDate: boolean): Box[] {
  const M = 14;
  const w = (2.7 * 236 - 40) * k + (hour12 ? 75 * k : 0);
  const h = 236 * k + (showDate ? 72 * k : 0);
  // A clear ring round the time and date, so a tilted doodle doesn't touch them.
  const band = (480 - h) / 2 - M - 12;
  const col = (800 - w) / 2 - M - 12;
  const half = 400 - 1.5 * M;
  return [
    { x: M, y: M, w: half, h: band },
    { x: 400 + M / 2, y: M, w: half, h: band },
    { x: M, y: 480 - M - band, w: half, h: band },
    { x: 400 + M / 2, y: 480 - M - band, w: half, h: band },
    { x: M, y: 240 - Math.min(h, 260) / 2, w: col, h: Math.min(h, 260) },
    { x: 800 - M - col, y: 240 - Math.min(h, 260) / 2, w: col, h: Math.min(h, 260) },
  ].filter((b) => b.w >= 56 && b.h >= 56);
}

// Shrunk drawings by id, version and size: sizes come in 8 px steps, so they repeat.
const shrunk = new Map<string, ReturnType<typeof doodleImage>>();

function shrink(id: string, w: number, h: number) {
  const meta = store.getImageMeta(id);
  const file = meta && store.getImageFile(id, "png");
  if (!file) return null;
  const key = `${id}:${meta.updatedAt}:${w}x${h}`;
  if (!shrunk.has(key)) {
    shrunk.set(key, doodleImage(file.data, w, h));
    if (shrunk.size > 300) shrunk.delete(shrunk.keys().next().value!);
  }
  return shrunk.get(key)!;
}

/**
 * A few of the picked drawings, chosen at random, scattered over the free space: each in its own spot, a little
 * tilted. A new draw each `shuffle`; with fewer picked than spots, some come up twice.
 */
function scatter(ids: string[], count: number, spaces: Box[], seed: string): Doodle[] {
  if (!ids.length) return [];
  const rand = random(seed);
  const spots = [...spaces].sort(() => rand() - 0.5).slice(0, count);
  const order = [...ids].sort(() => rand() - 0.5);
  return spots.flatMap((spot, i) => {
    // Most of the spot, so neighbours don't touch, in 8 px steps.
    const fill = 0.7 + rand() * 0.3;
    const img = shrink(order[i % order.length], Math.floor((spot.w * fill) / 8) * 8, Math.floor((spot.h * fill) / 8) * 8);
    if (!img) return [];
    return [
      {
        ...img,
        x: Math.round(spot.x + rand() * (spot.w - img.width)),
        y: Math.round(spot.y + rand() * (spot.h - img.height)),
        turn: Math.round((rand() - 0.5) * 16),
      },
    ];
  });
}

export default defineApp({
  kind: "clock",
  category: "clock",
  source: "This device’s clock",
  name: "Clock",
  description: "The time, large enough to read across the room, with your doodles around it if you like.",
  defaults: {
    timeZone: "Europe/Lisbon",
    hour12: false,
    showDate: true,
    size: "large" as keyof typeof SCALE,
    doodles: [] as string[],
    count: "4",
    shuffle: "hour" as keyof typeof SHUFFLE,
  },
  // A getter: the doodles to pick from are your drawings, which come and go.
  get fields() {
    return [
      { key: "timeZone", label: "Time zone", type: "text", placeholder: "Europe/Lisbon", hint: "Any IANA zone" },
      { key: "hour12", label: "12-hour", type: "toggle" },
      { key: "showDate", label: "Show date", type: "toggle" },
      {
        key: "size",
        label: "Size",
        type: "select",
        options: [
          { value: "small", label: "Small" },
          { value: "medium", label: "Medium" },
          { value: "large", label: "Large" },
          { value: "xl", label: "XL" },
        ],
      },
      {
        key: "doodles",
        label: "Doodles",
        type: "picks",
        options: store.listImages().map((i) => ({ value: i.id, label: i.name || "Untitled" })),
        hint: "Pick as many as you like: each shuffle shows a few of them at random. Medium leaves the most room; XL none.",
      },
      {
        key: "count",
        label: "How many at a time",
        type: "select",
        options: ["1", "2", "3", "4", "5", "6"].map((n) => ({ value: n, label: n })),
      },
      {
        key: "shuffle",
        label: "Shuffle",
        type: "select",
        options: [
          { value: "minute", label: "Every minute" },
          { value: "hour", label: "Every hour" },
          { value: "day", label: "Every day" },
        ],
        hint: "How often the doodles move around",
      },
    ] satisfies Field[];
  },
  periodMs: 60_000,
  clipS: 60,
  mock: false,
  data: (config, now) => {
    const k = SCALE[config.size] ?? 1;
    const every = SHUFFLE[config.shuffle] ?? SHUFFLE.hour;
    const seed = `${config.doodles.join()}:${Math.floor(now.getTime() / every)}`;
    return { doodles: scatter(config.doodles, Number(config.count) || 4, freeSpace(k, config.hour12, config.showDate), seed) };
  },
  view: ({ config, data, now }) => {
    const t = clockParts(now, config.timeZone, config.hour12);
    // XL's widest times (20:08, or 10:08 PM) just fit the width; 12-hour gives up a little to make room for AM/PM.
    const k = (SCALE[config.size] ?? 1) * (config.size === "xl" && config.hour12 ? 0.93 : 1);
    return (
      <div style={{ ...sheet, position: "relative", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        {data.doodles.map((d, i) => (
          <img
            key={i}
            src={d.src}
            width={d.width}
            height={d.height}
            style={{ position: "absolute", left: d.x, top: d.y, transform: `rotate(${d.turn}deg)` }}
          />
        ))}
        <div style={{ display: "flex", alignItems: "flex-start" }}>
          <span style={{ fontSize: 236 * k, fontWeight: 300, letterSpacing: -10 * k, lineHeight: 1 }}>
            {`${config.hour12 ? String(Number(t.hour)) : t.hour}:${t.minute}`}
          </span>
          {config.hour12 && t.period ? (
            <span style={{ fontSize: 40 * k, fontWeight: 500, marginTop: 30 * k, marginLeft: 14 * k }}>{t.period}</span>
          ) : null}
        </div>
        {config.showDate ? <div style={{ fontSize: 38 * k, fontWeight: 500, marginTop: 26 * k }}>{t.date}</div> : null}
      </div>
    );
  },
});
