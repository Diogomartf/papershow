// The people in the house: who they are, how they get in, and what they've done.
//
// Papershow runs on the home Wi-Fi (and a tailnet), so signing in is meant to be easy enough for a
// kid: tap your face, then tap a four-digit PIN. That keeps a guest on the Wi-Fi from acting
// as someone else, without passwords. The panel itself (/live) needs no one.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db } from "./db.ts";

/** The PIN pad, in the order a phone shows it. A secret is four of these: 10,000 PINs, guarded by the lockout below. */
export const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
export const SECRET_LENGTH = 4;

/** Faces to pick from when you join. */
export const FACES = [
  "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐮", "🐷", "🐵", "🐔", "🐧", "🦉",
  "🐢", "🐳", "🦋", "🐞", "🌻", "🌸", "🍄", "🌶️", "🥑", "🍋", "🧁", "🍪",
  "👾", "🤖", "👻", "🎃", "🧙", "🦸", "🐲", "🦖",
];

/** Tile colours. Only the web app shows them; the panel is black and white. */
export const COLORS = ["#f4a259", "#f7d046", "#8cc084", "#5fb7c9", "#7d8fe0", "#c98bdb", "#ef7c8e", "#b8a48c"];

/**
 * Admins run the house. Members are the household (stored as "member"; the app calls them Household): they
 * make things and run the show. Guests draw and make apps, but ask before anything goes on the panel, and
 * don't see the show or the log. Party guests are guests who don't ask: what they add goes straight into the
 * party's playlist, and nowhere else.
 */
export type Role = "admin" | "member" | "guest" | "party";
export const ROLES: Role[] = ["admin", "member", "guest", "party"];
/** Who may join with an invite. */
export type InviteRole = Exclude<Role, "admin">;
export const INVITE_ROLES: InviteRole[] = ["member", "guest", "party"];
/** Knocking: asked to join, waiting for an admin. In: can use Papershow. Out: removed by an admin. */
export type Status = "knocking" | "in" | "out";

export type Person = {
  id: string;
  name: string;
  face: string;
  color: string;
  role: Role;
  status: Status;
  createdAt: number;
  /** The last time they used Papershow, to the minute. */
  seenAt: number | null;
};

/** What the sign-in screen shows: enough to pick yourself out. */
export type Face = Pick<Person, "id" | "name" | "face" | "color">;

db.exec(`
  create table if not exists people (
    id         text primary key,
    name       text not null,
    face       text not null,
    color      text not null,
    secret     text not null,                       -- 'salt:scrypt hash', both hex
    role       text not null default 'member',
    status     text not null default 'knocking',
    created_at integer not null,
    seen_at    integer
  );

  -- One per signed-in device. The cookie holds the token; only its hash is stored.
  create table if not exists sessions (
    token      text primary key,
    person_id  text not null references people(id) on delete cascade,
    created_at integer not null,
    seen_at    integer not null
  );

  -- A short code that lets someone in without knocking, until it expires or is used.
  create table if not exists invites (
    code       text primary key,
    made_by    text references people(id) on delete set null,
    expires_at integer not null,
    url        text not null,                       -- where it leads: /join/<code> on the address it was made from
    on_panel   integer not null default 0,          -- when it comes off the panel (ms), 0 when it isn't on it
    role       text not null default 'member',      -- what whoever uses it joins as
    used_by    text references people(id) on delete set null
  );

  -- Who did what, newest last. 'subject' is JSON: the things it was done to, with their names then.
  create table if not exists log (
    id        integer primary key,
    at        integer not null,
    person_id text references people(id) on delete set null,
    verb      text not null,
    subject   text not null default '{}'
  );
  create index if not exists log_at on log(at);
`);

// Invites made before guests existed let people in as household.
if (!(db.prepare("pragma table_info(invites)").all() as { name: string }[]).some((c) => c.name === "role"))
  db.exec("alter table invites add column role text not null default 'member'");

type PersonRow = {
  id: string;
  name: string;
  face: string;
  color: string;
  role: Role;
  status: Status;
  created_at: number;
  seen_at: number | null;
};

const toPerson = (r: PersonRow): Person => ({
  id: r.id,
  name: r.name,
  face: r.face,
  color: r.color,
  role: r.role,
  status: r.status,
  createdAt: r.created_at,
  seenAt: r.seen_at,
});

export const toFace = (p: Person): Face => ({ id: p.id, name: p.name, face: p.face, color: p.color });

/** Everyone, in the order they joined. */
export function listPeople(): Person[] {
  return (db.prepare("select * from people order by created_at").all() as PersonRow[]).map(toPerson);
}

export function getPerson(id: string): Person | undefined {
  const row = db.prepare("select * from people where id = ?").get(id) as PersonRow | undefined;
  return row && toPerson(row);
}

/** No one yet: the next person to arrive sets up the house and becomes its admin. */
export const isFirstRun = () => !(db.prepare("select count(*) as n from people").get() as { n: number }).n;

// ── Checking what people type ─────────────────────────────────────────────

export type Profile = { name: string; face: string; color: string };

/** A clean profile, or what's wrong with it, in words for the screen. */
export function checkProfile(p: Partial<Profile>, self?: string): Profile | string {
  const name = String(p.name ?? "").trim().replace(/\s+/g, " ");
  if (!name) return "What's your name?";
  if ([...name].length > 24) return "That name is a bit long. Try a shorter one?";
  const taken = listPeople().some((x) => x.id !== self && x.status !== "out" && x.name.toLowerCase() === name.toLowerCase());
  if (taken) return `There's already a ${name} here. Try adding an initial?`;
  if (!FACES.includes(String(p.face))) return "Pick a face";
  if (!COLORS.includes(String(p.color))) return "Pick a colour";
  return { name, face: String(p.face), color: String(p.color) };
}

/** A secret is exactly four keys from the keypad. */
export const isSecret = (s: unknown): s is string[] =>
  Array.isArray(s) && s.length === SECRET_LENGTH && s.every((k) => KEYS.includes(k));

function hashSecret(secret: string[]) {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(secret.join(""), salt, 32).toString("hex")}`;
}

function secretMatches(stored: string, secret: string[]) {
  const [salt, hash] = stored.split(":");
  const tried = scryptSync(secret.join(""), Buffer.from(salt, "hex"), 32);
  return timingSafeEqual(tried, Buffer.from(hash, "hex"));
}

// ── People ────────────────────────────────────────────────────────────────

export function createPerson(profile: Profile, secret: string[], role: Role, status: Status): Person {
  const id = crypto.randomUUID().slice(0, 8);
  db.prepare(
    "insert into people (id, name, face, color, secret, role, status, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, profile.name, profile.face, profile.color, hashSecret(secret), role, status, Date.now());
  return getPerson(id)!;
}

export function updatePerson(id: string, patch: Partial<Profile & { role: Role; status: Status; secret: string[] }>) {
  const p = getPerson(id);
  if (!p) return;
  db.prepare("update people set name = ?, face = ?, color = ?, role = ?, status = ? where id = ?").run(
    patch.name ?? p.name,
    patch.face ?? p.face,
    patch.color ?? p.color,
    patch.role ?? p.role,
    patch.status ?? p.status,
    id,
  );
  if (patch.secret) db.prepare("update people set secret = ? where id = ?").run(hashSecret(patch.secret), id);
  // Removed people are signed out everywhere at once.
  if (patch.status === "out") db.prepare("delete from sessions where person_id = ?").run(id);
}

/**
 * When a party's over, its guests go too: removed and signed out, as anyone removed is. They stay in People and in
 * the party's story, and can be let back in for another one.
 */
export function seeOutPartyGuests() {
  const going = listPeople().filter((p) => p.role === "party" && p.status === "in");
  for (const p of going) updatePerson(p.id, { status: "out" });
  return going;
}

/** Only for someone still knocking: they never got in, so nothing else refers to them. */
export const deletePerson = (id: string) => db.prepare("delete from people where id = ? and status = 'knocking'").run(id);

/**
 * Forget someone for good: their person, their sessions and asks (by cascade), and every log line by them or
 * about them. Their drawings, apps and playlists go first, in index.ts, which knows what depends on them.
 */
export function forgetPerson(id: string) {
  db.prepare(
    `delete from log where person_id = ?
       or json_extract(subject, '$.person.id') = ? or json_extract(subject, '$.by.id') = ? or json_extract(subject, '$.was.id') = ?`,
  ).run(id, id, id, id);
  db.prepare("delete from people where id = ?").run(id);
}

/** Admins left if this person stopped being one: the house always keeps at least one. */
export const otherAdmins = (id: string) =>
  listPeople().filter((p) => p.id !== id && p.role === "admin" && p.status === "in").length;

// Wrong PINs lock that person for a while, longer each time, so four digits can't be guessed
// by trying them all. The lock is per person and per device (`from`, its address): someone else
// trying your PIN can't lock you out of your own phone. Kept in memory: a restart forgives, which
// is fine at home.
const misses = new Map<string, { n: number; until: number }>();
const FREE_TRIES = 5;
/** The longest wait: one try an hour still takes over a year to go through 10,000 PINs. */
const MAX_LOCK_MS = 3_600_000;

export type SignIn = { ok: true; person: Person } | { ok: false; triesLeft: number; lockedUntil: number | null };

export function signIn(id: string, secret: string[], from: string, now = Date.now()): SignIn {
  const row = db.prepare("select * from people where id = ?").get(id) as (PersonRow & { secret: string }) | undefined;
  const key = `${id}@${from}`;
  const m = misses.get(key) ?? { n: 0, until: 0 };
  if (m.until > now) return { ok: false, triesLeft: 0, lockedUntil: m.until };
  if (row && row.status !== "out" && secretMatches(row.secret, secret)) {
    misses.delete(key);
    return { ok: true, person: toPerson(row) };
  }
  m.n++;
  // Five free tries, then a minute's wait, doubling with every miss after that, up to an hour.
  m.until = m.n >= FREE_TRIES ? now + Math.min(MAX_LOCK_MS, 60_000 * 2 ** (m.n - FREE_TRIES)) : 0;
  misses.set(key, m);
  // Tries against made-up ids would otherwise pile up: forget the ones that aren't holding a lock.
  if (misses.size > 10_000) for (const [k, x] of misses) if (x.until <= now && x.n < FREE_TRIES) misses.delete(k);
  return { ok: false, triesLeft: Math.max(0, FREE_TRIES - m.n), lockedUntil: m.until || null };
}

// ── Sessions ──────────────────────────────────────────────────────────────

/** Signed in for a year on a device, unless signed out or removed. */
export const SESSION_DAYS = 365;

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** A new session for this person. Returns the token for the cookie. */
export function startSession(personId: string) {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare("insert into sessions (token, person_id, created_at, seen_at) values (?, ?, ?, ?)").run(tokenHash(token), personId, now, now);
  db.prepare("update people set seen_at = ? where id = ?").run(now, personId);
  return token;
}

export const endSession = (token: string) => db.prepare("delete from sessions where token = ?").run(tokenHash(token));

/** Who this cookie belongs to. Also notes that they're around, at most once a minute. */
export function personFor(token: string | undefined, now = Date.now()): Person | undefined {
  if (!token) return;
  const hash = tokenHash(token);
  const s = db.prepare("select person_id, seen_at from sessions where token = ?").get(hash) as
    | { person_id: string; seen_at: number }
    | undefined;
  if (!s) return;
  if (now - s.seen_at > SESSION_DAYS * 86_400_000) {
    endSession(token);
    return;
  }
  if (now - s.seen_at > 60_000) {
    db.prepare("update sessions set seen_at = ? where token = ?").run(now, hash);
    db.prepare("update people set seen_at = ? where id = ?").run(now, s.person_id);
  }
  const p = getPerson(s.person_id);
  return p && p.status !== "out" ? p : undefined;
}

// ── Invites ───────────────────────────────────────────────────────────────

/** How long an invite works for. */
export const INVITE_MS = 10 * 60_000;

/** How long an invite stays on the panel: long enough to walk over and scan it, short enough not to hold the show up. */
export const INVITE_PANEL_MS = 2 * 60_000;

/** No 0/O or 1/I/L: the code may be read off the panel and typed. */
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** `role`: whoever uses it joins as household ("member"), a guest or a party guest. `onPanelUntil`: while it's on the panel, when it comes off. */
export type Invite = { code: string; madeBy: string | null; expiresAt: number; url: string; onPanelUntil: number | null; role: Role };

type InviteRow = { code: string; made_by: string | null; expires_at: number; url: string; on_panel: number; used_by: string | null; role: Role };
const toInvite = (r: InviteRow, now = Date.now()): Invite => ({
  code: r.code,
  madeBy: r.made_by,
  expiresAt: r.expires_at,
  url: r.url,
  onPanelUntil: r.on_panel > now ? r.on_panel : null,
  role: r.role,
});

/** A new invite. `origin` is the address the admin is using, so the link works where they are. */
export function createInvite(madeBy: string, origin: string, role: InviteRole, now = Date.now()): Invite {
  const code = Array.from(randomBytes(6), (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
  const url = `${origin.replace(/\/$/, "")}/join/${code}`;
  db.prepare("insert into invites (code, made_by, expires_at, url, role) values (?, ?, ?, ?, ?)").run(code, madeBy, now + INVITE_MS, url, role);
  db.prepare("delete from invites where expires_at < ?").run(now - 86_400_000);
  return { code, madeBy, expiresAt: now + INVITE_MS, url, onPanelUntil: null, role };
}

/** An invite that still works: not expired, not used. */
export function getInvite(code: string, now = Date.now()): Invite | undefined {
  const row = db.prepare("select * from invites where code = ?").get(code.toUpperCase()) as InviteRow | undefined;
  return row && !row.used_by && row.expires_at > now ? toInvite(row, now) : undefined;
}

export const useInvite = (code: string, personId: string) =>
  db.prepare("update invites set used_by = ?, on_panel = 0 where code = ?").run(personId, code.toUpperCase());

/** Put a working invite on the panel for INVITE_PANEL_MS, or until it runs out. One at a time: it takes any other's place. */
export function showInvite(code: string, now = Date.now()): Invite | undefined {
  const invite = getInvite(code, now);
  if (!invite) return;
  const until = Math.min(now + INVITE_PANEL_MS, invite.expiresAt);
  db.prepare("update invites set on_panel = 0").run();
  db.prepare("update invites set on_panel = ? where code = ?").run(until, invite.code);
  return { ...invite, onPanelUntil: until };
}

/** Change who a working invite lets in as. The code stays the same, so a QR already on a screen keeps working. */
export function setInviteRole(code: string, role: InviteRole, now = Date.now()): Invite | undefined {
  if (!getInvite(code, now)) return;
  db.prepare("update invites set role = ? where code = ?").run(role, code.toUpperCase());
  return getInvite(code, now);
}

/** Take the invite off the panel (it still works on the phone that shows it). */
export const hideInvite = (code: string) => db.prepare("update invites set on_panel = 0 where code = ?").run(code.toUpperCase());

/** The invite the panel shows now, if any. */
export function panelInvite(now = Date.now()): Invite | undefined {
  const row = db.prepare("select * from invites where on_panel > ? and used_by is null and expires_at > ?").get(now, now) as
    | InviteRow
    | undefined;
  return row && toInvite(row, now);
}

// ── Going easy on the panel ───────────────────────────────────────────────
// Everyone but admins gets so many goes an hour at putting things on the panel and at adding new things,
// so one person (or a phone left in a kid's hands) can't flood the house's feed. Kept in memory, like
// the PIN lockout: a restart forgives.

/**
 * "live": Show now and asking to show. "make": new drawings, apps and playlists, and adding to the show.
 * "photo": new photos, which come an album at a time.
 * "preview": an app's preview as its settings are typed. Each can fetch pages or ask the AI, so it's generous
 * (a clock's preview ticks every 15 s) but not endless.
 */
export type Bucket = "live" | "make" | "photo" | "preview";

/** Goes per hour, by role. Admins have no limit. */
export const LIMITS: Record<Bucket, Record<Exclude<Role, "admin">, number>> = {
  live: { member: 12, guest: 4, party: 4 },
  // Party guests add to the party as they go: more than a guest's asks, as many as a guest makes.
  make: { member: 40, guest: 10, party: 20 },
  // Adding photos comes an album at a time, so it has its own, bigger allowance. A party guest spends two a
  // photo: adding it, and putting it in the party.
  photo: { member: 300, guest: 60, party: 120 },
  preview: { member: 2000, guest: 600, party: 600 },
};

const HOUR = 3_600_000;
const goes = new Map<string, number[]>();

/** Take one of `limit` goes an hour at `key`: null when that's fine, or when the next go frees up. */
function take(key: string, limit: number, now: number): number | null {
  const recent = (goes.get(key) ?? []).filter((t) => t > now - HOUR);
  goes.set(key, recent);
  if (recent.length >= limit) return recent[0] + HOUR;
  recent.push(now);
  return null;
}

/** Spend one go of `bucket`: null when that's fine, or when the next go frees up. */
export function spend(p: Person, bucket: Bucket, now = Date.now()): number | null {
  return p.role === "admin" ? null : take(`${p.id}:${bucket}`, LIMITS[bucket][p.role], now);
}

/** At most this many people knocking at once, and knocks an hour from one device. */
const KNOCKING_MAX = 20;
const KNOCKS_PER_HOUR = 5;

/** Whether someone at `from` (a device's address) may knock now. Knocking needs no one signed in. */
export function mayKnock(from: string, now = Date.now()) {
  const knocking = (db.prepare("select count(*) as n from people where status = 'knocking'").get() as { n: number }).n;
  return knocking < KNOCKING_MAX && take(`knock:${from}`, KNOCKS_PER_HOUR, now) === null;
}

// ── The log ───────────────────────────────────────────────────────────────

/** Something that was acted on, with its name at the time, so the log still reads after it's gone. */
export type Named = { kind: string; id: string; name: string };

export type LogEntry = { id: number; at: number; personId: string | null; verb: string; subject: Record<string, unknown> };

/** How long the log keeps things. */
const LOG_DAYS = 90;

/** Repeating the same thing to the same subject within this long updates one entry, not many. */
const SAME_MS = 15 * 60_000;

/**
 * Note that `personId` did `verb` to `subject`, e.g. note(me, "added-to-show", { item }). `settling` names subject
 * keys that may change between repeats and still be the same thing someone did, like the hours of the night while
 * they're being set: the entry keeps the last value.
 */
export function note(personId: string | null, verb: string, subject: Record<string, unknown> = {}, now = Date.now(), settling: string[] = []) {
  const json = JSON.stringify(subject);
  const last = db.prepare("select id, at, person_id, verb, subject from log order by id desc limit 1").get() as
    | { id: number; at: number; person_id: string | null; verb: string; subject: string }
    | undefined;
  // Moving sliders or redrawing in a row is one thing someone did, not twenty.
  if (last && last.person_id === personId && last.verb === verb && now - last.at < SAME_MS && sameSubject(last.subject, subject, settling)) {
    db.prepare("update log set at = ?, subject = ? where id = ?").run(now, json, last.id);
  } else {
    db.prepare("insert into log (at, person_id, verb, subject) values (?, ?, ?, ?)").run(now, personId, verb, json);
  }
}

/** Same things acted on, going by ids: a rename in between still counts as the same. */
function sameSubject(stored: string, subject: Record<string, unknown>, settling: string[] = []) {
  const ids = (s: Record<string, unknown>) =>
    JSON.stringify(
      Object.entries(s)
        .filter(([k]) => !settling.includes(k))
        .map(([k, v]) => [k, v && typeof v === "object" && "id" in v ? (v as Named).id : v]),
    );
  return ids(JSON.parse(stored)) === ids(subject);
}

/** The log, newest first: `limit` entries before `before` (an entry id), optionally one person's. */
/** Newest first. `verbs` keeps only those kinds of thing, for the log's topic filter. */
export function listLog({ limit = 50, before, personId, verbs }: { limit?: number; before?: number; personId?: string; verbs?: string[] } = {}): LogEntry[] {
  const where = [before ? "id < ?" : "", personId ? "person_id = ?" : "", verbs?.length ? `verb in (${verbs.map(() => "?").join(", ")})` : ""].filter(Boolean);
  const args = [before, personId, ...(verbs ?? [])].filter((x) => x !== undefined && x !== null && x !== "") as (string | number)[];
  const rows = db
    .prepare(`select * from log ${where.length ? `where ${where.join(" and ")}` : ""} order by id desc limit ?`)
    .all(...args, Math.min(200, Math.max(1, limit))) as { id: number; at: number; person_id: string | null; verb: string; subject: string }[];
  return rows.map((r) => ({ id: r.id, at: r.at, personId: r.person_id, verb: r.verb, subject: JSON.parse(r.subject) }));
}

/** Forget what's older than LOG_DAYS: now, then once a day. */
function trimLog() {
  db.prepare("delete from log where at < ?").run(Date.now() - LOG_DAYS * 86_400_000);
}
trimLog();
setInterval(trimLog, 86_400_000).unref();
