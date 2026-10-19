// Playlist client: the sequence, what's live, and edits to both.
// Every mutation answers with the whole new state, so the UI never drifts.

import { signedOut, type LogEntry, type Person } from "./house";
import type { Source } from "./sources";

export type Slide = {
  id: string;
  playlistId: string;
  source: Source;
  position: number;
  durationS: number;
  enabled: boolean;
  days: number[];
  start: string | null;
  end: string | null;
};

/** Playlists play one after another, then loop; disabled ones are skipped. */
export type Playlist = { id: string; name: string; position: number; enabled: boolean; madeBy: string | null };

/** What runs in a block of the program: playlists, images and apps, top to bottom, then again. */
export type ShowEntry = {
  id: string;
  blockId: string;
  position: number;
  playlistId: string | null;
  /** A single image or app placed in the show on its own. */
  source: Source | null;
  durationS: number;
  enabled: boolean;
  /** One of `ENTRY_COLORS`, or null for one picked by its place in the block. */
  color: EntryColor | null;
};

/** The colours an entry can have on the day bar. Blue is left out: it means the panel is asleep. */
export const ENTRY_COLORS = ["yellow", "sage", "orange", "pink", "lilac", "teal", "sand", "lime", "plum"] as const;
export type EntryColor = (typeof ENTRY_COLORS)[number];

export type Days = "weekdays" | "weekend";

/** The time check: a clock that cuts in at the top of every hour, outside the blocks. `appId` is the clock it shows. */
export type TimeCheck = { on: boolean; appId: string | null; durationS: number };

/** A time of day; what's in it plays from then until the next block, starting over when it runs out. */
export type Block = { id: string; days: Days; start: string };

/** One clip's turn on air, in the loop ahead. */
export type Turn = {
  /** Unique within the program. */
  key: string;
  /** The block it plays in. */
  blockId: string;
  entryId: string | null;
  /** The playlist clip, or null for a single image or app in the show. */
  clipId: string | null;
  playlistId: string | null;
  source: Source;
  at: number;
  endsAt: number;
};

/** Show now holds `source` on /live until `until`, then the playlists carry on. */
export type Live = { mode: "rotate" } | { mode: "pin"; source: Source; until?: number | null };

/** Night: hours when the panel sleeps, and what it shows ("off" keeps the last picture). Away: off for days. */
export type Sleep = {
  enabled: boolean;
  start: string;
  end: string;
  screen: "moon" | "blank" | "off";
  away: boolean;
  /** 'YYYY-MM-DD' when away ends, at the night's wake-up time; null = until switched back. */
  back: string | null;
};

export type State = {
  now: number;
  live: Live;
  showing: {
    /** Null while asleep. */
    source: Source | null;
    /** Loop key of what's on air. */
    slideId: string | null;
    /** The show entry and the playlist clip behind it. */
    entryId: string | null;
    clipId: string | null;
    endsAt: number | null;
    clip: { startedAt: number; endsAt: number } | null;
    etag: string;
    /** While asleep or away, when the panel wakes: 0 while away until switched back. */
    asleep: number | null;
    /** Away for days, not just asleep for the night. */
    away: boolean;
    /** True when the panel keeps its last picture and /live sends nothing. */
    blank: boolean;
    /** The invite code, while an invite is on the panel. */
    invite: string | null;
  } | null;
  sleep: Sleep;
  slides: Slide[];
  playlists: Playlist[];
  show: ShowEntry[];
  /** The week's blocks; the weekend plays the weekdays' unless it has its own. */
  program: { weekendOwn: boolean; blocks: Block[]; timeCheck: TimeCheck };
  /** The block on air (even under a Show now or the night), and when the next one takes over. */
  block: { id: string; startedAt: number; endsAt: number } | null;
  upcoming: { slideId: string; at: number }[];
  /** The loop from now: the clip on air, then each one after it. */
  sequence: Turn[];
  /** The turn that handed off to the one on air, when there was one. */
  previous: Turn | null;
  /** The last time a display fetched /live. */
  display: { at: number; agent: string } | null;
  me: Person;
  /** Everyone who's in; admins also see who's knocking and who was removed. */
  people: Person[];
  /** The last few things people did. */
  log: LogEntry[];
};

async function call(path: string, method = "GET", body?: unknown): Promise<State> {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) signedOut();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return res.json();
}

export const getState = () => call("/api/state");
/** Resolves when anything changes, or the current clip turns over. */
export const waitState = () => call("/api/state/wait");
export const addSlide = (source: Source, playlistId?: string, at?: number) =>
  call("/api/slides", "POST", { source, playlistId, at });
export const updateSlide = (id: string, patch: Partial<Slide>) => call(`/api/slides/${id}`, "PATCH", patch);
export const reorderSlides = (ids: string[]) => call("/api/slides/order", "PUT", { ids });
export const removeSlide = (id: string) => call(`/api/slides/${id}`, "DELETE");
/** Show now for `forS` seconds (the server's 15 minutes when left out), or back to the playlists. */
export const setLive = (live: Live & { forS?: number }) => call("/api/live", "PUT", live);
export const setSleep = (patch: Partial<Sleep>) => call("/api/sleep", "PUT", patch);

/** New playlists join the end of the show unless `show` is false. */
export const createPlaylist = (name?: string, show = true) =>
  call("/api/playlists", "POST", { name, show }) as Promise<State & { created: string }>;
export const updatePlaylist = (id: string, patch: Partial<Pick<Playlist, "name" | "enabled">>) =>
  call(`/api/playlists/${id}`, "PATCH", patch);
export const reorderPlaylists = (ids: string[]) => call("/api/playlists/order", "PUT", { ids });
export const deletePlaylist = (id: string) => call(`/api/playlists/${id}`, "DELETE");

/** A source as it will look at `at`: the dashboard's peek ahead. */
export const frameAt = (source: Source, at: number) => `/api/frame/${source.kind}/${source.id}.png?at=${at}`;

/** Put a removed clip back where it was (`index` within its playlist), with its length, days and hours. */
export async function restoreSlide(slide: Slide, index: number): Promise<State> {
  const st = await addSlide(slide.source, slide.playlistId, index);
  const back = st.slides.filter((x) => x.playlistId === slide.playlistId)[index];
  if (!back) return st;
  const { durationS, enabled, days, start, end } = slide;
  return updateSlide(back.id, { durationS, enabled, days, start, end });
}

/** Add to a block (the one on air when left out), at `at` within it (the end when left out). */
export const addToShow = (what: { playlistId: string } | { source: Source }, blockId?: string, at?: number) =>
  call("/api/show", "POST", { ...what, blockId, at });
export const updateShowEntry = (id: string, patch: Partial<Pick<ShowEntry, "durationS" | "enabled" | "color">>) => call(`/api/show/${id}`, "PATCH", patch);
/** The new order of one block's entries. */
export const reorderShow = (ids: string[]) => call("/api/show/order", "PUT", { ids });
export const removeFromShow = (id: string) => call(`/api/show/${id}`, "DELETE");

/** Put a removed show entry back in its block at `index`, as it was. */
export async function restoreShowEntry(entry: ShowEntry, index: number): Promise<State> {
  const st = await addToShow(entry.playlistId ? { playlistId: entry.playlistId } : { source: entry.source! }, entry.blockId, index);
  const back = st.show.filter((e) => e.blockId === entry.blockId)[index];
  return back ? updateShowEntry(back.id, { durationS: entry.durationS, enabled: entry.enabled, color: entry.color }) : st;
}

export const addBlock = (days: Days, start: string) =>
  call("/api/blocks", "POST", { days, start }) as Promise<State & { created: string }>;
export const moveBlock = (id: string, start: string) => call(`/api/blocks/${id}`, "PATCH", { start });
export const removeBlock = (id: string) => call(`/api/blocks/${id}`, "DELETE");
/** Plan the weekend on its own (starting from a copy of the weekdays), or play the weekdays every day. */
export const setWeekendOwn = (weekendOwn: boolean) => call("/api/program", "PUT", { weekendOwn });
/** Switch the time check on the hour on or off, or pick its clock. */
export const setTimeCheck = (timeCheck: Partial<TimeCheck>) => call("/api/program", "PUT", { timeCheck });

/** Put a removed block back, with what was in it. */
export async function restoreBlock(block: Block, entries: ShowEntry[]): Promise<State> {
  let st: State = await addBlock(block.days, block.start);
  const id = (st as State & { created: string }).created;
  for (const e of entries) {
    st = await addToShow(e.playlistId ? { playlistId: e.playlistId } : { source: e.source! }, id);
    const back = st.show.filter((x) => x.blockId === id).at(-1);
    if (back && (back.durationS !== e.durationS || !e.enabled || e.color))
      st = await updateShowEntry(back.id, { durationS: e.durationS, enabled: e.enabled, color: e.color });
  }
  return st;
}
