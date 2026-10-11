import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Scene } from "@imagegen/scene";
import type { Live, Slide } from "./schedule.ts";

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
    png        blob not null,  -- colour, as drawn
    mono       blob not null,  -- 1-bit PNG, what the panel shows
    bin        blob not null,  -- 1bpp packed, straight to the EPD
    updated_at integer not null
  );

  create table if not exists slides (
    id         text primary key,
    image_id   text not null references images(id) on delete cascade,
    position   integer not null,
    duration_s integer not null default 60,  -- whole minutes, at least one
    enabled    integer not null default 1,
    days       text not null default '0123456',  -- 0 = Sunday
    start      text,                              -- 'HH:MM', null = all day
    "end"      text
  );

  create table if not exists settings (key text primary key, value text not null);
`);

export type ImageMeta = { id: string; name: string; updatedAt: number };
export type ImageKind = "png" | "mono" | "bin";

export function listImages(): ImageMeta[] {
  return db
    .prepare("select id, name, updated_at as updatedAt from images order by updated_at desc")
    .all() as ImageMeta[];
}

export function getImageMeta(id: string): ImageMeta | undefined {
  return db.prepare("select id, name, updated_at as updatedAt from images where id = ?").get(id) as
    | ImageMeta
    | undefined;
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

export function putImage(scene: Scene, files: Record<ImageKind, Uint8Array>) {
  db.prepare(
    `insert into images (id, name, scene, png, mono, bin, updated_at) values (?, ?, ?, ?, ?, ?, ?)
     on conflict(id) do update set name = excluded.name, scene = excluded.scene, png = excluded.png,
       mono = excluded.mono, bin = excluded.bin, updated_at = excluded.updated_at`,
  ).run(scene.id, scene.name, JSON.stringify(scene), files.png, files.mono, files.bin, scene.updatedAt);
}

export function deleteImage(id: string) {
  db.prepare("delete from images where id = ?").run(id);
  const live = getLive();
  if (live.mode === "pin" && live.imageId === id) setLive({ mode: "rotate" });
}

type SlideRow = {
  id: string;
  image_id: string;
  position: number;
  duration_s: number;
  enabled: number;
  days: string;
  start: string | null;
  end: string | null;
};

const toSlide = (r: SlideRow): Slide => ({
  id: r.id,
  imageId: r.image_id,
  position: r.position,
  durationS: r.duration_s,
  enabled: !!r.enabled,
  days: [...r.days].map(Number),
  start: r.start,
  end: r.end,
});

export function listSlides(): Slide[] {
  return (db.prepare("select * from slides order by position").all() as SlideRow[]).map(toSlide);
}

/** New clips run a quarter of an hour; drag the edge to change it. */
const DEFAULT_CLIP_S = 15 * 60;

/** Add a clip at `at` in the sequence (end by default), shifting the rest along. */
export function addSlide(imageId: string, at?: number): Slide {
  const id = crypto.randomUUID().slice(0, 8);
  const ids = listSlides().map((s) => s.id);
  ids.splice(at ?? ids.length, 0, id);
  db.exec("begin");
  db.prepare("insert into slides (id, image_id, position, duration_s) values (?, ?, ?, ?)").run(
    id,
    imageId,
    ids.length,
    DEFAULT_CLIP_S,
  );
  reorderSlides(ids, false);
  db.exec("commit");
  return listSlides().find((s) => s.id === id)!;
}

export function updateSlide(id: string, patch: Partial<Omit<Slide, "id" | "imageId" | "position">>) {
  const cols: string[] = [];
  const vals: (string | number | null)[] = [];
  if (patch.durationS !== undefined) cols.push("duration_s = ?"), vals.push(Math.max(1, Math.round(patch.durationS / 60)) * 60);
  if (patch.enabled !== undefined) cols.push("enabled = ?"), vals.push(patch.enabled ? 1 : 0);
  if (patch.days !== undefined) cols.push("days = ?"), vals.push([...new Set(patch.days)].sort().join(""));
  if (patch.start !== undefined) cols.push("start = ?"), vals.push(patch.start);
  if (patch.end !== undefined) cols.push('"end" = ?'), vals.push(patch.end);
  if (!cols.length) return;
  db.prepare(`update slides set ${cols.join(", ")} where id = ?`).run(...vals, id);
}

export function reorderSlides(ids: string[], transaction = true) {
  const stmt = db.prepare("update slides set position = ? where id = ?");
  if (transaction) db.exec("begin");
  ids.forEach((id, i) => stmt.run(i, id));
  if (transaction) db.exec("commit");
}

export function deleteSlide(id: string) {
  db.prepare("delete from slides where id = ?").run(id);
}

export function getLive(): Live {
  const row = db.prepare("select value from settings where key = 'live'").get() as { value: string } | undefined;
  return row ? JSON.parse(row.value) : { mode: "rotate" };
}

export function setLive(live: Live) {
  db.prepare("insert into settings (key, value) values ('live', ?) on conflict(key) do update set value = excluded.value").run(
    JSON.stringify(live),
  );
}
