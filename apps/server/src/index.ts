import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Scene } from "@papershow/scene";
import { APPS, appFrame, appFrameAt, catalog, configFor, forgetApp, previewFrame } from "./apps/index.ts";
import { watchModels } from "./ai.ts";
import * as store from "./db.ts";
import { inviteFrame, qrSvg } from "./invite.tsx";
import * as people from "./people.ts";
import { awayUntil, blockAt, justAired, sequence, showing, sleepUntil, upcoming, type Days, type Live, type Showing, type Source } from "./schedule.ts";
import { sleepFrame } from "./sleep.tsx";

// Secrets such as GROQ_API_KEY and MASSIVE_API_KEY live in .env at the repo root (not committed).
try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url).pathname);
} catch {
  /* no .env: the AI apps fall back to stand-in text */
}
watchModels();

type Env = { Variables: { me: people.Person } };
const app = new Hono<Env>();
type C = Context<Env>;

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
  /** When the panel wakes, while it's asleep or away: 0 when away until switched back. */
  asleep: number | null;
  /** Away for days, not just asleep for the night. */
  away: boolean;
  /** The invite code, while an invite is on the panel. */
  invite: string | null;
  /** While a Show now or an invite holds /live: when it ends. A new value tells the panel to flash clean first. */
  showNow: number | null;
};

async function liveNow(now = Date.now()): Promise<LiveNow | null> {
  // Away beats everything: the panel stays blank (white is how e-ink keeps best) until it's back.
  const sleep = store.getSleep();
  const back = awayUntil(sleep, now);
  if (back !== null) {
    const frame = await sleepFrame({ ...sleep, screen: "blank" }, back);
    return {
      source: null,
      slideId: null,
      clip: null,
      endsAt: back || null,
      asleep: back,
      away: true,
      invite: null,
      showNow: null,
      // One tag for every date: changing when you're back must not redraw the same white panel.
      etag: `"away"`,
      file: frame ? (k) => frame[k] : null,
    };
  }

  // An invite someone put on the panel, until it's used or runs out. It beats the night: someone's
  // standing there with their phone.
  const invite = people.panelInvite(now);
  if (invite) {
    const frame = await inviteFrame(invite);
    return {
      source: null,
      slideId: null,
      clip: null,
      endsAt: invite.expiresAt,
      asleep: null,
      away: false,
      invite: invite.code,
      showNow: invite.expiresAt,
      etag: `"invite-${invite.code}"`,
      file: (k) => frame[k],
    };
  }

  // Then night: the playlist and any pin wait until morning.
  const until = sleepUntil(sleep, now);
  if (until) {
    const frame = await sleepFrame(sleep, until);
    return {
      source: null,
      slideId: null,
      clip: null,
      endsAt: until,
      asleep: until,
      away: false,
      invite: null,
      showNow: null,
      etag: `"sleep-${sleep.screen}-${until}"`,
      file: frame ? (k) => frame[k] : null,
    };
  }

  const s = showing(store.getLive(), store.program(), now);
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
  const showNow = pin.mode === "pin" ? (pin.until ?? 0) : null;
  return { ...s, endsAt: ends.length ? Math.min(...ends) : null, etag, file: f.file, asleep: null, away: false, invite: null, showNow };
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
// X-Sleep-Until: while asleep or away, when the panel wakes (ms since epoch; 0 = when switched back). 204 = keep the last picture; ETag "idle" when nothing has played.
// X-Source: app:<id>, image:<id>, or invite:<code> while an invite is on the panel.
// X-Source-Name: the drawing's or app's name, URI-encoded (names aren't always ASCII), for logs.
// X-Show-Now: while Show now or an invite holds /live, when it ends (ms since epoch): a new value is a fresh one.

/** The last time a display (anything but this web app's previews) asked for /live. */
let lastSeen: { at: number; agent: string } | null = null;

async function live(c: Context, kind: "mono" | "bin") {
  if (!c.req.query("e")) lastSeen = { at: Date.now(), agent: c.req.header("user-agent") ?? "" };
  let now = await liveNow();
  const etag = c.req.header("if-none-match");
  // Nothing on air uses its own tag, so the panel can keep waiting instead of coming back a minute later.
  const same = !!etag && (now ? now.etag === etag : etag === `"idle"`);
  if (c.req.query("wait") && same) {
    await nextChange(now, 55_000);
    now = await liveNow();
  }
  if (!now) {
    c.header("ETag", `"idle"`);
    c.header("Cache-Control", "no-cache");
    return c.body(null, 204);
  }

  c.header("ETag", now.etag);
  c.header("Cache-Control", "no-cache");
  if (now.source) {
    c.header("X-Source", `${now.source.kind}:${now.source.id}`);
    const name = now.source.kind === "image" ? store.getImageMeta(now.source.id)?.name : store.getApp(now.source.id)?.name;
    if (name) c.header("X-Source-Name", encodeURIComponent(name));
  } else if (now.invite) {
    c.header("X-Source", `invite:${now.invite}`);
    c.header("X-Source-Name", "Invite");
  }
  if (now.asleep !== null) c.header("X-Sleep-Until", String(now.asleep));
  if (now.endsAt) c.header("X-Next-Change", String(Math.ceil((now.endsAt - Date.now()) / 1000)));
  // Someone just asked for this picture: the panel flashes clean before drawing it.
  if (now.showNow !== null) c.header("X-Show-Now", String(now.showNow));
  if (etag === now.etag) return c.body(null, 304);
  if (!now.file) return c.body(null, 204);

  c.header("Content-Type", kind === "bin" ? "application/octet-stream" : "image/png");
  return c.body(now.file(kind));
}

app.get("/live", (c) => live(c, "mono"));
app.get("/live.png", (c) => live(c, "mono"));
app.get("/live.bin", (c) => live(c, "bin"));

// ── People: signing in, and who may do what ─────────────────────────────────
// Everything under /api needs someone signed in, except /api/hello: the sign-in screen itself.
// /live stays open, so the panel never needs to sign in.

const COOKIE = "papershow";

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/hello" || c.req.path.startsWith("/api/hello/")) return next();
  const me = people.personFor(getCookie(c, COOKIE));
  if (!me) return c.json({ error: "Sign in first" }, 401);
  if (me.status !== "in") return c.json({ error: "Still waiting to be let in" }, 403);
  c.set("me", me);
  return next();
});

const isAdmin = (c: C) => c.get("me").role === "admin";
/** Anyone can use anything; only its maker or an admin changes or deletes it. */
const mayChange = (c: C, madeBy: string | null | undefined) => isAdmin(c) || !madeBy || madeBy === c.get("me").id;
const notYours = (c: C) => c.json({ error: "Only its maker or an admin can change this" }, 403);
const adminsOnly = (c: C) => c.json({ error: "Only an admin can do this" }, 403);

/** How the log names things: with the name they had then. */
function named(src: Source): people.Named {
  const name = src.kind === "image" ? store.getImageMeta(src.id)?.name : store.getApp(src.id)?.name;
  return { kind: src.kind, id: src.id, name: name ?? "Something" };
}
const namedPlaylist = (id: string): people.Named => ({ kind: "playlist", id, name: store.getPlaylist(id)?.name ?? "a playlist" });
const namedPerson = (p: people.Person) => ({ kind: "person", id: p.id, name: p.name, face: p.face });

/** Note what the signed-in person did, for the log. */
const note = (c: C, verb: string, subject: Record<string, unknown> = {}, settling?: string[]) =>
  people.note(c.get("me").id, verb, subject, Date.now(), settling);

function signInAs(c: C, personId: string) {
  setCookie(c, COOKIE, people.startSession(personId), {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: people.SESSION_DAYS * 86_400,
  });
}

/** What the sign-in screen needs, and who this device is signed in as (if anyone). */
function hello(c: C, me = people.personFor(getCookie(c, COOKIE))) {
  return {
    first: people.isFirstRun(),
    people: people.listPeople().filter((p) => p.status === "in").map(people.toFace),
    keys: people.KEYS,
    faces: people.FACES,
    colors: people.COLORS,
    me: me ?? null,
  };
}

type Joining = Partial<people.Profile> & { secret?: unknown };

/** A profile and secret from a join form, or the reason it won't do. */
function joining(body: Joining): { profile: people.Profile; secret: string[] } | string {
  const profile = people.checkProfile(body);
  if (typeof profile === "string") return profile;
  if (!people.isSecret(body.secret)) return `Pick a ${people.SECRET_LENGTH}-digit PIN`;
  return { profile, secret: body.secret };
}

/** ?wait=1 holds the answer until something changes: the knock screen hears "come in" at once. */
app.get("/api/hello", async (c) => {
  if (c.req.query("wait")) await nextChange(null, 25_000);
  return c.json(hello(c));
});

/** The very first person sets up the house: they become its admin, and everything made so far is theirs. */
app.post("/api/hello/setup", async (c) => {
  if (!people.isFirstRun()) return c.json({ error: "This house is already set up" }, 409);
  const j = joining(await c.req.json<Joining>());
  if (typeof j === "string") return c.json({ error: j }, 400);
  const me = people.createPerson(j.profile, j.secret, "admin", "in");
  store.claimAll(me.id);
  people.note(me.id, "set-up");
  signInAs(c, me.id);
  changed();
  return c.json(hello(c, me));
});

app.post("/api/hello/in", async (c) => {
  const { id, secret } = await c.req.json<{ id?: string; secret?: unknown }>();
  if (!id || !people.isSecret(secret)) return c.json({ error: "Tap your face, then your secret" }, 400);
  const r = people.signIn(id, secret);
  if (!r.ok) return c.json({ error: "That's not it", triesLeft: r.triesLeft, lockedUntil: r.lockedUntil }, 401);
  signInAs(c, r.person.id);
  return c.json(hello(c, r.person));
});

app.post("/api/hello/out", (c) => {
  const token = getCookie(c, COOKIE);
  if (token) people.endSession(token);
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json(hello(c, undefined));
});

/** Someone new: with a working invite they're in at once, otherwise they knock and wait for an admin. */
app.post("/api/hello/knock", async (c) => {
  if (people.isFirstRun()) return c.json({ error: "Set up the house first" }, 409);
  const body = await c.req.json<Joining & { invite?: string }>();
  const j = joining(body);
  if (typeof j === "string") return c.json({ error: j }, 400);
  const invite = body.invite ? people.getInvite(body.invite) : undefined;
  if (body.invite && !invite) return c.json({ error: "That invite has run out. Knock instead?" }, 410);
  const me = people.createPerson(j.profile, j.secret, "member", invite ? "in" : "knocking");
  if (invite) {
    people.useInvite(invite.code, me.id);
    const host = invite.madeBy ? people.getPerson(invite.madeBy) : undefined;
    people.note(me.id, "joined", host ? { by: namedPerson(host) } : {});
  } else people.note(me.id, "knocked");
  signInAs(c, me.id);
  changed();
  return c.json(hello(c, me));
});

/** An invite's details for the join screen: who sent it. */
app.get("/api/hello/invite/:code", (c) => {
  const invite = people.getInvite(c.req.param("code"));
  if (!invite) return c.json({ error: "This invite has run out" }, 404);
  const host = invite.madeBy ? people.getPerson(invite.madeBy) : undefined;
  return c.json({ code: invite.code, expiresAt: invite.expiresAt, by: host ? people.toFace(host) : null });
});

/** Admins see who's knocking too. Removed people stay listed, so the log can still show their faces. */
const peopleFor = (c: C) => people.listPeople().filter((p) => isAdmin(c) || p.status !== "knocking");

app.patch("/api/me", async (c) => {
  const me = c.get("me");
  const body = await c.req.json<Partial<people.Profile> & { secret?: unknown }>();
  const profile = people.checkProfile({ name: me.name, face: me.face, color: me.color, ...body }, me.id);
  if (typeof profile === "string") return c.json({ error: profile }, 400);
  if (body.secret !== undefined && !people.isSecret(body.secret)) return c.json({ error: `Pick a ${people.SECRET_LENGTH}-digit PIN` }, 400);
  people.updatePerson(me.id, { ...profile, secret: body.secret as string[] | undefined });
  if (profile.name !== me.name || profile.face !== me.face || profile.color !== me.color) note(c, "new-look", { was: namedPerson(me) });
  changed();
  return c.json(await state(c));
});

app.patch("/api/people/:id", async (c) => {
  if (!isAdmin(c)) return adminsOnly(c);
  const p = people.getPerson(c.req.param("id"));
  if (!p) return c.notFound();
  const { status, role } = await c.req.json<{ status?: people.Status; role?: people.Role }>();
  if (status && !["in", "out"].includes(status)) return c.json({ error: "Let them in or out" }, 400);
  if (role && !["admin", "member"].includes(role)) return c.json({ error: "Admin or member" }, 400);
  const losesAdmin = p.role === "admin" && (status === "out" || role === "member");
  if (losesAdmin && !people.otherAdmins(p.id)) return c.json({ error: "Someone has to stay an admin" }, 400);
  people.updatePerson(p.id, { status, role });
  const who = { person: namedPerson(p) };
  if (status && status !== p.status) note(c, status === "out" ? "removed" : p.status === "knocking" ? "let-in" : "let-back-in", who);
  if (role && role !== p.role) note(c, role === "admin" ? "made-admin" : "made-member", who);
  changed();
  return c.json(await state(c));
});

/** Not now: someone knocking goes away. They can knock again. */
app.delete("/api/people/:id", async (c) => {
  if (!isAdmin(c)) return adminsOnly(c);
  const p = people.getPerson(c.req.param("id"));
  if (!p || p.status !== "knocking") return c.json({ error: "Only someone still knocking can be turned away" }, 400);
  people.deletePerson(p.id);
  note(c, "not-now", { person: namedPerson(p) });
  changed();
  return c.json(await state(c));
});

/** A 10-minute invite, shown as a QR code on the admin's screen and, with `panel`, on the panel too. */
app.post("/api/invites", async (c) => {
  if (!isAdmin(c)) return adminsOnly(c);
  const { origin, panel } = await c.req.json<{ origin?: string; panel?: boolean }>();
  if (!origin || !/^https?:\/\/[^/\s]+$/.test(origin)) return c.json({ error: "Which address should the invite open?" }, 400);
  const invite = people.createInvite(c.get("me").id, origin, !!panel);
  note(c, "invited", { panel: !!panel });
  if (panel) {
    changed();
    // When it runs out, the panel goes back to the show by itself; open pages hear it then.
    setTimeout(changed, people.INVITE_MS + 50).unref();
  }
  return c.json(invite);
});

app.delete("/api/invites/:code/panel", async (c) => {
  if (!isAdmin(c)) return adminsOnly(c);
  people.hideInvite(c.req.param("code"));
  changed();
  return c.json(await state(c));
});

app.get("/api/invites/:code/qr.svg", (c) => {
  const invite = people.getInvite(c.req.param("code"));
  if (!invite) return c.notFound();
  c.header("Content-Type", "image/svg+xml");
  c.header("Cache-Control", "private, max-age=600");
  return c.body(qrSvg(invite.url));
});

app.get("/api/log", (c) =>
  c.json(
    people.listLog({
      limit: Number(c.req.query("limit")) || 50,
      before: Number(c.req.query("before")) || undefined,
      personId: c.req.query("person") || undefined,
      verbs: c.req.query("verbs")?.split(",").filter(Boolean),
    }),
  ),
);

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
  // A drawing over a photo keeps its colour copy as a JPEG, under the same name.
  c.header("Content-Type", file.data[0] === 0xff && file.data[1] === 0xd8 ? "image/jpeg" : KINDS[kind]);
  return c.body(file.data);
});

app.put("/api/images/:id", async (c) => {
  const form = await c.req.formData();
  const scene = JSON.parse(String(form.get("scene"))) as Scene;
  if (scene.id !== c.req.param("id")) return c.json({ error: "id mismatch" }, 400);
  const was = store.getImageMeta(scene.id);
  if (was && !mayChange(c, was.madeBy)) return notYours(c);
  const bytes = async (k: string) => new Uint8Array(await (form.get(k) as File).arrayBuffer());
  store.putImage(scene, { png: await bytes("png"), mono: await bytes("mono"), bin: await bytes("bin") }, c.get("me").id);
  note(c, was ? "redrew" : "drew", { item: named({ kind: "image", id: scene.id }) });
  changed();
  return c.json(store.getImageMeta(scene.id));
});

app.delete("/api/images/:id", (c) => {
  const was = store.getImageMeta(c.req.param("id"));
  if (!was) return c.body(null, 204);
  if (!mayChange(c, was.madeBy)) return notYours(c);
  note(c, "erased", { item: named({ kind: "image", id: was.id }) });
  store.deleteImage(was.id);
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
  const row = store.createApp(kind, uniqueName(name?.trim() || def.name), configFor(def, config), c.get("me").id);
  note(c, "made-app", { item: named({ kind: "app", id: row.id }) });
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
  if (!mayChange(c, row.madeBy)) return notYours(c);
  const patch = await c.req.json<{ name?: string; config?: Record<string, unknown> }>();
  store.updateApp(row.id, {
    name: patch.name?.trim() || undefined,
    config: patch.config && configFor(APPS[row.kind], patch.config),
  });
  forgetApp(row.id);
  note(c, "tuned-app", { item: named({ kind: "app", id: row.id }) });
  changed();
  return c.json(store.getApp(row.id));
});

app.delete("/api/apps/:id", (c) => {
  const row = store.getApp(c.req.param("id"));
  if (!row) return c.body(null, 204);
  if (!mayChange(c, row.madeBy)) return notYours(c);
  note(c, "deleted-app", { item: named({ kind: "app", id: row.id }) });
  store.deleteApp(row.id);
  forgetApp(row.id);
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

async function state(c: C) {
  const now = Date.now();
  const slides = store.listSlides();
  const program = store.program();
  const live = await liveNow(now);
  const air = blockAt(program, now);
  const onAir = air?.block.slides.find((x) => x.id === live?.slideId);
  return {
    now,
    live: store.getLive(),
    showing: live && {
      source: live.source,
      slideId: live.slideId,
      entryId: onAir?.entryId ?? null,
      clipId: onAir?.clipId ?? null,
      endsAt: live.endsAt,
      clip: live.clip,
      etag: live.etag,
      asleep: live.asleep,
      away: live.away,
      blank: !live.file,
      invite: live.invite,
    },
    sleep: store.getSleep(),
    slides,
    playlists: store.listPlaylists(),
    show: store.listShow(),
    /** The week's blocks; the weekend plays the weekdays' unless it has its own. */
    program: { weekendOwn: program.weekendOwn, blocks: store.listBlocks(), timeCheck: store.getTimeCheck() },
    /** The block on air (even under a Show now or the night), and when it hands over. */
    block: air && { id: air.block.id, startedAt: air.startedAt, endsAt: air.endsAt },
    upcoming: upcoming(program, now, 3),
    sequence: sequence(program, now, 60),
    /** The turn that just handed off, so the guide can show what played before this. */
    previous: justAired(program, now),
    display: lastSeen,
    me: c.get("me"),
    people: peopleFor(c),
    /** The last few things people did; /api/log has the rest. */
    log: people.listLog({ limit: 8 }),
  };
}

app.get("/api/state", async (c) => c.json(await state(c)));

/** Long-poll for the admin: returns when anything changes or the frame turns over. */
app.get("/api/state/wait", async (c) => {
  await nextChange(await liveNow(), 25_000);
  return c.json(await state(c));
});

app.post("/api/slides", async (c) => {
  const body = await c.req.json<{ source?: Source; imageId?: string; playlistId?: string; at?: number }>();
  const source: Source | undefined = body.source ?? (body.imageId ? { kind: "image", id: body.imageId } : undefined);
  if (!source || !exists(source)) return c.json({ error: "no such image or app" }, 404);
  const playlist = (body.playlistId && store.getPlaylist(body.playlistId)) || store.listPlaylists()[0];
  if (!mayChange(c, playlist.madeBy)) return notYours(c);
  store.addSlide(source, playlist.id, body.at, clipLength(source));
  note(c, "added-to-playlist", { item: named(source), playlist: namedPlaylist(playlist.id) });
  changed();
  return c.json(await state(c));
});

/** The playlist a clip is in, if the signed-in person may change it. */
function clipFor(c: C, id: string) {
  const clip = store.listSlides().find((s) => s.id === id);
  const playlist = clip?.playlistId ? store.getPlaylist(clip.playlistId) : undefined;
  return clip && playlist ? { clip, playlist, mine: mayChange(c, playlist.madeBy) } : undefined;
}

app.patch("/api/slides/:id", async (c) => {
  const found = clipFor(c, c.req.param("id"));
  if (!found) return c.notFound();
  if (!found.mine) return notYours(c);
  store.updateSlide(found.clip.id, await c.req.json());
  note(c, "changed-playlist", { playlist: namedPlaylist(found.playlist.id) });
  changed();
  return c.json(await state(c));
});

app.put("/api/slides/order", async (c) => {
  const { ids } = await c.req.json<{ ids: string[] }>();
  const found = ids.length ? clipFor(c, ids[0]) : undefined;
  if (!found) return c.json({ error: "no such clips" }, 404);
  // Every clip reordered must be in that one playlist.
  if (!found.mine || ids.some((id) => clipFor(c, id)?.playlist.id !== found.playlist.id)) return notYours(c);
  store.reorderSlides(ids);
  note(c, "changed-playlist", { playlist: namedPlaylist(found.playlist.id) });
  changed();
  return c.json(await state(c));
});

app.delete("/api/slides/:id", async (c) => {
  const found = clipFor(c, c.req.param("id"));
  if (!found) return c.json(await state(c));
  if (!found.mine) return notYours(c);
  store.deleteSlide(found.clip.id);
  note(c, "removed-from-playlist", { item: named(found.clip.source), playlist: namedPlaylist(found.playlist.id) });
  changed();
  return c.json(await state(c));
});

app.post("/api/playlists", async (c) => {
  const { name, show = true } = await c.req.json<{ name?: string; show?: boolean }>();
  const p = store.createPlaylist(name?.trim() || `Playlist ${store.listPlaylists().length + 1}`, c.get("me").id);
  // A new playlist joins the end of what's on now unless asked not to.
  if (show) store.addShowEntry(blockNow(), { playlistId: p.id });
  note(c, "made-playlist", { playlist: namedPlaylist(p.id) });
  changed();
  return c.json({ ...(await state(c)), created: p.id });
});

app.patch("/api/playlists/:id", async (c) => {
  const p = store.getPlaylist(c.req.param("id"));
  if (!p) return c.notFound();
  if (!mayChange(c, p.madeBy)) return notYours(c);
  const patch = await c.req.json<{ name?: string; enabled?: boolean }>();
  store.updatePlaylist(p.id, patch);
  if (patch.name?.trim() && patch.name.trim() !== p.name) note(c, "renamed-playlist", { playlist: namedPlaylist(p.id), was: p.name });
  changed();
  return c.json(await state(c));
});

app.put("/api/playlists/order", async (c) => {
  store.reorderPlaylists((await c.req.json<{ ids: string[] }>()).ids);
  changed();
  return c.json(await state(c));
});

app.delete("/api/playlists/:id", async (c) => {
  const p = store.getPlaylist(c.req.param("id"));
  if (!p) return c.json(await state(c));
  if (!mayChange(c, p.madeBy)) return notYours(c);
  note(c, "deleted-playlist", { playlist: namedPlaylist(p.id) });
  store.deletePlaylist(p.id);
  changed();
  return c.json(await state(c));
});

// ── The program: blocks of the day, for weekdays and the weekend ──────────

/** The block on air now, for things added without saying where. There's always one to add to. */
function blockNow() {
  const air = blockAt(store.program());
  return air?.block.id ?? store.listBlocks()[0]?.id ?? store.addBlock("weekdays", "06:00")!.id;
}

app.post("/api/blocks", async (c) => {
  const { days, start } = await c.req.json<{ days?: Days; start?: string }>();
  if (days !== "weekdays" && days !== "weekend") return c.json({ error: "weekdays or weekend" }, 400);
  const b = store.addBlock(days, start ?? "");
  if (!b) return c.json({ error: "there's already something at that time" }, 409);
  note(c, "changed-program");
  changed();
  return c.json({ ...(await state(c)), created: b.id });
});

app.patch("/api/blocks/:id", async (c) => {
  const { start } = await c.req.json<{ start?: string }>();
  if (!store.getBlock(c.req.param("id"))) return c.notFound();
  if (!store.moveBlock(c.req.param("id"), start ?? "")) return c.json({ error: "there's already something at that time" }, 409);
  note(c, "changed-program");
  changed();
  return c.json(await state(c));
});

app.delete("/api/blocks/:id", async (c) => {
  store.deleteBlock(c.req.param("id"));
  note(c, "changed-program");
  changed();
  return c.json(await state(c));
});

app.put("/api/program", async (c) => {
  const { weekendOwn, timeCheck } = await c.req.json<{ weekendOwn?: boolean; timeCheck?: Partial<store.TimeCheck> }>();
  if (weekendOwn !== undefined) store.setWeekendOwn(!!weekendOwn);
  if (timeCheck) store.setTimeCheck(timeCheck);
  note(c, "changed-program");
  changed();
  return c.json(await state(c));
});

// ── The show: playlists, images and apps, in the order they run ───────────

app.post("/api/show", async (c) => {
  const body = await c.req.json<{ blockId?: string; playlistId?: string; source?: Source; at?: number }>();
  const blockId = body.blockId && store.getBlock(body.blockId) ? body.blockId : blockNow();
  if (body.playlistId) {
    if (!store.getPlaylist(body.playlistId)) return c.json({ error: "no such playlist" }, 404);
    store.addShowEntry(blockId, { playlistId: body.playlistId }, body.at);
    note(c, "added-to-show", { playlist: namedPlaylist(body.playlistId) });
  } else if (body.source && exists(body.source)) {
    store.addShowEntry(blockId, { source: body.source }, body.at, clipLength(body.source));
    note(c, "added-to-show", { item: named(body.source) });
  } else return c.json({ error: "add a playlist, image or app" }, 400);
  changed();
  return c.json(await state(c));
});

/** How the log names a show entry: its playlist, or its single image or app. */
function namedEntry(id: string) {
  const e = store.listShow().find((x) => x.id === id);
  return e?.playlistId ? { playlist: namedPlaylist(e.playlistId) } : e?.source ? { item: named(e.source) } : {};
}

app.patch("/api/show/:id", async (c) => {
  store.updateShowEntry(c.req.param("id"), await c.req.json());
  note(c, "changed-show", namedEntry(c.req.param("id")));
  changed();
  return c.json(await state(c));
});

app.put("/api/show/order", async (c) => {
  store.reorderShow((await c.req.json<{ ids: string[] }>()).ids);
  note(c, "reordered-show");
  changed();
  return c.json(await state(c));
});

app.delete("/api/show/:id", async (c) => {
  const what = namedEntry(c.req.param("id"));
  store.deleteShowEntry(c.req.param("id"));
  if (Object.keys(what).length) note(c, "removed-from-show", what);
  changed();
  return c.json(await state(c));
});

app.put("/api/sleep", async (c) => {
  if (!isAdmin(c)) return adminsOnly(c);
  const was = store.getSleep();
  const now = store.setSleep(await c.req.json());
  if (now.away !== was.away) note(c, now.away ? "turned-off" : "turned-on", now.away && now.back ? { back: now.back } : {});
  // Trying a few hours before settling on one is one change in the log, with the hours it ended on.
  else note(c, "changed-night", { enabled: now.enabled, start: now.start, end: now.end }, ["start", "end"]);
  changed();
  return c.json(await state(c));
});

app.put("/api/live", async (c) => {
  const live = await c.req.json<Live & { forS?: number }>();
  if (live.mode === "pin") {
    if (!live.source || !exists(live.source)) return c.json({ error: "no such image or app" }, 404);
    // Show now takes over once, for its turn (`forS`, else 15 minutes), then the playlists carry on.
    const forS = Number(live.forS) > 0 ? Number(live.forS) : SHOW_NOW_S;
    store.setLive({
      mode: "pin",
      source: { kind: live.source.kind, id: live.source.id },
      until: Date.now() + forS * 1000,
      by: c.get("me").id,
      from: live.from === "draw" ? "draw" : null,
    });
    note(c, "showed-now", { item: named(live.source) });
    // The panel wakes on its own at the end; open pages hear it then.
    setTimeout(changed, forS * 1000 + 50).unref();
  } else {
    if (store.getLive().mode === "pin") note(c, "resumed");
    store.setLive({ mode: "rotate" });
  }
  changed();
  return c.json(await state(c));
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

// Render every app once, one after another, so the first pages opened after a start or an update show
// their frames at once instead of waiting on prices, headlines and photos.
(async () => {
  for (const row of store.listApps()) if (APPS[row.kind]) await appFrame(row, Date.now()).catch(() => {});
})();

// On the Pi, also on port 80, so http://paper.local needs no port. Optional: if it's taken, the
// main port still serves everything.
if (process.env.WEB_PORT) {
  const webPort = Number(process.env.WEB_PORT);
  serve({ fetch: app.fetch, port: webPort }, () => console.log(`also on port ${webPort}`)).on("error", (err) =>
    console.error(`port ${webPort}: ${err.message}; serving on ${port} only`),
  );
}
