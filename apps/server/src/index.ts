import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import type { Scene } from "@papershow/scene";
import * as store from "./db.ts";
import { showing, upcoming, type Live, type Showing } from "./schedule.ts";

const app = new Hono();

// ── Live state ─────────────────────────────────────────────────────────────
// Anything that edits images, slides or the pin calls changed(); /live waiters wake up.

const events = new EventEmitter();
events.setMaxListeners(0);
const changed = () => events.emit("change");

type LiveNow = Showing & { etag: string; updatedAt: number };

function liveNow(now = Date.now()): LiveNow | null {
  const s = showing(store.getLive(), store.listSlides(), now);
  const meta = s && store.getImageMeta(s.imageId);
  if (!s || !meta) return null;
  return { ...s, updatedAt: meta.updatedAt, etag: `"${meta.id}-${meta.updatedAt}"` };
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

async function live(c: Context, kind: "mono" | "bin") {
  let now = liveNow();
  const etag = c.req.header("if-none-match");
  if (c.req.query("wait") && etag && now?.etag === etag) {
    await nextChange(now, 55_000);
    now = liveNow();
  }
  if (!now) return c.body(null, 204);

  c.header("ETag", now.etag);
  c.header("Cache-Control", "no-cache");
  c.header("X-Image", now.imageId);
  if (now.endsAt) c.header("X-Next-Change", String(Math.ceil((now.endsAt - Date.now()) / 1000)));
  if (etag === now.etag) return c.body(null, 304);

  const file = store.getImageFile(now.imageId, kind)!;
  c.header("Content-Type", kind === "bin" ? "application/octet-stream" : "image/png");
  return c.body(file.data);
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

// ── Sequence + what's live ─────────────────────────────────────────────────

function state() {
  const now = Date.now();
  const slides = store.listSlides();
  return {
    now,
    live: store.getLive(),
    showing: liveNow(now),
    slides,
    upcoming: upcoming(slides, now),
  };
}

app.get("/api/state", (c) => c.json(state()));

/** Long-poll for the admin: returns when anything changes or the clip turns over. */
app.get("/api/state/wait", async (c) => {
  await nextChange(liveNow(), 25_000);
  return c.json(state());
});

app.post("/api/slides", async (c) => {
  const { imageId, at } = await c.req.json<{ imageId: string; at?: number }>();
  if (!store.getImageMeta(imageId)) return c.json({ error: "no such image" }, 404);
  store.addSlide(imageId, at);
  changed();
  return c.json(state());
});

app.patch("/api/slides/:id", async (c) => {
  store.updateSlide(c.req.param("id"), await c.req.json());
  changed();
  return c.json(state());
});

app.put("/api/slides/order", async (c) => {
  store.reorderSlides((await c.req.json<{ ids: string[] }>()).ids);
  changed();
  return c.json(state());
});

app.delete("/api/slides/:id", (c) => {
  store.deleteSlide(c.req.param("id"));
  changed();
  return c.json(state());
});

app.put("/api/live", async (c) => {
  const live = await c.req.json<Live>();
  if (live.mode === "pin" && !store.getImageMeta(live.imageId)) return c.json({ error: "no such image" }, 404);
  store.setLive(live.mode === "pin" ? { mode: "pin", imageId: live.imageId } : { mode: "rotate" });
  changed();
  return c.json(state());
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
