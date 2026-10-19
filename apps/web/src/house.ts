// People in the house: signing in, joining, and the log of who did what.
import { createContext, useContext, type CSSProperties } from "react";

/** Members are the household. Guests draw and make apps, and ask before anything goes on the panel. */
export type Role = "admin" | "member" | "guest";

/** What the app calls each role. */
export const ROLE_NAMES: Record<Role, string> = { admin: "Admin", member: "Household", guest: "Guest" };
export const ROLES = Object.keys(ROLE_NAMES) as Role[];
/** Knocking: waiting for an admin to let them in. Out: removed. */
export type Status = "knocking" | "in" | "out";

export type Person = {
  id: string;
  name: string;
  face: string;
  color: string;
  role: Role;
  status: Status;
  createdAt: number;
  seenAt: number | null;
};

/** Enough of a person to recognise them: the sign-in tiles and the makers' badges. */
export type Face = Pick<Person, "id" | "name" | "face" | "color">;

/** What the sign-in screen gets: who's in, the keypad, and who this device is signed in as. */
export type Hello = {
  /** No one yet: the first person sets up the house. */
  first: boolean;
  people: Face[];
  keys: string[];
  faces: string[];
  colors: string[];
  me: Person | null;
};

export type Profile = { name: string; face: string; color: string };

/** `role`: whoever uses it joins as household ("member") or as a guest. `onPanelUntil`: while it's on the panel, when it comes off. */
export type Invite = { code: string; expiresAt: number; url: string; onPanelUntil: number | null; role: Role };

export type LogEntry = { id: number; at: number; personId: string | null; verb: string; subject: Record<string, unknown> };

/** Something wasn't right; `message` is ready for the screen. */
export class Oops extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** What went wrong, for a toast: the server's own words when it said why (a limit, a guest), else `fallback`. */
export const reason = (err: unknown, fallback: string) =>
  err instanceof Oops && typeof err.body.error === "string" ? err.body.error : fallback;

/** Fired when the server says no one's signed in here: the app goes back to "Who's there?". */
export const SIGNED_OUT = "papershow:signed-out";
export const signedOut = () => dispatchEvent(new Event(SIGNED_OUT));

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new Oops(json.error ?? `${method} ${path} → ${res.status}`, res.status, json);
  return json as T;
}

/** `wait` holds until something changes: the knock screen hears "come in" right away. */
export const hello = (wait = false) => call<Hello>(`/api/hello${wait ? "?wait=1" : ""}`);
export const setUp = (p: Profile, secret: string[]) => call<Hello>("/api/hello/setup", "POST", { ...p, secret });
export const signIn = (id: string, secret: string[]) => call<Hello>("/api/hello/in", "POST", { id, secret });
export const signOut = () => call<Hello>("/api/hello/out", "POST");
export const knock = (p: Profile, secret: string[], invite?: string) => call<Hello>("/api/hello/knock", "POST", { ...p, secret, invite });
export const inviteInfo = (code: string) => call<{ code: string; expiresAt: number; role: Role; by: Face | null }>(`/api/hello/invite/${code}`);

export const updateMe = (patch: Partial<Profile> & { secret?: string[] }) => call<unknown>("/api/me", "PATCH", patch);
export const updatePerson = (id: string, patch: { status?: "in" | "out"; role?: Role }) => call<unknown>(`/api/people/${id}`, "PATCH", patch);
export const notNow = (id: string) => call<unknown>(`/api/people/${id}`, "DELETE");
export const createInvite = (role: "member" | "guest") => call<Invite>("/api/invites", "POST", { origin: location.origin, role });
export const setInviteRole = (code: string, role: "member" | "guest") => call<Invite>(`/api/invites/${code}`, "PATCH", { role });
/** Someone removed, and everything they did. Can't be undone. */
export const deleteEverything = (id: string) =>
  call<{ deleted: { drawings: number; apps: number; playlists: number } }>(`/api/people/${id}/everything`, "DELETE");
/** Put the invite on the panel for a couple of minutes. */
export const showInvite = (code: string) => call<Invite>(`/api/invites/${code}/panel`, "PUT");
export const hideInvite = (code: string) => call<unknown>(`/api/invites/${code}/panel`, "DELETE");
export const inviteQr = (code: string) => `/api/invites/${code}/qr.svg`;
/** The log's topics, each the verbs it covers. */
export const LOG_TOPICS = [
  { key: "panel", label: "On the panel", icon: "📺", verbs: ["showed-now", "resumed", "asked-to-show", "said-yes", "said-not-now"] },
  {
    key: "program",
    label: "Program",
    icon: "📅",
    verbs: [
      "changed-program", "added-to-show", "removed-from-show", "changed-show", "reordered-show",
      "made-playlist", "renamed-playlist", "deleted-playlist", "added-to-playlist", "removed-from-playlist", "changed-playlist",
    ],
  },
  { key: "made", label: "Drawings and apps", icon: "✏️", verbs: ["drew", "redrew", "erased", "made-app", "tuned-app", "deleted-app"] },
  { key: "night", label: "Night and off", icon: "🌙", verbs: ["changed-night", "turned-off", "turned-on"] },
  {
    key: "people",
    label: "People and invites",
    icon: "🎟️",
    verbs: ["set-up", "knocked", "joined", "invited", "invite-on-panel", "let-in", "let-back-in", "not-now", "removed", "made-admin", "made-member", "made-guest", "new-look", "cleared-out"],
  },
] as const;

export const getLog = (opts: { before?: number; person?: string; verbs?: string; limit?: number } = {}) => {
  const q = new URLSearchParams(Object.entries(opts).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
  return call<LogEntry[]>(`/api/log?${q}`);
};

// ── Who's signed in, for any page ──────────────────────────────────────────

export type MeContext = {
  me: Person;
  hello: Hello;
  refresh: () => void;
  /** Sign out and go straight to someone else's PIN, as on a shared tablet. */
  switchTo: (id: string) => void;
};
export const Me = createContext<MeContext | null>(null);

export function useMe() {
  const ctx = useContext(Me);
  if (!ctx) throw new Error("useMe outside the signed-in app");
  return ctx;
}

/** A person's colour, for the tiles and badges that show their face. */
export const tint = (color: string) => ({ ["--tile" as string]: color }) as CSSProperties;

/** May I change this? Its maker can, and admins can change anything. */
export const mine = (me: Person, madeBy: string | null | undefined) => me.role === "admin" || !madeBy || madeBy === me.id;

// ── The log, in words ─────────────────────────────────────────────────────

type Named = { kind: string; id: string; name: string; face?: string };
const nameOf = (x: unknown) => (x && typeof x === "object" && "name" in x ? (x as Named).name : "something");
const personOf = (x: unknown) => (x && typeof x === "object" && "name" in x ? `${(x as Named).face ?? ""} ${(x as Named).name}`.trim() : "someone");

/** What happened, after the person's name: "added Sunflower to the show". */
export function says(e: LogEntry): string {
  const s = e.subject;
  const item = nameOf(s.item);
  const playlist = nameOf(s.playlist);
  const what = s.playlist && !s.item ? playlist : item;
  switch (e.verb) {
    case "set-up": return "set up the house 🏠";
    case "knocked": return "knocked on the door 🚪";
    case "joined": return s.by ? `came in with an invite from ${personOf(s.by)} 🎟️` : "came in with an invite 🎟️";
    case "let-in": return s.guest ? `let ${personOf(s.person)} in as a guest 🎉` : `let ${personOf(s.person)} in 🎉`;
    case "let-back-in": return `let ${personOf(s.person)} back in`;
    case "not-now": return `said "not now" to ${personOf(s.person)}`;
    case "removed": return `removed ${personOf(s.person)}`;
    case "made-admin": return `made ${personOf(s.person)} an admin 👑`;
    case "made-member": return `made ${personOf(s.person)} household`;
    case "made-guest": return `made ${personOf(s.person)} a guest`;
    case "new-look": return "got a new look ✨";
    case "cleared-out": return "deleted someone who was removed, and everything they did 🧹";
    // Older entries say `panel` when the invite was made straight onto the panel.
    case "invited": return `${s.panel ? "put an invite on the panel" : "made an invite"}${s.guest ? " for a guest" : ""} 🎟️`;
    case "invite-on-panel": return `put an invite${s.guest ? " for a guest" : ""} on the panel 🎟️`;
    case "drew": return `drew ${item} ✏️`;
    case "redrew": return `touched up ${item}`;
    case "erased": return `deleted the drawing ${item}`;
    case "made-app": return `set up ${item}`;
    case "tuned-app": return `tuned ${item}`;
    case "deleted-app": return `deleted ${item}`;
    case "made-playlist": return `made the playlist ${playlist}`;
    case "renamed-playlist": return `renamed ${String(s.was ?? "a playlist")} to ${playlist}`;
    case "deleted-playlist": return `deleted the playlist ${playlist}`;
    case "added-to-playlist": return `added ${item} to ${playlist}`;
    case "removed-from-playlist": return `took ${item} out of ${playlist}`;
    case "changed-playlist": return `rearranged ${playlist}`;
    case "added-to-show": return `added ${what} to the show`;
    case "removed-from-show": return `took ${what} out of the show`;
    case "changed-show": return what === "something" ? "changed the show" : `changed ${what} in the show`;
    case "reordered-show": return "shuffled the show around";
    case "changed-program": return "changed the week's program 📅";
    case "showed-now": return `put ${item} on the panel 📺`;
    case "resumed": return "let the show carry on";
    case "asked-to-show": return `asked to put ${item} on the panel 🙋`;
    case "said-yes": return `said yes to ${s.person ? `${personOf(s.person)}'s ` : ""}${item} 📺`;
    case "said-not-now": return `said "not now" to ${s.person ? `${personOf(s.person)}'s ` : ""}${item}`;
    case "turned-off": return s.back ? `turned the panel off until ${String(s.back)} 💤` : "turned the panel off 💤";
    case "turned-on": return "turned the panel back on ☀️";
    case "changed-night": return s.enabled ? `set the night to ${String(s.start)}–${String(s.end)} 🌙` : "turned the night off";
    default: return e.verb.replace(/-/g, " ");
  }
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "just now", "5 min ago", "yesterday"… */
export function when(t: number, now = Date.now()) {
  const s = Math.round((t - now) / 1000);
  if (s > -45) return "just now";
  if (s > -3600) return RELATIVE.format(Math.round(s / 60), "minute");
  if (s > -86_400) return RELATIVE.format(Math.round(s / 3600), "hour");
  return RELATIVE.format(Math.round(s / 86_400), "day");
}
