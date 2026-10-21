import * as store from "../db.ts";
import { isOriginal } from "../render.ts";
import { defineApp, random, sheet, type Field } from "./types.ts";

/** How long each photo stays up before the next one. */
const EVERY = { "1m": 60_000, "5m": 5 * 60_000, "15m": 15 * 60_000, "1h": 60 * 60_000, "1d": 24 * 60 * 60_000 } as const;
type Every = keyof typeof EVERY;

/** Every photo in the library, oldest first: the order they were added in. */
const allPhotos = () => store.listImages().filter((i) => i.kind === "photo").reverse();

/** `ids` in an order that's the same for everyone asking in the same round. */
function shuffled(ids: string[], round: number) {
  const rand = random(`${ids.join()}:${round}`);
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The photo for turn `turn`. In order, they go round one after another. Shuffled, every photo comes up once a round,
 * in a new order each round, and a round never starts with the photo the last one ended on.
 */
function pick(ids: string[], turn: number, order: string) {
  const n = ids.length;
  if (order !== "shuffle" || n < 2) return ids[turn % n];
  const round = Math.floor(turn / n);
  const deck = shuffled(ids, round);
  if (round > 0 && deck[0] === shuffled(ids, round - 1)[n - 1]) [deck[0], deck[1]] = [deck[1], deck[0]];
  return deck[turn % n];
}

export default defineApp({
  kind: "photos",
  category: "photos",
  source: "Your photos",
  name: "Photos",
  description: "Your photos, one at a time: in order, or shuffled.",
  defaults: { photos: [] as string[], order: "shuffle", every: "15m" as Every },
  // A getter: the photos to pick from are the library's, which come and go.
  get fields() {
    return [
      {
        key: "photos",
        label: "Photos",
        type: "picks",
        options: allPhotos().map((p) => ({ value: p.id, label: p.name || "Untitled", thumb: `/api/images/${p.id}/png.png?v=${p.updatedAt}` })),
        hint: "Pick the ones to show, in the order to show them. None picked shows every photo, new ones too.",
      },
      {
        key: "order",
        label: "Order",
        type: "select",
        options: [
          { value: "shuffle", label: "Shuffle" },
          { value: "order", label: "In order" },
        ],
        hint: "Shuffle shows each photo once before any comes back, in a new order every time round.",
      },
      {
        key: "every",
        label: "Next photo",
        type: "select",
        options: [
          { value: "1m", label: "Every minute" },
          { value: "5m", label: "5 min" },
          { value: "15m", label: "15 min" },
          { value: "1h", label: "Hourly" },
          { value: "1d", label: "Daily" },
        ],
        hint: "Each change redraws the panel, with a flash: slower is easier on it.",
      },
    ] satisfies Field[];
  },
  periodMs: EVERY["15m"],
  periodFor: (config) => EVERY[config.every] ?? EVERY["15m"],
  mock: false,
  data: (config, now) => {
    // Picks of photos since deleted are already gone from the config, so none left picked means all of them.
    const ids = config.photos.length ? config.photos : allPhotos().map((p) => p.id);
    if (!ids.length) return { src: null };
    const turn = Math.floor(now.getTime() / (EVERY[config.every] ?? EVERY["15m"]));
    const id = pick(ids, turn, config.order);
    // Photos are framed and dithered when they're saved: the frame is the photo's own, as the panel shows it.
    const file = store.getImageFile(id, isOriginal() ? "png" : "mono");
    if (!file) return { src: null };
    const type = file.data[0] === 0xff && file.data[1] === 0xd8 ? "image/jpeg" : "image/png";
    return { src: `data:${type};base64,${Buffer.from(file.data).toString("base64")}` };
  },
  view: ({ data }) =>
    data.src ? (
      <div style={sheet}>
        <img src={data.src} width={800} height={480} />
      </div>
    ) : (
      <div style={{ ...sheet, flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 64 }}>
        <span style={{ fontSize: 56, fontWeight: 700, letterSpacing: -1 }}>No photos yet</span>
        <span style={{ fontSize: 26, marginTop: 18 }}>Add some on the Photos page.</span>
      </div>
    ),
});
