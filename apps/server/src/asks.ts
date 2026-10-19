// Guests ask before anything of theirs goes on the panel: someone in the household says yes, or not now.
//
// One ask per guest at a time (a new one takes the old one's place), and an ask nobody answers lapses,
// so a guest can't pile up a queue for the household to wade through.
import { db } from "./db.ts";
import type { Source } from "./schedule.ts";

/** How long an ask waits for an answer. */
export const ASK_MS = 30 * 60_000;

/** `by` asked for `source` to go on the panel for `forS` seconds, `via` Draw or from elsewhere, `at` then. */
export type Ask = { id: string; by: string; source: Source; forS: number; via: "draw" | null; at: number };

db.exec(`
  create table if not exists asks (
    id        text primary key,
    person_id text not null references people(id) on delete cascade,
    source    text not null,                        -- JSON: { kind, id }
    for_s     integer not null,
    via       text,
    at        integer not null
  );
`);

type AskRow = { id: string; person_id: string; source: string; for_s: number; via: "draw" | null; at: number };
const toAsk = (r: AskRow): Ask => ({ id: r.id, by: r.person_id, source: JSON.parse(r.source), forS: r.for_s, via: r.via, at: r.at });

/** Asks still waiting, oldest first. A guest who was removed takes their ask with them. */
export function listAsks(now = Date.now()): Ask[] {
  const rows = db
    .prepare("select a.* from asks a join people p on p.id = a.person_id and p.status = 'in' where a.at > ? order by a.at")
    .all(now - ASK_MS) as AskRow[];
  return rows.map(toAsk);
}

export const getAsk = (id: string, now = Date.now()) => listAsks(now).find((a) => a.id === id);

export function addAsk(personId: string, source: Source, forS: number, via: "draw" | null, now = Date.now()): Ask {
  const id = crypto.randomUUID().slice(0, 8);
  db.prepare("delete from asks where person_id = ? or at <= ?").run(personId, now - ASK_MS);
  db.prepare("insert into asks (id, person_id, source, for_s, via, at) values (?, ?, ?, ?, ?, ?)").run(
    id,
    personId,
    JSON.stringify({ kind: source.kind, id: source.id }),
    forS,
    via,
    now,
  );
  return { id, by: personId, source, forS, via, at: now };
}

export const dropAsk = (id: string) => db.prepare("delete from asks where id = ?").run(id);

/** A guest changed what they asked to show: the household said yes (or would) to how it looked, so ask again. */
export const dropAsksFor = (source: Source) =>
  db.prepare("delete from asks where source = ?").run(JSON.stringify({ kind: source.kind, id: source.id }));
