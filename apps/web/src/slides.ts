// Playlist client: the sequence, what's live, and edits to both.
// Every mutation answers with the whole new state, so the UI never drifts.

import { Oops, signedOut, type LogEntry, type Person } from "./house";
import type { Scene } from "@papershow/scene";
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
/** A pin is outside the program: `by` who put it up, and `from` Draw when it was sent straight from there. */
export type Live =
  | { mode: "rotate" }
  | { mode: "pin"; source: Source; until?: number | null; by?: string | null; from?: "draw" | null; okBy?: string | null };

/** Where a pin came from, for the label that says it's outside the program: "Sent from Draw by Ana", "Leo's, Ana said yes". */
export function pinnedBy(live: Live, people: Person[], me?: Person | null): string {
  if (live.mode !== "pin") return "";
  const name = (id?: string | null) => (id ? (id === me?.id ? "you" : people.find((p) => p.id === id)?.name) : undefined);
  const who = name(live.by);
  const how = live.from === "draw" ? "Sent from Draw" : "Put on with Show now";
  const ok = name(live.okBy);
  return `${who ? `${how} by ${who}` : how}${ok ? `, ${ok} said yes` : ""}`;
}

/** One thing in a party's loop. `addedBy` is null for what came from the playlist it started with; `own` when it was made there. */
export type PartyClip = { id: string; partyId: string; position: number; source: Source; durationS: number; addedBy: string | null; addedAt: number; name: string; own: boolean };

/** A turn that went on air at a party: which clip, what it showed, who added it, and whether it's still there. */
export type PartyPlay = { clipId: string; source: Source; at: number; name: string; addedBy: string | null; gone: boolean };

/** A party: its own loop in place of the program until `endsAt`, starting from a copy of `playlistId`. */
export type Party = {
  id: string;
  playlistId: string | null;
  startedAt: number;
  endsAt: number;
  endedAt: number | null;
  startedBy: string | null;
  clips: PartyClip[];
  /** What's been on so far, newest first. */
  played: PartyPlay[];
};

/** A party that's over, as its story: how many things people added, how many were made there, by whom. */
export type PartySummary = Omit<Party, "clips" | "played"> & { things: number; made: number; people: string[]; cover: string | null };
export type PartyStory = PartySummary & { playlist: string | null; clips: (PartyClip & { gone: boolean })[]; played: PartyPlay[] };

/** A guest asked for something to go on the panel; it waits for someone in the household to say yes. */
export type Ask = { id: string; by: string; source: Source; forS: number; via: "draw" | null; at: number };

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
  /** A party going on, or null. */
  party: Party | null;
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
  /** Everyone who's in, and who was removed; all but guests also see who's knocking. */
  people: Person[];
  /** Guests' asks waiting for a yes; a guest gets only their own. */
  asks: Ask[];
  /** The last few things people did. Empty for guests. */
  log: LogEntry[];
};

async function call(path: string, method = "GET", body?: unknown): Promise<State> {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) signedOut();
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Oops(json.error ?? `${method} ${path} → ${res.status}`, res.status, json);
  }
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
/** A guest's Show now: ask the household to put it up, for `forS` seconds once they say yes. */
export const ask = (source: Source, forS?: number, from?: "draw") => call("/api/asks", "POST", { source, forS, from });
export const sayYes = (id: string) => call(`/api/asks/${id}/yes`, "POST");
/** Not now, or, for the guest who asked, take it back. */
export const dropAsk = (id: string) => call(`/api/asks/${id}`, "DELETE");
/** Start a party from a copy of `playlistId` (or nothing), until `until`; while one is on, move its end. The server keeps it to the next morning. */
export const startParty = (playlistId: string | null, until: number) => call("/api/party", "PUT", { playlistId, until });
/** Something of the house's into the party, to play next. */
export const addToParty = (source: Source) => call("/api/party/clips", "POST", { source });
/** Play something from the party again, next. */
export const playAgain = (clipId: string) => call(`/api/party/clips/${clipId}/next`, "POST");
/** Sort what's coming up at the party: its clips after the one on air, in order. */
export const orderParty = (ids: string[]) => call("/api/party/order", "PUT", { ids });
/** Take something out of the party; what was made there goes with it. */
export const removeFromParty = (clipId: string) => call(`/api/party/clips/${clipId}`, "DELETE");

/** A drawing or photo made at the party: kept with it, out of the house's library, and played next the first time. */
export function putPartyImage(scene: Scene, files: { png: Blob; mono: Blob; bin: Blob }, photo = false) {
  const form = new FormData();
  form.set("scene", JSON.stringify(scene));
  form.set("png", files.png);
  form.set("mono", files.mono);
  form.set("bin", files.bin);
  if (photo) form.set("photo", "1");
  return fetch(`/api/party/images/${scene.id}`, { method: "PUT", body: form }).then(async (res) => {
    if (res.status === 401) signedOut();
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Oops(json.error ?? `PUT party image → ${res.status}`, res.status, json);
    return json as State;
  });
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (res.status === 401) signedOut();
  if (!res.ok) throw new Oops(`GET ${path} → ${res.status}`, res.status, {});
  return res.json();
}
/** Parties that are over, newest first. */
export const listParties = () => get<PartySummary[]>("/api/parties");
/** One party's whole story. */
export const getPartyStory = (id: string) => get<PartyStory>(`/api/parties/${id}`);
/** End the party: the program carries on where it would be. */
export const endParty = () => call("/api/party", "DELETE");
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
