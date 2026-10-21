// The Apps API: built-in apps (clock, crypto, …) and the instances you set up.
import { Oops, signedOut } from "./house";

export type Field =
  | { key: string; label: string; type: "text"; placeholder?: string; hint?: string }
  | { key: string; label: string; type: "textarea"; placeholder?: string; hint?: string }
  | { key: string; label: string; type: "toggle"; hint?: string }
  | { key: string; label: string; type: "select"; options: { value: string; label: string }[]; hint?: string }
  | { key: string; label: string; type: "list"; placeholder?: string; hint?: string }
  | { key: string; label: string; type: "picks"; options: { value: string; label: string; thumb?: string }[]; max?: number; hint?: string };

export type Category = "clock" | "ai" | "news" | "markets" | "photos";

/** Category headings, in the order the "New app" list shows them. */
export const CATEGORIES: { id: Category; label: string }[] = [
  { id: "clock", label: "Clocks" },
  { id: "ai", label: "AI" },
  { id: "news", label: "News" },
  { id: "markets", label: "Stocks & tokens" },
  { id: "photos", label: "Photos" },
];

export type AppKind = {
  kind: string;
  name: string;
  category: Category;
  description: string;
  /** Where its data comes from. */
  source: string;
  defaults: Record<string, unknown>;
  fields: Field[];
  mock: boolean;
  periodMs: number;
};

export type AppInstance = { id: string; kind: string; name: string; config: Record<string, unknown>; updatedAt: number; madeBy: string | null };

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
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
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** The last catalog and app list fetched, so a page can start from them instead of from empty. */
export const cached: { catalog: AppKind[] | null; apps: AppInstance[] | null } = { catalog: null, apps: null };

export const getCatalog = () => api<AppKind[]>("/api/apps/catalog").then((c) => (cached.catalog = c));
export const listApps = () => api<AppInstance[]>("/api/apps").then((a) => (cached.apps = a));
export const createApp = (kind: string, init?: { name?: string; config?: Record<string, unknown> }) =>
  api<AppInstance>("/api/apps", "POST", { kind, ...init });
export const updateApp = (id: string, patch: { name?: string; config?: Record<string, unknown> }) =>
  api<AppInstance>(`/api/apps/${id}`, "PATCH", patch);
export const deleteApp = (id: string) => api<void>(`/api/apps/${id}`, "DELETE");

/** The app's current frame. `v` busts the cache when its settings change. */
export const appFrameUrl = (app: AppInstance) => `/api/apps/${app.id}/mono.png?v=${app.updatedAt}`;

/** Render settings that aren't saved yet; resolves to an object URL for an <img>. `original`: full resolution, in colour. */
export async function previewApp(kind: string, config: Record<string, unknown>, signal?: AbortSignal, original = false) {
  const res = await fetch("/api/apps/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, config, original }),
    signal,
  });
  if (res.status === 401) signedOut();
  if (!res.ok) throw new Error(`preview → ${res.status}`);
  return URL.createObjectURL(await res.blob());
}
