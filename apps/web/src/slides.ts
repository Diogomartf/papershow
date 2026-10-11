// Playlist client: the sequence, what's live, and edits to both.
// Every mutation answers with the whole new state, so the UI never drifts.

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
export type Playlist = { id: string; name: string; position: number; enabled: boolean };

/** What runs: playlists, images and apps, top to bottom, then again. */
export type ShowEntry = {
  id: string;
  position: number;
  playlistId: string | null;
  /** A single image or app placed in the show on its own. */
  source: Source | null;
  durationS: number;
  enabled: boolean;
  /** Minutes: a single item interrupts the loop on the clock this often (60 = on the hour). Null = a turn in the loop. */
  everyM: number | null;
};

/** How often a single item can repeat; each divides the day, so "every hour" lands on the hour. */
export const REPEAT_EVERY = [15, 30, 60, 120] as const;

/** One clip's turn on air, in the loop ahead. */
export type Turn = {
  /** Unique within the loop. */
  key: string;
  entryId: string | null;
  /** The playlist clip, or null for a single image or app in the show. */
  clipId: string | null;
  playlistId: string | null;
  source: Source;
  at: number;
  endsAt: number;
};

export type Live = { mode: "rotate" } | { mode: "pin"; source: Source };

/** Night: hours when the panel sleeps, and what it shows ("off" keeps the last picture). */
export type Sleep = { enabled: boolean; start: string; end: string; screen: "moon" | "blank" | "off" };

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
    /** While asleep, when the panel wakes. */
    asleep: number | null;
    /** True when the panel keeps its last picture and /live sends nothing. */
    blank: boolean;
  } | null;
  sleep: Sleep;
  slides: Slide[];
  playlists: Playlist[];
  show: ShowEntry[];
  upcoming: { slideId: string; at: number }[];
  /** The loop from now: the clip on air, then each one after it. */
  sequence: Turn[];
  /** The last time a display fetched /live. */
  display: { at: number; agent: string } | null;
};

async function call(path: string, method = "GET", body?: unknown): Promise<State> {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
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
export const setLive = (live: Live) => call("/api/live", "PUT", live);
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

export const addToShow = (what: { playlistId: string } | { source: Source }, at?: number) => call("/api/show", "POST", { ...what, at });
export const updateShowEntry = (id: string, patch: Partial<Pick<ShowEntry, "durationS" | "enabled" | "everyM">>) =>
  call(`/api/show/${id}`, "PATCH", patch);
export const reorderShow = (ids: string[]) => call("/api/show/order", "PUT", { ids });
export const removeFromShow = (id: string) => call(`/api/show/${id}`, "DELETE");

/** Put a removed show entry back at `index`, as it was. */
export async function restoreShowEntry(entry: ShowEntry, index: number): Promise<State> {
  const st = await addToShow(entry.playlistId ? { playlistId: entry.playlistId } : { source: entry.source! }, index);
  const back = st.show[index];
  return back ? updateShowEntry(back.id, { durationS: entry.durationS, enabled: entry.enabled, everyM: entry.everyM }) : st;
}
