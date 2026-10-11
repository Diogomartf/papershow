// The Apps API: built-in apps (clock, crypto, …) and the instances you set up.

export type Field =
  | { key: string; label: string; type: "text"; placeholder?: string; hint?: string }
  | { key: string; label: string; type: "toggle"; hint?: string }
  | { key: string; label: string; type: "select"; options: { value: string; label: string }[]; hint?: string }
  | { key: string; label: string; type: "list"; placeholder?: string; hint?: string };

export type AppKind = {
  kind: string;
  name: string;
  description: string;
  defaults: Record<string, unknown>;
  fields: Field[];
  mock: boolean;
  periodMs: number;
};

export type AppInstance = { id: string; kind: string; name: string; config: Record<string, unknown>; updatedAt: number };

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const getCatalog = () => api<AppKind[]>("/api/apps/catalog");
export const listApps = () => api<AppInstance[]>("/api/apps");
export const createApp = (kind: string, init?: { name?: string; config?: Record<string, unknown> }) =>
  api<AppInstance>("/api/apps", "POST", { kind, ...init });
export const updateApp = (id: string, patch: { name?: string; config?: Record<string, unknown> }) =>
  api<AppInstance>(`/api/apps/${id}`, "PATCH", patch);
export const deleteApp = (id: string) => api<void>(`/api/apps/${id}`, "DELETE");

/** The app's current frame. `v` busts the cache when its settings change. */
export const appFrameUrl = (app: AppInstance) => `/api/apps/${app.id}/mono.png?v=${app.updatedAt}`;

/** Render settings that aren't saved yet; resolves to an object URL for an <img>. */
export async function previewApp(kind: string, config: Record<string, unknown>, signal?: AbortSignal) {
  const res = await fetch("/api/apps/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, config }),
    signal,
  });
  if (!res.ok) throw new Error(`preview → ${res.status}`);
  return URL.createObjectURL(await res.blob());
}
