import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Scene } from "@papershow/scene";
import { awayUntil, DEFAULT_SLEEP, sameSource, type Days, type Hourly, type Live, type Party, type Program, type Sleep, type Slide, type Source } from "./schedule.ts";

const path = process.env.DB ?? new URL("../data/imagegen.db", import.meta.url).pathname;
mkdirSync(dirname(path), { recursive: true });

export const db = new DatabaseSync(path);
db.exec(`
  pragma journal_mode = wal;
  pragma foreign_keys = on;

  create table if not exists images (
    id         text primary key,
    name       text not null,
    scene      text not null,
    png        blob not null,  -- colour, as drawn (a JPEG when it has a photo)
    mono       blob not null,  -- 1-bit PNG, what the panel shows
    bin        blob not null,  -- 1bpp packed, straight to the EPD
    updated_at integer not null
  );

  -- An app instance: one of the built-in apps (clock, crypto, …) with its settings.
  create table if not exists apps (
    id         text primary key,
    kind       text not null,
    name       text not null,
    config     text not null,
    updated_at integer not null
  );

  create table if not exists settings (key text primary key, value text not null);
`);

// Playlists play one after another, in position order, then loop. Disabled ones are skipped.
db.exec(`
  create table if not exists playlists (
    id       text primary key,
    name     text not null,
    position integer not null,
    enabled  integer not null default 1
  );
`);

// A slide shows exactly one source: a drawing or an app. Deleting either removes its slides.
const SLIDES = `
  create table slides (
    id          text primary key,
    playlist_id text references playlists(id) on delete cascade,
    image_id   text references images(id) on delete cascade,
    app_id     text references apps(id) on delete cascade,
    position   integer not null,
    duration_s integer not null default 900,      -- whole minutes, at least one
    enabled    integer not null default 1,
    days       text not null default '0123456',  -- 0 = Sunday
    start      text,                              -- 'HH:MM', null = all day
    "end"      text,
    check ((image_id is null) <> (app_id is null))
  )`;

const slideCols = (db.prepare("pragma table_info(slides)").all() as { name: string }[]).map((c) => c.name);
if (!slideCols.length) {
  db.exec(SLIDES);
} else if (!slideCols.includes("app_id")) {
  // Slides used to point only at images. Keep a copy of the database, then move them over.
  db.exec(`vacuum into '${path}.before-apps-${Date.now()}.bak'`);
  db.exec("begin");
  db.exec(SLIDES.replace("create table slides", "create table slides_next"));
  db.exec(`insert into slides_next (id, image_id, position, duration_s, enabled, days, start, "end")
           select id, image_id, position, duration_s, enabled, days, start, "end" from slides`);
  db.exec("drop table slides");
  db.exec("alter table slides_next rename to slides");
  db.exec("commit");
}

// There is always at least one playlist; clips from before playlists existed move into it.
if (!(db.prepare("select count(*) as n from playlists").get() as { n: number }).n) {
  db.prepare("insert into playlists (id, name, position) values (?, 'Main', 0)").run(crypto.randomUUID().slice(0, 8));
}
if (!(db.prepare("pragma table_info(slides)").all() as { name: string }[]).some((c) => c.name === "playlist_id")) {
  db.exec("alter table slides add column playlist_id text references playlists(id) on delete cascade");
}
db.prepare("update slides set playlist_id = (select id from playlists order by position limit 1) where playlist_id is null").run();

db.exec(`
  create table if not exists show (
    id          text primary key,
    position    integer not null,
    playlist_id text references playlists(id) on delete cascade,
    image_id    text references images(id) on delete cascade,
    app_id      text references apps(id) on delete cascade,
    duration_s  integer not null default 900,
    enabled     integer not null default 1,
    check ((playlist_id is not null) + (image_id is not null) + (app_id is not null) = 1)
  );
`);

// A single image or app can repeat on the clock (every 15, 30, 60… minutes) instead of taking a turn in the loop.
if (!(db.prepare("pragma table_info(show)").all() as { name: string }[]).some((c) => c.name === "every_m"))
  db.exec("alter table show add column every_m integer");
// Times of day an entry plays at instead of taking turns, as a JSON array of 'HH:MM'.
if (!(db.prepare("pragma table_info(show)").all() as { name: string }[]).some((c) => c.name === "at_times"))
  db.exec("alter table show add column at_times text");
// The colour someone picked for an entry, to tell it apart on the program's day bar; null picks one by position.
if (!(db.prepare("pragma table_info(show)").all() as { name: string }[]).some((c) => c.name === "color"))
  db.exec("alter table show add column color text");

// First run with the show: what used to play (every enabled playlist, in order) becomes it.
if (!db.prepare("select 1 from settings where key = 'show-ready'").get()) {
  db.exec("begin");
  const add = db.prepare("insert into show (id, position, playlist_id) values (?, ?, ?)");
  (db.prepare("select id from playlists where enabled = 1 order by position").all() as { id: string }[]).forEach((p, i) =>
    add.run(crypto.randomUUID().slice(0, 8), i, p.id),
  );
  db.prepare("insert into settings (key, value) values ('show-ready', '1')").run();
  db.exec("commit");
}

// The program: times of day, each with its own show entries, for weekdays and for the weekend.
db.exec(`
  create table if not exists blocks (
    id    text primary key,
    days  text not null check (days in ('weekdays', 'weekend')),
    start text not null                              -- 'HH:MM'
  );
`);
if (!(db.prepare("pragma table_info(show)").all() as { name: string }[]).some((c) => c.name === "block_id"))
  db.exec("alter table show add column block_id text references blocks(id) on delete cascade");
// The show from before the program becomes all day, every day. Cut-ins and set times are gone: the blocks do that now.
if (!(db.prepare("select count(*) as n from blocks").get() as { n: number }).n) {
  const id = crypto.randomUUID().slice(0, 8);
  db.exec("begin");
  db.prepare("insert into blocks (id, days, start) values (?, 'weekdays', '06:00')").run(id);
  db.prepare("update show set block_id = ?, every_m = null, at_times = null where block_id is null").run(id);
  db.exec("commit");
}
// The day starts at 6:00, so a lone block made at midnight by an early version of this moves there. Alone, its time
// isn't shown and only decides where the loop starts.
db.exec(`update blocks set start = '06:00' where start = '00:00' and (select count(*) from blocks b where b.days = blocks.days) = 1`);

// Who made each drawing, app and playlist. Anyone can use them; only the maker or an admin changes them.
for (const table of ["images", "apps", "playlists"])
  if (!(db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).some((c) => c.name === "made_by"))
    db.exec(`alter table ${table} add column made_by text`);

// A saved image is a drawing (from Draw) or a photo (from Photos: a picture, framed for the panel, with nothing drawn on it).
if (!(db.prepare("pragma table_info(images)").all() as { name: string }[]).some((c) => c.name === "kind"))
  db.exec("alter table images add column kind text not null default 'drawing'");
// When a photo was taken, for "on this day": kept beside the scene so a list doesn't have to open every photo.
if (!(db.prepare("pragma table_info(images)").all() as { name: string }[]).some((c) => c.name === "taken_at"))
  db.exec("alter table images add column taken_at integer");

/** The first person in the house becomes the maker of everything made before there were people. */
export function claimAll(personId: string) {
  for (const table of ["images", "apps", "playlists"]) db.prepare(`update ${table} set made_by = ? where made_by is null`).run(personId);
}

/** What a saved image is: a drawing, a photo in the Photos library, or a drawing or photo made at a party, which stays with it. */
export type ImageType = "drawing" | "photo" | "party";
export type ImageMeta = { id: string; name: string; updatedAt: number; madeBy: string | null; kind: ImageType; takenAt: number | null };
export type ImageKind = "png" | "mono" | "bin";

const META = "select id, name, updated_at as updatedAt, made_by as madeBy, kind, taken_at as takenAt from images";

/** The house's drawings and photos. What was made at a party isn't among them: it's in that party's story. */
export function listImages(): ImageMeta[] {
  return db.prepare(`${META} where kind != 'party' order by updated_at desc`).all() as ImageMeta[];
}

export function getImageMeta(id: string): ImageMeta | undefined {
  return db.prepare(`${META} where id = ?`).get(id) as ImageMeta | undefined;
}

export function getScene(id: string): Scene | undefined {
  const row = db.prepare("select scene from images where id = ?").get(id) as { scene: string } | undefined;
  return row && JSON.parse(row.scene);
}

export function getImageFile(id: string, kind: ImageKind) {
  // kind is checked by the caller against a fixed list, so it is safe to interpolate.
  return db.prepare(`select ${kind} as data, updated_at as updatedAt from images where id = ?`).get(id) as
    | { data: Uint8Array<ArrayBuffer>; updatedAt: number }
    | undefined;
}

/** A scene's `takenAt` if it's a sensible time (it comes from the browser), else null. */
const takenOf = (s: Scene) => (Number.isFinite(s.takenAt) && s.takenAt! > 0 ? Math.round(s.takenAt!) : null);

/**
 * Save a drawing or a photo. `madeBy` and `kind` are kept from the first save: redrawing someone's drawing doesn't
 * make it yours, and a photo stays a photo.
 */
export function putImage(scene: Scene, files: Record<ImageKind, Uint8Array>, madeBy: string, kind: ImageType = "drawing") {
  db.prepare(
    `insert into images (id, name, scene, png, mono, bin, updated_at, made_by, kind, taken_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(id) do update set name = excluded.name, scene = excluded.scene, png = excluded.png,
       mono = excluded.mono, bin = excluded.bin, updated_at = excluded.updated_at, taken_at = excluded.taken_at`,
  ).run(scene.id, scene.name, JSON.stringify(scene), files.png, files.mono, files.bin, scene.updatedAt, madeBy, kind, takenOf(scene));
}

export function deleteImage(id: string) {
  db.prepare("delete from images where id = ?").run(id);
  const live = getLive();
  unpin({ kind: "image", id });
}

/** If this source is pinned to /live, go back to the sequence. */
function unpin(source: Source) {
  const live = getLive();
  if (live.mode === "pin" && sameSource(live.source, source)) setLive({ mode: "rotate" });
}

// ── Apps ─────────────────────────────────────────────────────────────────

export type AppRow = { id: string; kind: string; name: string; config: Record<string, unknown>; updatedAt: number; madeBy: string | null };

type AppDbRow = { id: string; kind: string; name: string; config: string; updated_at: number; made_by: string | null };
const toApp = (r: AppDbRow): AppRow => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  config: JSON.parse(r.config),
  updatedAt: r.updated_at,
  madeBy: r.made_by,
});

export function listApps(): AppRow[] {
  return (db.prepare("select * from apps order by updated_at desc").all() as AppDbRow[]).map(toApp);
}

export function getApp(id: string): AppRow | undefined {
  const row = db.prepare("select * from apps where id = ?").get(id) as AppDbRow | undefined;
  return row && toApp(row);
}

export function createApp(kind: string, name: string, config: Record<string, unknown>, madeBy: string): AppRow {
  const id = crypto.randomUUID().slice(0, 8);
  db.prepare("insert into apps (id, kind, name, config, updated_at, made_by) values (?, ?, ?, ?, ?, ?)").run(
    id,
    kind,
    name,
    JSON.stringify(config),
    Date.now(),
    madeBy,
  );
  return getApp(id)!;
}

export function updateApp(id: string, patch: { name?: string; config?: Record<string, unknown> }) {
  const app = getApp(id);
  if (!app) return;
  db.prepare("update apps set name = ?, config = ?, updated_at = ? where id = ?").run(
    patch.name ?? app.name,
    JSON.stringify(patch.config ?? app.config),
    Date.now(),
    id,
  );
}

export function deleteApp(id: string) {
  db.prepare("delete from apps where id = ?").run(id);
  unpin({ kind: "app", id });
}

type SlideRow = {
  id: string;
  playlist_id: string;
  image_id: string | null;
  app_id: string | null;
  position: number;
  duration_s: number;
  enabled: number;
  days: string;
  start: string | null;
  end: string | null;
};

const toSlide = (r: SlideRow): Slide => ({
  id: r.id,
  playlistId: r.playlist_id,
  source: r.app_id ? { kind: "app", id: r.app_id } : { kind: "image", id: r.image_id! },
  position: r.position,
  durationS: r.duration_s,
  enabled: !!r.enabled,
  days: [...r.days].map(Number),
  start: r.start,
  end: r.end,
});

/** Every slide, in play order: playlist by playlist, then position within it. */
export function listSlides(): Slide[] {
  return (
    db
      .prepare("select s.* from slides s join playlists p on p.id = s.playlist_id order by p.position, s.position")
      .all() as SlideRow[]
  ).map(toSlide);
}

/**
 * What actually plays: each block's entries in order, each expanded into clips.
 * A playlist entry contributes its clips; an image or app entry is one clip.
 * Keys are "<entry>~<clip>" so the same playlist can appear twice.
 */
export function program(): Program {
  const clips = listSlides();
  const show = listShow();
  const blocks = listBlocks().map((b) => ({ ...b, slides: blockSlides(show.filter((e) => e.blockId === b.id), clips) }));
  return { blocks, weekendOwn: weekendOwn(), hourly: hourly(), party: partyProgram() };
}

/**
 * The time check on the hour: on unless switched off, with the clock picked, or else the first clock there is.
 * `durationS` is how long it stays on.
 */
export type TimeCheck = { on: boolean; appId: string | null; durationS: number };

const DEFAULT_TIME_CHECK: TimeCheck = { on: true, appId: null, durationS: 60 };

// The apps that can be the time check. Kept here rather than read from the app list, which imports this file.
const CLOCKS = ["clock", "aiclock"];

/** The time check as set, with `appId` filled in with the clock it will show (null when there's no clock). */
export function getTimeCheck(): TimeCheck {
  const row = db.prepare("select value from settings where key = 'time-check'").get() as { value: string } | undefined;
  const set: TimeCheck = row ? { ...DEFAULT_TIME_CHECK, ...JSON.parse(row.value) } : DEFAULT_TIME_CHECK;
  const clocks = listApps().filter((a) => CLOCKS.includes(a.kind));
  // A deleted clock falls back to the first one left.
  const app = clocks.find((a) => a.id === set.appId) ?? clocks[0];
  return { ...set, appId: app?.id ?? null };
}

export function setTimeCheck(patch: Partial<TimeCheck>) {
  const cur = getTimeCheck();
  const app = patch.appId ? getApp(patch.appId) : undefined;
  const next: TimeCheck = {
    on: typeof patch.on === "boolean" ? patch.on : cur.on,
    appId: app && CLOCKS.includes(app.kind) ? app.id : cur.appId,
    durationS: cur.durationS,
  };
  db.prepare("insert into settings (key, value) values ('time-check', ?) on conflict(key) do update set value = excluded.value").run(
    JSON.stringify(next),
  );
}

function hourly(): Hourly | null {
  const t = getTimeCheck();
  return t.on && t.appId ? { source: { kind: "app", id: t.appId }, durationS: t.durationS } : null;
}

function blockSlides(entries: ShowEntry[], clips: Slide[]): Slide[] {
  return entries
    .filter((e) => e.enabled)
    .flatMap((e): Slide[] =>
      e.playlistId
        ? clips
            .filter((c) => c.playlistId === e.playlistId)
            .map((c) => ({ ...c, id: `${e.id}~${c.id}`, entryId: e.id, clipId: c.id }))
        : [
            {
              id: e.id,
              entryId: e.id,
              clipId: null,
              playlistId: null,
              source: e.source!,
              position: e.position,
              durationS: e.durationS,
              enabled: true,
              days: [0, 1, 2, 3, 4, 5, 6],
              start: null,
              end: null,
            },
          ],
    );
}

// ── The show ───────────────────────────────────────────────────────────────
// What runs: in each block of the program, playlists, images and apps, top to bottom, then again.

export type ShowEntry = {
  id: string;
  /** The block of the program it plays in. */
  blockId: string;
  position: number;
  playlistId: string | null;
  /** For a single image or app. */
  source: Source | null;
  /** How long a single image or app stays on; playlists use their clips' lengths. */
  durationS: number;
  enabled: boolean;
  /** One of `ENTRY_COLORS`, or null for one picked by its place in the block. */
  color: string | null;
};

/** The colours an entry can have. Blue is left out: on the day bar it means the panel is asleep. */
export const ENTRY_COLORS = ["yellow", "sage", "orange", "pink", "lilac", "teal", "sand", "lime", "plum"] as const;

type ShowRow = {
  id: string;
  block_id: string;
  position: number;
  playlist_id: string | null;
  image_id: string | null;
  app_id: string | null;
  duration_s: number;
  enabled: number;
  color: string | null;
};

export function listShow(): ShowEntry[] {
  return (db.prepare("select * from show where block_id is not null order by position").all() as ShowRow[]).map((r) => ({
    id: r.id,
    blockId: r.block_id,
    position: r.position,
    playlistId: r.playlist_id,
    source: r.image_id ? { kind: "image", id: r.image_id } : r.app_id ? { kind: "app", id: r.app_id } : null,
    durationS: r.duration_s,
    enabled: !!r.enabled,
    color: r.color,
  }));
}

/** Add a playlist, image or app to a block of the program at `at` (end by default). */
export function addShowEntry(blockId: string, what: { playlistId: string } | { source: Source }, at?: number, durationS = DEFAULT_CLIP_S) {
  const id = crypto.randomUUID().slice(0, 8);
  const ids = listShow()
    .filter((e) => e.blockId === blockId)
    .map((e) => e.id);
  ids.splice(at ?? ids.length, 0, id);
  const src = "source" in what ? what.source : null;
  db.exec("begin");
  db.prepare("insert into show (id, block_id, position, playlist_id, image_id, app_id, duration_s) values (?, ?, ?, ?, ?, ?, ?)").run(
    id,
    blockId,
    ids.length,
    "playlistId" in what ? what.playlistId : null,
    src?.kind === "image" ? src.id : null,
    src?.kind === "app" ? src.id : null,
    durationS,
  );
  reorderShow(ids, false);
  db.exec("commit");
  return id;
}

export function updateShowEntry(id: string, patch: { durationS?: number; enabled?: boolean; color?: string | null }) {
  if (patch.color !== undefined)
    db.prepare("update show set color = ? where id = ?").run((ENTRY_COLORS as readonly string[]).includes(patch.color ?? "") ? patch.color : null, id);
  if (typeof patch.durationS === "number" && Number.isFinite(patch.durationS))
    db.prepare("update show set duration_s = ? where id = ?").run(Math.max(1, Math.round(patch.durationS / 60)) * 60, id);
  if (patch.enabled !== undefined) db.prepare("update show set enabled = ? where id = ?").run(patch.enabled ? 1 : 0, id);
}

// ── The program's blocks ───────────────────────────────────────────────────

export type BlockRow = { id: string; days: Days; start: string };

export const listBlocks = () => db.prepare("select id, days, start from blocks order by days, start").all() as BlockRow[];
export const getBlock = (id: string) => listBlocks().find((b) => b.id === id);

/** "8:00" → "08:00"; null when it isn't a time of day. */
export function cleanTime(t: string) {
  const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

const taken = (days: Days, start: string, except = "") =>
  listBlocks().some((b) => b.days === days && b.start === start && b.id !== except);

/** A new, empty block. Null when the time is bad or that day already has a block then. */
export function addBlock(days: Days, start: string): BlockRow | null {
  const at = cleanTime(start);
  if (!at || taken(days, at)) return null;
  const id = crypto.randomUUID().slice(0, 8);
  db.prepare("insert into blocks (id, days, start) values (?, ?, ?)").run(id, days, at);
  return getBlock(id)!;
}

/** Move a block to another time. False when the time is bad or taken. */
export function moveBlock(id: string, start: string) {
  const b = getBlock(id);
  const at = cleanTime(start);
  if (!b || !at || taken(b.days, at, id)) return false;
  db.prepare("update blocks set start = ? where id = ?").run(at, id);
  return true;
}

/** Deletes the block and everything in it. */
export const deleteBlock = (id: string) => db.prepare("delete from blocks where id = ?").run(id);

/** Whether the weekend has its own blocks; otherwise it plays the weekdays'. */
export const weekendOwn = () => !!db.prepare("select 1 from settings where key = 'weekend-own' and value = '1'").get();

/**
 * Plan the weekend on its own, starting from a copy of the weekdays, or go back to the weekdays' plan for every day
 * (the weekend's blocks are deleted).
 */
export function setWeekendOwn(own: boolean) {
  if (own === weekendOwn()) return;
  db.exec("begin");
  db.prepare("delete from blocks where days = 'weekend'").run();
  if (own) {
    const show = db.prepare("select * from show where block_id is not null order by position").all() as ShowRow[];
    const copy = db.prepare(
      "insert into show (id, block_id, position, playlist_id, image_id, app_id, duration_s, enabled, color) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const b of listBlocks().filter((x) => x.days === "weekdays")) {
      const id = crypto.randomUUID().slice(0, 8);
      db.prepare("insert into blocks (id, days, start) values (?, 'weekend', ?)").run(id, b.start);
      for (const e of show.filter((r) => r.block_id === b.id))
        copy.run(crypto.randomUUID().slice(0, 8), id, e.position, e.playlist_id, e.image_id, e.app_id, e.duration_s, e.enabled, e.color);
    }
  }
  db.prepare("insert into settings (key, value) values ('weekend-own', ?) on conflict(key) do update set value = excluded.value").run(own ? "1" : "0");
  db.exec("commit");
}

export function reorderShow(ids: string[], transaction = true) {
  const stmt = db.prepare("update show set position = ? where id = ?");
  if (transaction) db.exec("begin");
  ids.forEach((id, i) => stmt.run(i, id));
  if (transaction) db.exec("commit");
}

export const deleteShowEntry = (id: string) => db.prepare("delete from show where id = ?").run(id);

// ── Playlists ──────────────────────────────────────────────────────────────

/** A playlist is made of images and/or apps. Whether and when it plays is up to the show. */
export type Playlist = { id: string; name: string; position: number; enabled: boolean; madeBy: string | null };

export function listPlaylists(): Playlist[] {
  return (
    db.prepare("select id, name, position, enabled, made_by as madeBy from playlists order by position").all() as (Omit<Playlist, "enabled"> & {
      enabled: number;
    })[]
  ).map((p) => ({ ...p, enabled: !!p.enabled }));
}

export const getPlaylist = (id: string) => listPlaylists().find((p) => p.id === id);

export function createPlaylist(name: string, madeBy: string): Playlist {
  const id = crypto.randomUUID().slice(0, 8);
  const { next } = db.prepare("select coalesce(max(position), -1) + 1 as next from playlists").get() as { next: number };
  db.prepare("insert into playlists (id, name, position, made_by) values (?, ?, ?, ?)").run(id, name, next, madeBy);
  return getPlaylist(id)!;
}

export function updatePlaylist(id: string, patch: { name?: string; enabled?: boolean }) {
  const p = getPlaylist(id);
  if (!p) return;
  db.prepare("update playlists set name = ?, enabled = ? where id = ?").run(
    patch.name?.trim() || p.name,
    (patch.enabled ?? p.enabled) ? 1 : 0,
    id,
  );
}

export function reorderPlaylists(ids: string[]) {
  const stmt = db.prepare("update playlists set position = ? where id = ?");
  db.exec("begin");
  ids.forEach((id, i) => stmt.run(i, id));
  db.exec("commit");
}

/** Deletes the playlist, its clips, and its places in the show. */
export function deletePlaylist(id: string) {
  db.prepare("delete from playlists where id = ?").run(id);
}

/** New clips run a quarter of an hour; drag the edge to change it. */
const DEFAULT_CLIP_S = 15 * 60;

/** Add a clip to a playlist at `at` (end by default), shifting the rest along. */
export function addSlide(source: Source, playlistId: string, at?: number, durationS = DEFAULT_CLIP_S): Slide {
  const id = crypto.randomUUID().slice(0, 8);
  const ids = listSlides()
    .filter((s) => s.playlistId === playlistId)
    .map((s) => s.id);
  ids.splice(at ?? ids.length, 0, id);
  db.exec("begin");
  db.prepare("insert into slides (id, playlist_id, image_id, app_id, position, duration_s) values (?, ?, ?, ?, ?, ?)").run(
    id,
    playlistId,
    source.kind === "image" ? source.id : null,
    source.kind === "app" ? source.id : null,
    ids.length,
    durationS,
  );
  reorderSlides(ids, false);
  db.exec("commit");
  return listSlides().find((s) => s.id === id)!;
}

export function updateSlide(id: string, patch: Partial<Omit<Slide, "id" | "source" | "position" | "playlistId">>) {
  const cols: string[] = [];
  const vals: (string | number | null)[] = [];
  // The body is whatever the request sent: anything that isn't the right shape is left as it was.
  const time = (t: unknown) => (t === null ? null : typeof t === "string" ? (cleanTime(t) ?? undefined) : undefined);
  if (typeof patch.durationS === "number" && Number.isFinite(patch.durationS))
    cols.push("duration_s = ?"), vals.push(Math.max(1, Math.round(patch.durationS / 60)) * 60);
  if (patch.enabled !== undefined) cols.push("enabled = ?"), vals.push(patch.enabled ? 1 : 0);
  if (Array.isArray(patch.days) && patch.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))
    cols.push("days = ?"), vals.push([...new Set(patch.days)].sort().join(""));
  const start = time(patch.start);
  if (start !== undefined) cols.push("start = ?"), vals.push(start);
  const end = time(patch.end);
  if (end !== undefined) cols.push('"end" = ?'), vals.push(end);
  if (!cols.length) return;
  db.prepare(`update slides set ${cols.join(", ")} where id = ?`).run(...vals, id);
}

export function reorderSlides(ids: string[], transaction = true) {
  const stmt = db.prepare("update slides set position = ? where id = ?");
  if (transaction) db.exec("begin");
  ids.forEach((id, i) => stmt.run(i, id));
  if (transaction) db.exec("commit");
}

/** Take a drawing or app out of every playlist and every block of the show. */
export function unschedule(src: Source) {
  const col = src.kind === "image" ? "image_id" : "app_id";
  db.prepare(`delete from slides where ${col} = ?`).run(src.id);
  db.prepare(`delete from show where ${col} = ?`).run(src.id);
}

export function deleteSlide(id: string) {
  db.prepare("delete from slides where id = ?").run(id);
}

export function getLive(): Live {
  const row = db.prepare("select value from settings where key = 'live'").get() as { value: string } | undefined;
  if (!row) return { mode: "rotate" };
  const live = JSON.parse(row.value);
  // Pins saved before apps existed held an image id directly.
  if (live.mode === "pin" && live.imageId) return { mode: "pin", source: { kind: "image", id: live.imageId } };
  // A Show now whose time is up: the playlists are back.
  if (live.mode === "pin" && live.until && live.until <= Date.now()) return { mode: "rotate" };
  return live;
}

export function setLive(live: Live) {
  db.prepare("insert into settings (key, value) values ('live', ?) on conflict(key) do update set value = excluded.value").run(
    JSON.stringify(live),
  );
}

export function getSleep(): Sleep {
  const row = db.prepare("select value from settings where key = 'sleep'").get() as { value: string } | undefined;
  const sleep: Sleep = row ? { ...DEFAULT_SLEEP, ...JSON.parse(row.value) } : DEFAULT_SLEEP;
  // Away ends by itself on its date; the switch follows, so the Dashboard doesn't show it still on.
  return sleep.away && awayUntil(sleep) === null ? { ...sleep, away: false, back: null } : sleep;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function setSleep(patch: Partial<Sleep>) {
  const cur = getSleep();
  const next: Sleep = {
    enabled: patch.enabled ?? cur.enabled,
    start: patch.start && HHMM.test(patch.start) ? patch.start : cur.start,
    end: patch.end && HHMM.test(patch.end) ? patch.end : cur.end,
    screen: patch.screen && ["moon", "blank", "off"].includes(patch.screen) ? patch.screen : cur.screen,
    away: patch.away ?? cur.away,
    back: patch.back === undefined ? cur.back : patch.back && DATE.test(patch.back) ? patch.back : null,
  };
  db.prepare("insert into settings (key, value) values ('sleep', ?) on conflict(key) do update set value = excluded.value").run(
    JSON.stringify(next),
  );
  return next;
}

// ── Parties ────────────────────────────────────────────────────────────────
// A party plays its own loop in place of the program: a copy of the playlist it started from, and whatever people
// add while it's on. Drawings and photos made there stay with it (images of kind 'party'), out of the house's
// library, and the party keeps them as its story once it's over.

db.exec(`
  create table if not exists parties (
    id          text primary key,
    playlist_id text,
    started_at  integer not null,
    anchor      integer not null,
    ends_at     integer not null,
    ended_at    integer,
    started_by  text
  );
  create table if not exists party_clips (
    id          text primary key,
    party_id    text not null references parties(id) on delete cascade,
    position    integer not null,
    image_id    text,
    app_id      text,
    duration_s  integer not null,
    added_by    text,
    added_at    integer not null
  );
`);

// When a clip was last put up to play next (added, or picked to play again): what's queued after the clip on air
// goes in that order. Parties from before this have it as when they were added.
if (!(db.prepare("pragma table_info(party_clips)").all() as { name: string }[]).some((c) => c.name === "queued_at")) {
  db.exec("alter table party_clips add column queued_at integer");
  db.exec("update party_clips set queued_at = added_at");
}

// What actually went on air at each party, as it happened: the loop moves as things are slipped in, so it can't
// be worked out afterwards.
db.exec(`
  create table if not exists party_plays (
    party_id text not null references parties(id) on delete cascade,
    at       integer not null,
    clip_id  text not null,
    image_id text,
    app_id   text,
    primary key (party_id, at)
  );
`);

/** One turn on air at a party: which clip, what it showed, and when it went on. */
export type PartyPlay = { clipId: string; source: Source; at: number };

/** Note a turn going on air. The same turn noted again (every look at /live) is one turn. */
export function recordPlay(partyId: string, clipId: string, source: Source, at: number) {
  db.prepare("insert or ignore into party_plays (party_id, at, clip_id, image_id, app_id) values (?, ?, ?, ?, ?)").run(
    partyId,
    at,
    clipId,
    source.kind === "image" ? source.id : null,
    source.kind === "app" ? source.id : null,
  );
}

/** What went on air at a party, in order. */
export function partyPlays(partyId: string): PartyPlay[] {
  return (
    db.prepare("select clip_id, image_id, app_id, at from party_plays where party_id = ? order by at").all(partyId) as {
      clip_id: string;
      image_id: string | null;
      app_id: string | null;
      at: number;
    }[]
  ).map((r) => ({ clipId: r.clip_id, at: r.at, source: r.app_id ? { kind: "app", id: r.app_id } : { kind: "image", id: r.image_id! } }));
}

/** A party, as kept: `endedAt` once it's over (ended early, or at `endsAt`). */
export type PartyRow = { id: string; playlistId: string | null; startedAt: number; anchor: number; endsAt: number; endedAt: number | null; startedBy: string | null };

/**
 * One thing in a party's loop. `addedBy` is null for what came from the playlist it started with. `queuedAt`: when
 * it was last put up to play next.
 */
export type PartyClip = { id: string; partyId: string; position: number; source: Source; durationS: number; addedBy: string | null; addedAt: number; queuedAt: number };

const PARTY_ROW = "select id, playlist_id as playlistId, started_at as startedAt, anchor, ends_at as endsAt, ended_at as endedAt, started_by as startedBy from parties";

/** The party going on at `now`, if there is one. */
export function currentParty(now = Date.now()): PartyRow | undefined {
  return db.prepare(`${PARTY_ROW} where ended_at is null and started_at <= ? and ends_at > ? order by started_at desc limit 1`).get(now, now) as PartyRow | undefined;
}

export const getPartyRow = (id: string) => db.prepare(`${PARTY_ROW} where id = ?`).get(id) as PartyRow | undefined;

/** Every party, newest first, once it's over. */
export const pastParties = (now = Date.now()) =>
  db.prepare(`${PARTY_ROW} where ended_at is not null or ends_at <= ? order by started_at desc`).all(now) as PartyRow[];

/** Parties whose time ran out and haven't been wrapped up yet. */
export const unwrappedParties = (now = Date.now()) =>
  db.prepare(`${PARTY_ROW} where ended_at is null and ends_at <= ?`).all(now) as PartyRow[];

type PartyClipRow = { id: string; party_id: string; position: number; image_id: string | null; app_id: string | null; duration_s: number; added_by: string | null; added_at: number; queued_at: number };

export function partyClips(partyId: string): PartyClip[] {
  return (db.prepare("select * from party_clips where party_id = ? order by position").all(partyId) as PartyClipRow[]).map((r) => ({
    id: r.id,
    partyId: r.party_id,
    position: r.position,
    source: r.app_id ? { kind: "app", id: r.app_id } : { kind: "image", id: r.image_id! },
    durationS: r.duration_s,
    addedBy: r.added_by,
    addedAt: r.added_at,
    queuedAt: r.queued_at,
  }));
}

/** Start a party at `now`, with a copy of what plays in `playlistId` (when there's one) to begin with. */
export function startParty(playlistId: string | null, now: number, endsAt: number, by: string): PartyRow {
  const id = crypto.randomUUID().slice(0, 8);
  db.exec("begin");
  db.prepare("insert into parties (id, playlist_id, started_at, anchor, ends_at, started_by) values (?, ?, ?, ?, ?, ?)").run(id, playlistId, now, now, endsAt, by);
  const seed = playlistId ? listSlides().filter((s) => s.playlistId === playlistId && s.enabled) : [];
  seed.forEach((s, i) => insertPartyClip(id, i, s.source, s.durationS, null, now));
  db.exec("commit");
  return getPartyRow(id)!;
}

function insertPartyClip(partyId: string, position: number, source: Source, durationS: number, by: string | null, at: number) {
  const id = crypto.randomUUID().slice(0, 8);
  db.prepare(
    "insert into party_clips (id, party_id, position, image_id, app_id, duration_s, added_by, added_at, queued_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, partyId, position, source.kind === "image" ? source.id : null, source.kind === "app" ? source.id : null, durationS, by, at, at);
  return id;
}

/** Put `source` in the party's loop at `at`, moving the rest along. */
export function addPartyClip(partyId: string, at: number, source: Source, durationS: number, by: string, now: number) {
  db.prepare("update party_clips set position = position + 1 where party_id = ? and position >= ?").run(partyId, at);
  return insertPartyClip(partyId, at, source, durationS, by, now);
}

/** Move one of the party's clips to `at` in its loop (counted without it), the rest closing up around it, at `now`. */
export function movePartyClip(partyId: string, clipId: string, at: number, now: number) {
  const ids = partyClips(partyId)
    .map((c) => c.id)
    .filter((id) => id !== clipId);
  ids.splice(at, 0, clipId);
  const stmt = db.prepare("update party_clips set position = ? where id = ?");
  db.exec("begin");
  ids.forEach((id, i) => stmt.run(i, id));
  db.prepare("update party_clips set queued_at = ? where id = ?").run(now, clipId);
  db.exec("commit");
}

/** Put the party's loop in the order of `ids`, from its start. */
export function orderPartyClips(ids: string[]) {
  const stmt = db.prepare("update party_clips set position = ? where id = ?");
  db.exec("begin");
  ids.forEach((id, i) => stmt.run(i, id));
  db.exec("commit");
}

export function removePartyClip(id: string) {
  db.prepare("delete from party_clips where id = ?").run(id);
}

export const getPartyClip = (id: string) => {
  const r = db.prepare("select party_id from party_clips where id = ?").get(id) as { party_id: string } | undefined;
  return r && partyClips(r.party_id).find((c) => c.id === id);
};

export function setPartyAnchor(id: string, anchor: number) {
  db.prepare("update parties set anchor = ? where id = ?").run(anchor, id);
}

export function setPartyEnd(id: string, endsAt: number) {
  db.prepare("update parties set ends_at = ? where id = ?").run(endsAt, id);
}

/** The party's over at `at`: early, or when its time ran out. */
export function endPartyAt(id: string, at: number) {
  db.prepare("update parties set ended_at = ?, ends_at = min(ends_at, ?) where id = ?").run(at, at, id);
}

/** Things that are gone (a drawing or app the house deleted since) leave the loop. */
const stillThere = (src: Source) => (src.kind === "image" ? !!getImageMeta(src.id) : !!getApp(src.id));

/** The party going on, as the schedule plays it. */
const partyProgram = (now = Date.now()) => partyLoop(currentParty(now));

/** A party's loop as the schedule plays it, whether or not it's on now. */
export function partyLoop(p: PartyRow | undefined): Program["party"] {
  if (!p) return null;
  const slides: Slide[] = partyClips(p.id)
    .filter((c) => stillThere(c.source))
    .map((c) => ({
      id: c.id,
      playlistId: null,
      clipId: c.id,
      source: c.source,
      position: c.position,
      durationS: c.durationS,
      enabled: true,
      days: [0, 1, 2, 3, 4, 5, 6],
      start: null,
      end: null,
    }));
  return { id: p.id, startedAt: p.startedAt, anchor: p.anchor, until: p.endsAt, slides };
}

/** A party's drawings and photos, made there and kept with it. */
export function partyImages(partyId: string): ImageMeta[] {
  const ids = new Set(partyClips(partyId).flatMap((c) => (c.source.kind === "image" ? [c.source.id] : [])));
  return (db.prepare(`${META} where kind = 'party'`).all() as ImageMeta[]).filter((m) => ids.has(m.id));
}

/** What someone made at parties, for Delete everything: it leaves their stories too. */
export function deletePartyImagesBy(personId: string) {
  const ids = (db.prepare("select id from images where kind = 'party' and made_by = ?").all(personId) as { id: string }[]).map((r) => r.id);
  for (const id of ids) {
    db.prepare("delete from party_clips where image_id = ?").run(id);
    deleteImage(id);
  }
  return ids.length;
}
