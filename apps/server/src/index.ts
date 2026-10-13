import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import type { Scene } from "@papershow/scene";
import { APPS, appFrame, appFrameAt, catalog, configFor, forgetApp, previewFrame } from "./apps/index.ts";
import { watchModels } from "./ai.ts";
import * as store from "./db.ts";
import { sequence, showing, sleepUntil, upcoming, type Live, type Showing, type Source } from "./schedule.ts";
import { sleepFrame } from "./sleep.tsx";

// Secrets such as GROQ_API_KEY and MASSIVE_API_KEY live in .env at the repo root (not committed).
try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url).pathname);
} catch {
  /* no .env: the AI apps fall back to stand-in text */
}
watchModels();

const app = new Hono();

// ── Live state ─────────────────────────────────────────────────────────────
// Anything that edits images, slides or the pin calls changed(); /live waiters wake up.

const events = new EventEmitter();
events.setMaxListeners(0);
const changed = () => events.emit("change");

/** How long Show now holds /live when it isn't given a turn's length. */
const SHOW_NOW_S = 15 * 60;

type FileKind = "png" | "mono" | "bin";
type SourceFrame = { etag: string; nextAt: number | null; file: (kind: FileKind) => Uint8Array<ArrayBuffer> };

const exists = (src: Source) => (src.kind === "image" ? !!store.getImageMeta(src.id) : !!store.getApp(src.id));

/** A source's current frame: a stored drawing, or an app rendered for this period. */
async function sourceFrame(src: Source, now: number): Promise<SourceFrame | null> {
  if (src.kind === "image") {
    const meta = store.getImageMeta(src.id);
    if (!meta) return null;
    return { etag: `"img-${meta.id}-${meta.updatedAt}"`, nextAt: null, file: (k) => store.getImageFile(meta.id, k)!.data };
  }
  const row = store.getApp(src.id);
  if (!row || !APPS[row.kind]) return null;
  const { frame, nextAt } = await appFrame(row, now);
  // The tag follows the pixels: an app that re-renders the same picture doesn't wake the panel.
  return { etag: `"app-${row.id}-${frame.hash}"`, nextAt, file: (k) => frame[k] };
}

/** What /live is doing right now. While asleep there's no source, and `file` is null if the panel keeps its last picture. */
type LiveNow = Omit<Showing, "source"> & {
  source: Source | null;
  etag: string;
  file: SourceFrame["file"] | null;
  /** When the panel wakes, while it's asleep. */
  asleep: number | null;
};

async function liveNow(now = Date.now()): Promise<LiveNow | null> {
  // Night beats everything: the playlist and any pin wait until morning.
  const sleep = store.getSleep();
  const until = sleepUntil(sleep, now);
  if (until) {
    const frame = await sleepFrame(sleep, until);
    return {
      source: null,
      slideId: null,
      clip: null,
      endsAt: until,
      asleep: until,
      etag: `"sleep-${sleep.screen}-${until}"`,
      file: frame ? (k) => frame[k] : null,
    };
  }

  const s = showing(store.getLive(), store.loopSlides(), now, store.repeats());
  if (!s) return null;
  const f = await sourceFrame(s.source, now).catch((err) => {
    console.error("render failed", s.source, err);
    return null;
  });
  if (!f) return null;
  const ends = [s.endsAt, f.nextAt].filter((t): t is number => t !== null);
  // Show now is a new frame even when it's the picture already up: the panel should redraw it, cleanly.
  const pin = store.getLive();
  const etag = pin.mode === "pin" && !s.slideId ? `${f.etag.slice(0, -1)}-now${pin.until ?? 0}"` : f.etag;
  return { ...s, endsAt: ends.length ? Math.min(...ends) : null, etag, file: f.file, asleep: null };
}

/** Resolve on the next edit, when the current clip runs out, or after `maxMs`. */
function nextChange(current: LiveNow | null, maxMs: number) {
  return new Promise<void>((resolve) => {
    const wait = current?.endsAt ? Math.min(maxMs, Math.max(0, current.endsAt - Date.now())) : maxMs;
    const done = () => {
      clearTimeout(timer);
      events.off("change", done);
      resolve();
    };
    const timer = setTimeout(done, wait);
    events.on("change", done);
  });
}

// ── /live: what the panel shows ────────────────────────────────────────────
// GET /live          1-bit PNG
// GET /live.bin      800×480 1bpp, MSB first, 1 = white (48,000 bytes)
// ?wait=1 with If-None-Match: hold up to 55s until the frame changes (long-poll).
// X-Next-Change: seconds until the frame changes by itself, if it will.
// X-Sleep-Until: while asleep, when the panel wakes (ms since epoch). 204 = keep the last picture.
// X-Source-Name: the drawing's or app's name, URI-encoded (names aren't always ASCII), for logs.
// X-Show-Now: while Show now holds /live, when it ends (ms since epoch): a new value is a fresh Show now.

/** The last time a display (anything but this web app's previews) asked for /live. */
let lastSeen: { at: number; agent: string } | null = null;

async function live(c: Context, kind: "mono" | "bin") {
  if (!c.req.query("e")) lastSeen = { at: Date.now(), agent: c.req.header("user-agent") ?? "" };
  let now = await liveNow();
  const etag = c.req.header("if-none-match");
  if (c.req.query("wait") && etag && now?.etag === etag) {
    await nextChange(now, 55_000);
    now = await liveNow();
  }
  if (!now) return c.body(null, 204);

  c.header("ETag", now.etag);
  c.header("Cache-Control", "no-cache");
  if (now.source) {
    c.header("X-Source", `${now.source.kind}:${now.source.id}`);
    const name = now.source.kind === "image" ? store.getImageMeta(now.source.id)?.name : store.getApp(now.source.id)?.name;
    if (name) c.header("X-Source-Name", encodeURIComponent(name));
  }
  if (now.asleep) c.header("X-Sleep-Until", String(now.asleep));
  if (now.endsAt) c.header("X-Next-Change", String(Math.ceil((now.endsAt - Date.now()) / 1000)));
  // Someone just asked for this picture: the panel flashes clean before drawing it.
  const pin = store.getLive();
  if (pin.mode === "pin" && !now.asleep) c.header("X-Show-Now", String(pin.until ?? 0));
  if (etag === now.etag) return c.body(null, 304);
  if (!now.file) return c.body(null, 204);

  c.header("Content-Type", kind === "bin" ? "application/octet-stream" : "image/png");
  return c.body(now.file(kind));
}

app.get("/live", (c) => live(c, "mono"));
app.get("/live.png", (c) => live(c, "mono"));
app.get("/live.bin", (c) => live(c, "bin"));

// ── Images ─────────────────────────────────────────────────────────────────

app.get("/api/images", (c) => c.json(store.listImages()));

app.get("/api/images/:id", (c) => {
  const meta = store.getImageMeta(c.req.param("id"));
  return meta ? c.json({ ...meta, scene: store.getScene(meta.id) }) : c.notFound();
});

const KINDS = { png: "image/png", mono: "image/png", bin: "application/octet-stream" } as const;

app.get("/api/images/:id/:kind", (c) => {
  const kind = c.req.param("kind").replace(/\.png$/, "") as store.ImageKind;
  if (!(kind in KINDS)) return c.notFound();
  const file = store.getImageFile(c.req.param("id"), kind);
  if (!file) return c.notFound();
  const etag = `"${file.updatedAt}"`;
  c.header("ETag", etag);
  c.header("Cache-Control", "no-cache");
  if (c.req.header("if-none-match") === etag) return c.body(null, 304);
  c.header("Content-Type", KINDS[kind]);
  return c.body(file.data);
});

app.put("/api/images/:id", async (c) => {
  const form = await c.req.formData();
  const scene = JSON.parse(String(form.get("scene"))) as Scene;
  if (scene.id !== c.req.param("id")) return c.json({ error: "id mismatch" }, 400);
  const bytes = async (k: string) => new Uint8Array(await (form.get(k) as File).arrayBuffer());
  store.putImage(scene, { png: await bytes("png"), mono: await bytes("mono"), bin: await bytes("bin") });
  changed();
  return c.json(store.getImageMeta(scene.id));
});

app.delete("/api/images/:id", (c) => {
  store.deleteImage(c.req.param("id"));
  changed();
  return c.body(null, 204);
});

// ── Apps ───────────────────────────────────────────────────────────────────

/** "Crypto", then "Crypto 2", "Crypto 3"… so apps of one kind can be told apart. */
function uniqueName(base: string) {
  const taken = new Set(store.listApps().map((a) => a.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

app.get("/api/apps/catalog", (c) => c.json(catalog()));
app.get("/api/apps", (c) => c.json(store.listApps()));

app.post("/api/apps", async (c) => {
  const { kind, name, config } = await c.req.json<{ kind: string; name?: string; config?: Record<string, unknown> }>();
  const def = APPS[kind];
  if (!def) return c.json({ error: "no such app" }, 404);
  const row = store.createApp(kind, uniqueName(name?.trim() || def.name), configFor(def, config));
  changed();
  return c.json(row);
});

app.get("/api/apps/:id", (c) => {
  const row = store.getApp(c.req.param("id"));
  return row ? c.json(row) : c.notFound();
});

app.patch("/api/apps/:id", async (c) => {
  const row = store.getApp(c.req.param("id"));
  if (!row) return c.notFound();
  const patch = await c.req.json<{ name?: string; config?: Record<string, unknown> }>();
  store.updateApp(row.id, {
    name: patch.name?.trim() || undefined,
    config: patch.config && configFor(APPS[row.kind], patch.config),
  });
  forgetApp(row.id);
  changed();
  return c.json(store.getApp(row.id));
});

app.delete("/api/apps/:id", (c) => {
  store.deleteApp(c.req.param("id"));
  forgetApp(c.req.param("id"));
  changed();
  return c.body(null, 204);
});

/** The app's frame right now: png (as rendered), mono (1-bit) or bin. */
app.get("/api/apps/:id/:kind", async (c) => {
  const kind = c.req.param("kind").replace(/\.png$/, "") as FileKind;
  if (!["png", "mono", "bin"].includes(kind)) return c.notFound();
  const row = store.getApp(c.req.param("id"));
  if (!row) return c.notFound();
  const { frame } = await appFrame(row);
  const etag = `"${frame.hash}"`;
  c.header("ETag", etag);
  c.header("Cache-Control", "no-cache");
  if (c.req.header("if-none-match") === etag) return c.body(null, 304);
  c.header("Content-Type", kind === "bin" ? "application/octet-stream" : "image/png");
  return c.body(frame[kind]);
});

/** Render settings that aren't saved yet, so the form previews as you type. */
app.post("/api/apps/preview", async (c) => {
  const { kind, config, original } = await c.req.json<{ kind: string; config: Record<string, unknown>; original?: boolean }>();
  if (!APPS[kind]) return c.json({ error: "no such app" }, 404);
  const frame = await previewFrame(kind, config ?? {}, { original: !!original });
  c.header("Content-Type", "image/png");
  c.header("Cache-Control", "no-store");
  // Original: the full-resolution render in colour, before it's reduced to the panel's 1 bit.
  return c.body(original ? frame.png : frame.mono);
});

/** Any image or app as it will look at `at` (ms), for the dashboard's sequence. 1-bit PNG. */
app.get("/api/frame/:kind/:id", async (c) => {
  const kind = c.req.param("kind");
  const id = c.req.param("id").replace(/\.png$/, "");
  const at = Number(c.req.query("at")) || Date.now();
  let png: Uint8Array<ArrayBuffer> | undefined;
  if (kind === "image") png = store.getImageFile(id, "mono")?.data;
  else if (kind === "app") {
    const row = store.getApp(id);
    if (row && APPS[row.kind]) png = (await appFrameAt(row, at)).mono;
  }
  if (!png) return c.notFound();
  c.header("Content-Type", "image/png");
  c.header("Cache-Control", "private, max-age=60");
  return c.body(png);
});

/** How long a new clip stays on: 15 minutes, or what the app asks for (a clock only needs a minute). */
function clipLength(source: Source) {
  const row = source.kind === "app" ? store.getApp(source.id) : undefined;
  return (row && APPS[row.kind]?.clipS) || 15 * 60;
}

// ── Playlists + what's live ────────────────────────────────────────────────

async function state() {
  const now = Date.now();
  const slides = store.listSlides();
  const loop = store.loopSlides();
  const repeats = store.repeats();
  const live = await liveNow(now);
  const onAir = loop.find((x) => x.id === live?.slideId);
  // A repeat's clip airs as "<entry>" (single) or "<entry>~<clip>" (a playlist's).
  const repeat = repeats.find((r) => live?.slideId === r.id || live?.slideId?.startsWith(`${r.id}~`));
  return {
    now,
    live: store.getLive(),
    showing: live && {
      source: live.source,
      slideId: live.slideId,
      entryId: onAir?.entryId ?? repeat?.id ?? null,
      clipId: onAir?.clipId ?? (repeat && live?.slideId?.includes("~") ? live.slideId.split("~")[1] : null),
      endsAt: live.endsAt,
      clip: live.clip,
      etag: live.etag,
      asleep: live.asleep,
      blank: !live.file,
    },
    sleep: store.getSleep(),
    slides,
    playlists: store.listPlaylists(),
    show: store.listShow(),
    upcoming: upcoming(loop, now, 3, repeats),
    sequence: sequence(loop, now, 60, repeats),
    display: lastSeen,
  };
}

app.get("/api/state", async (c) => c.json(await state()));

/** Long-poll for the admin: returns when anything changes or the frame turns over. */
app.get("/api/state/wait", async (c) => {
  await nextChange(await liveNow(), 25_000);
  return c.json(await state());
});

app.post("/api/slides", async (c) => {
  const body = await c.req.json<{ source?: Source; imageId?: string; playlistId?: string; at?: number }>();
  const source: Source | undefined = body.source ?? (body.imageId ? { kind: "image", id: body.imageId } : undefined);
  if (!source || !exists(source)) return c.json({ error: "no such image or app" }, 404);
  const playlist = (body.playlistId && store.getPlaylist(body.playlistId)) || store.listPlaylists()[0];
  store.addSlide(source, playlist.id, body.at, clipLength(source));
  changed();
  return c.json(await state());
});

app.patch("/api/slides/:id", async (c) => {
  store.updateSlide(c.req.param("id"), await c.req.json());
  changed();
  return c.json(await state());
});

app.put("/api/slides/order", async (c) => {
  store.reorderSlides((await c.req.json<{ ids: string[] }>()).ids);
  changed();
  return c.json(await state());
});

app.delete("/api/slides/:id", async (c) => {
  store.deleteSlide(c.req.param("id"));
  changed();
  return c.json(await state());
});

app.post("/api/playlists", async (c) => {
  const { name, show = true } = await c.req.json<{ name?: string; show?: boolean }>();
  const p = store.createPlaylist(name?.trim() || `Playlist ${store.listPlaylists().length + 1}`);
  // A new playlist joins the end of the show unless asked not to.
  if (show) store.addShowEntry({ playlistId: p.id });
  changed();
  return c.json({ ...(await state()), created: p.id });
});

app.patch("/api/playlists/:id", async (c) => {
  store.updatePlaylist(c.req.param("id"), await c.req.json());
  changed();
  return c.json(await state());
});

app.put("/api/playlists/order", async (c) => {
  store.reorderPlaylists((await c.req.json<{ ids: string[] }>()).ids);
  changed();
  return c.json(await state());
});

app.delete("/api/playlists/:id", async (c) => {
  store.deletePlaylist(c.req.param("id"));
  changed();
  return c.json(await state());
});

// ── The show: playlists, images and apps, in the order they run ───────────

app.post("/api/show", async (c) => {
  const body = await c.req.json<{ playlistId?: string; source?: Source; at?: number }>();
  if (body.playlistId) {
    if (!store.getPlaylist(body.playlistId)) return c.json({ error: "no such playlist" }, 404);
    store.addShowEntry({ playlistId: body.playlistId }, body.at);
  } else if (body.source && exists(body.source)) {
    store.addShowEntry({ source: body.source }, body.at, clipLength(body.source));
  } else return c.json({ error: "add a playlist, image or app" }, 400);
  changed();
  return c.json(await state());
});

app.patch("/api/show/:id", async (c) => {
  store.updateShowEntry(c.req.param("id"), await c.req.json());
  changed();
  return c.json(await state());
});

app.put("/api/show/order", async (c) => {
  store.reorderShow((await c.req.json<{ ids: string[] }>()).ids);
  changed();
  return c.json(await state());
});

app.delete("/api/show/:id", async (c) => {
  store.deleteShowEntry(c.req.param("id"));
  changed();
  return c.json(await state());
});

app.put("/api/sleep", async (c) => {
  store.setSleep(await c.req.json());
  changed();
  return c.json(await state());
});

app.put("/api/live", async (c) => {
  const live = await c.req.json<Live & { forS?: number }>();
  if (live.mode === "pin") {
    if (!live.source || !exists(live.source)) return c.json({ error: "no such image or app" }, 404);
    // Show now takes over once, for its turn (`forS`, else 15 minutes), then the playlists carry on.
    const forS = Number(live.forS) > 0 ? Number(live.forS) : SHOW_NOW_S;
    store.setLive({ mode: "pin", source: { kind: live.source.kind, id: live.source.id }, until: Date.now() + forS * 1000 });
    // The panel wakes on its own at the end; open pages hear it then.
    setTimeout(changed, forS * 1000 + 50).unref();
  } else {
    store.setLive({ mode: "rotate" });
  }
  changed();
  return c.json(await state());
});

// ── The web app, in production (one service on the Pi) ─────────────────────

if (process.env.NODE_ENV === "production") {
  const root = new URL("../../web/dist/", import.meta.url).pathname;
  app.use("/*", serveStatic({ root }));
  const index = await readFile(root + "index.html", "utf8");
  app.get("*", (c) => c.html(index));
}

const port = Number(process.env.PORT ?? 5194);
serve({ fetch: app.fetch, port }, () => console.log(`server on http://localhost:${port}`));

// On the Pi, also on port 80, so http://paper.local needs no port. Optional: if it's taken, the
// main port still serves everything.
if (process.env.WEB_PORT) {
  const webPort = Number(process.env.WEB_PORT);
  serve({ fetch: app.fetch, port: webPort }, () => console.log(`also on port ${webPort}`)).on("error", (err) =>
    console.error(`port ${webPort}: ${err.message}; serving on ${port} only`),
  );
}
