import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Scene } from "@papershow/scene";
import { APPS, appFrame, appFrameAt, catalog, configFor, forgetApp, previewFrame } from "./apps/index.ts";
import { watchModels } from "./ai.ts";
import * as asks from "./asks.ts";
import * as store from "./db.ts";
import { inviteFrame, qrSvg } from "./invite.tsx";
import * as people from "./people.ts";
import { panelFiles } from "./render.ts";
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

  // An invite someone put on the panel, for a couple of minutes or until it's used. It beats the night:
  // someone's standing there with their phone.
  const invite = people.panelInvite(now);
  if (invite) {
    const frame = await inviteFrame(invite);
    return {
      source: null,
      slideId: null,
      clip: null,
      endsAt: invite.onPanelUntil,
      asleep: null,
      away: false,
      invite: invite.code,
      showNow: invite.onPanelUntil,
      // Not the code itself: /live is open to anyone on the network, and the code lets them in.
      etag: `"invite-${createHash("sha1").update(`${invite.code}-${invite.role}`).digest("hex").slice(0, 12)}"`,
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
// X-Source: app:<id>, image:<id>, or invite while an invite is on the panel.
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
    c.header("X-Source", "invite");
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

// Uploads are served back as they came: browsers must take their type as given, never guess HTML from them.
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
});

// Changes come only from Papershow's own pages. The cookie is SameSite=Lax, but a page on another port of this
// host (the Pi runs other things) counts as the same site, so the browser's word on where a request comes from
// is checked too. Without Sec-Fetch-Site (older browsers), the Origin's host must be this one.
app.use("/api/*", async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") return next();
  const site = c.req.header("sec-fetch-site");
  const origin = c.req.header("origin");
  let ours = site ? site === "same-origin" || site === "none" : !origin;
  if (!site && origin)
    try {
      ours = new URL(origin).host === c.req.header("host");
    } catch {
      ours = false;
    }
  return ours ? next() : c.json({ error: "Only Papershow's own pages can change things" }, 403);
});

// A drawing carries its photo and three renders; nothing else needs more than a little JSON.
const tooBig = (c: Context) => c.json({ error: "That's too big to send" }, 413);
const drawingBody = bodyLimit({ maxSize: 40 * 1024 * 1024, onError: tooBig });
const smallBody = bodyLimit({ maxSize: 1024 * 1024, onError: tooBig });
app.use("/api/*", (c, next) => (c.req.method === "PUT" && /^\/api\/images\/[\w-]+$/.test(c.req.path) ? drawingBody : smallBody)(c, next));

/**
 * Who's asking, for the limits on the routes that need no one signed in. Tailscale serve and the dev proxy reach
 * the server from this machine, so then the last X-Forwarded-For, the one the proxy added, names the device.
 */
function from(c: Context) {
  const ip = getConnInfo(c).remote.address ?? "";
  const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
  return forwarded && /^(127\.|::1$|::ffff:127\.)/.test(ip) ? forwarded : ip;
}

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/hello" || c.req.path.startsWith("/api/hello/")) return next();
  const me = people.personFor(getCookie(c, COOKIE));
  if (!me) return c.json({ error: "Sign in first" }, 401);
  if (me.status !== "in") return c.json({ error: "Still waiting to be let in" }, 403);
  c.set("me", me);
  return next();
});

// Guests draw, make apps and ask for things to go on the panel. The show, the playlists, the log and the
// house's settings stay with the household, so everything a guest may change is listed here.
const GUEST_MAY: [string, RegExp][] = [
  ["PATCH", /^\/api\/me$/],
  ["PUT", /^\/api\/images\/[\w-]+$/],
  ["DELETE", /^\/api\/images\/[\w-]+$/],
  ["POST", /^\/api\/apps(\/preview)?$/],
  ["PATCH", /^\/api\/apps\/[\w-]+$/],
  ["DELETE", /^\/api\/apps\/[\w-]+$/],
  ["POST", /^\/api\/asks$/],
  ["DELETE", /^\/api\/asks\/[\w-]+$/],
];

app.use("/api/*", async (c, next) => {
  if (c.get("me")?.role !== "guest") return next();
  const { method, path } = c.req;
  const reading = method === "GET" && path !== "/api/log";
  if (reading || GUEST_MAY.some(([m, re]) => m === method && re.test(path))) return next();
  return c.json({ error: "Guests can't change this. Ask someone in the house?" }, 403);
});

const isAdmin = (c: C) => c.get("me").role === "admin";
const isGuest = (c: C) => c.get("me").role === "guest";
/** Anyone can use anything; only its maker or an admin changes or deletes it. */
const mayChange = (c: C, madeBy: string | null | undefined) => isAdmin(c) || !madeBy || madeBy === c.get("me").id;
const notYours = (c: C) => c.json({ error: "Only its maker or an admin can change this" }, 403);
const adminsOnly = (c: C) => c.json({ error: "Only an admin can do this" }, 403);

/** Spend one of the hour's goes at `bucket`; when they're used up, the answer that says how long to wait. */
function tooMany(c: C, bucket: people.Bucket) {
  const until = people.spend(c.get("me"), bucket);
  if (until === null) return null;
  const min = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
  return c.json({ error: `That's a lot for one hour. Try again in ${min} min`, retryAt: until }, 429);
}

/**
 * A guest changed a drawing or app of theirs. If it's on the panel by their ask, waiting on one, or in a playlist
 * or the show, the household said yes to how it looked before: it comes off, and they ask again.
 */
function guestChanged(c: C, src: Source) {
  if (!isGuest(c)) return;
  asks.dropAsksFor(src);
  // Its places in playlists and the show were said yes to as well.
  store.unschedule(src);
  const live = store.getLive();
  if (live.mode === "pin" && live.okBy && live.source.kind === src.kind && live.source.id === src.id) store.setLive({ mode: "rotate" });
}

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
  const r = people.signIn(id, secret, from(c));
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
  // Knocking needs no one signed in, so one device can't fill the door with strangers.
  if (!body.invite && !people.mayKnock(from(c))) return c.json({ error: "Lots of knocking just now. Ask someone in the house to let you in?" }, 429);
  const invite = body.invite ? people.getInvite(body.invite) : undefined;
  if (body.invite && !invite) return c.json({ error: "That invite has run out. Knock instead?" }, 410);
  const me = people.createPerson(j.profile, j.secret, invite?.role ?? "member", invite ? "in" : "knocking");
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
  return c.json({ code: invite.code, expiresAt: invite.expiresAt, role: invite.role, by: host ? people.toFace(host) : null });
});

/** The household and admins see who's knocking too. Removed people stay listed, so the log can still show their faces. */
const peopleFor = (c: C) => people.listPeople().filter((p) => !isGuest(c) || p.status !== "knocking");

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
  const p = people.getPerson(c.req.param("id"));
  if (!p) return c.notFound();
  const { status, role } = await c.req.json<{ status?: people.Status; role?: people.Role }>();
  // Anyone in the household can answer the door, as household or as a guest. The rest is for admins.
  const answeringDoor = p.status === "knocking" && status === "in" && role !== "admin";
  if (!isAdmin(c) && !answeringDoor) return adminsOnly(c);
  if (status && !["in", "out"].includes(status)) return c.json({ error: "Let them in or out" }, 400);
  if (role && !people.ROLES.includes(role)) return c.json({ error: "Admin, household or guest" }, 400);
  const losesAdmin = p.role === "admin" && (status === "out" || (!!role && role !== "admin"));
  if (losesAdmin && !people.otherAdmins(p.id)) return c.json({ error: "Someone has to stay an admin" }, 400);
  people.updatePerson(p.id, { status, role });
  const who = { person: namedPerson(p) };
  // Letting someone in as a guest is one thing done, not two.
  const lettingIn = p.status === "knocking" && status === "in";
  if (status && status !== p.status) note(c, status === "out" ? "removed" : lettingIn ? "let-in" : "let-back-in", lettingIn && role === "guest" ? { ...who, guest: true } : who);
  if (role && role !== p.role && !lettingIn) note(c, `made-${role}`, who);
  changed();
  return c.json(await state(c));
});

/**
 * Delete someone who was removed, and everything they did: their drawings, apps and playlists (and with them
 * their places in the show and in others' playlists), and every log line by or about them. Can't be undone.
 */
app.delete("/api/people/:id/everything", async (c) => {
  if (!isAdmin(c)) return adminsOnly(c);
  const p = people.getPerson(c.req.param("id"));
  if (!p) return c.notFound();
  if (p.status !== "out") return c.json({ error: "Remove them first" }, 400);
  const theirs = <T extends { madeBy: string | null }>(xs: T[]) => xs.filter((x) => x.madeBy === p.id);
  const images = theirs(store.listImages());
  const apps = theirs(store.listApps());
  const playlists = theirs(store.listPlaylists());
  for (const i of images) store.deleteImage(i.id);
  for (const a of apps) {
    store.deleteApp(a.id);
    forgetApp(a.id);
  }
  for (const pl of playlists) store.deletePlaylist(pl.id);
  // Whatever they put on the panel comes off too.
  const live = store.getLive();
  if (live.mode === "pin" && live.by === p.id) store.setLive({ mode: "rotate" });
  people.forgetPerson(p.id);
  // Only how much went: the point is that nothing of them is left, their name included.
  note(c, "cleared-out", { drawings: images.length, apps: apps.length, playlists: playlists.length });
  changed();
  return c.json({ ...(await state(c)), deleted: { drawings: images.length, apps: apps.length, playlists: playlists.length } });
});

/** Not now: someone knocking goes away. They can knock again. */
app.delete("/api/people/:id", async (c) => {
  const p = people.getPerson(c.req.param("id"));
  if (!p || p.status !== "knocking") return c.json({ error: "Only someone still knocking can be turned away" }, 400);
  people.deletePerson(p.id);
  note(c, "not-now", { person: namedPerson(p) });
  changed();
  return c.json(await state(c));
});

/** A 10-minute invite, for the household or a guest, shown as a QR code on the admin's screen. */
app.post("/api/invites", async (c) => {
  if (!isAdmin(c)) return adminsOnly(c);
  const { origin, role } = await c.req.json<{ origin?: string; role?: string }>();
  if (!origin || !/^https?:\/\/[^/\s]+$/.test(origin)) return c.json({ error: "Which address should the invite open?" }, 400);
  const guest = role === "guest";
  const invite = people.createInvite(c.get("me").id, origin, guest ? "guest" : "member");
  note(c, "invited", { guest });
  return c.json(invite);
});

/** Who the invite lets in as: household or guest. */
app.patch("/api/invites/:code", async (c) => {
  if (!isAdmin(c)) return adminsOnly(c);
  const { role } = await c.req.json<{ role?: string }>();
  if (role !== "member" && role !== "guest") return c.json({ error: "Household or guest" }, 400);
  const invite = people.setInviteRole(c.req.param("code"), role);
  if (!invite) return c.json({ error: "This invite has run out" }, 410);
  if (invite.onPanelUntil) changed();
  return c.json(invite);
});

/** The same invite on the panel too, for a couple of minutes, so someone can scan it there. */
app.put("/api/invites/:code/panel", async (c) => {
  if (!isAdmin(c)) return adminsOnly(c);
  const invite = people.showInvite(c.req.param("code"));
  if (!invite) return c.json({ error: "This invite has run out" }, 410);
  note(c, "invite-on-panel", { guest: invite.role === "guest" });
  changed();
  // When its time is up, the panel goes back to the show by itself; open pages hear it then.
  setTimeout(changed, invite.onPanelUntil! - Date.now() + 50).unref();
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
  if (!was) {
    const wait = tooMany(c, "make");
    if (wait) return wait;
  } else guestChanged(c, { kind: "image", id: was.id });
  const bytes = async (k: string) => new Uint8Array(await (form.get(k) as File).arrayBuffer());
  // The panel's files are made here from the 1-bit PNG, so what the panel draws is what everyone sees.
  const panel = panelFiles(await bytes("mono"));
  if (!panel) return c.json({ error: "That drawing didn't come through. Try saving again?" }, 400);
  store.putImage(scene, { png: await bytes("png"), ...panel }, c.get("me").id);
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
  const wait = tooMany(c, "make");
  if (wait) return wait;
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
  guestChanged(c, { kind: "app", id: row.id });
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

// Each person's previews render one at a time: typing fast queues them instead of fanning out renders and fetches.
const previewing = new Map<string, Promise<unknown>>();

/** Render settings that aren't saved yet, so the form previews as you type. */
app.post("/api/apps/preview", async (c) => {
  const { kind, config, original } = await c.req.json<{ kind: string; config: Record<string, unknown>; original?: boolean }>();
  if (!APPS[kind]) return c.json({ error: "no such app" }, 404);
  const wait = tooMany(c, "preview");
  if (wait) return wait;
  const id = c.get("me").id;
  const run = (previewing.get(id) ?? Promise.resolve())
    .catch(() => {})
    .then(() => previewFrame(kind, config ?? {}, { original: !!original }));
  previewing.set(id, run);
  const done = () => previewing.get(id) === run && previewing.delete(id);
  run.then(done, done);
  const frame = await run;
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
    /** Guests' asks to go on the panel, waiting for a yes. A guest sees only their own. */
    asks: asks.listAsks(now).filter((a) => exists(a.source) && (!isGuest(c) || a.by === c.get("me").id)),
    /** The last few things people did; /api/log has the rest. Not for guests. */
    log: isGuest(c) ? [] : people.listLog({ limit: 8 }),
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
  const wait = tooMany(c, "make");
  if (wait) return wait;
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
  const wait = tooMany(c, "make");
  if (wait) return wait;
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
  const wait = tooMany(c, "make");
  if (wait) return wait;
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
    const wait = tooMany(c, "live");
    if (wait) return wait;
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

// ── Asks: a guest's Show now, waiting for the household ─────────────────────

/** A guest asks for a drawing or app to go on the panel; the household sees it on the Dashboard. */
app.post("/api/asks", async (c) => {
  const body = await c.req.json<{ source?: Source; forS?: number; from?: string }>();
  if (!body.source || !exists(body.source)) return c.json({ error: "no such image or app" }, 404);
  const wait = tooMany(c, "live");
  if (wait) return wait;
  const source: Source = { kind: body.source.kind, id: body.source.id };
  const forS = Number(body.forS) > 0 ? Number(body.forS) : SHOW_NOW_S;
  asks.addAsk(c.get("me").id, source, forS, body.from === "draw" ? "draw" : null);
  note(c, "asked-to-show", { item: named(source) });
  changed();
  // Nobody answered: it lapses by itself, and open pages hear it then.
  setTimeout(changed, asks.ASK_MS + 50).unref();
  return c.json(await state(c));
});

/** Yes: it goes on the panel now, for as long as the guest asked, as theirs. */
app.post("/api/asks/:id/yes", async (c) => {
  const ask = asks.getAsk(c.req.param("id"));
  if (!ask || !exists(ask.source)) return c.json({ error: "That ask has lapsed" }, 404);
  const guest = people.getPerson(ask.by);
  store.setLive({ mode: "pin", source: ask.source, until: Date.now() + ask.forS * 1000, by: ask.by, from: ask.via, okBy: c.get("me").id });
  asks.dropAsk(ask.id);
  note(c, "said-yes", { item: named(ask.source), ...(guest && { person: namedPerson(guest) }) });
  setTimeout(changed, ask.forS * 1000 + 50).unref();
  changed();
  return c.json(await state(c));
});

/** Not now, from the household; or taken back by the guest who asked. */
app.delete("/api/asks/:id", async (c) => {
  const ask = asks.getAsk(c.req.param("id"));
  if (!ask) return c.json(await state(c));
  const own = ask.by === c.get("me").id;
  if (isGuest(c) && !own) return c.json({ error: "That's someone else's" }, 403);
  const guest = people.getPerson(ask.by);
  asks.dropAsk(ask.id);
  if (!own) note(c, "said-not-now", { item: named(ask.source), ...(guest && { person: namedPerson(guest) }) });
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
