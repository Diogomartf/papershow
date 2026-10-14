// Saved images live on the server (SlideGen), so every device sees the same set.
// Only the draft being edited stays in this browser's IndexedDB.
import { Oops, signedOut } from "./house";
import type { Scene } from "@papershow/scene";

export type ImageMeta = { id: string; name: string; updatedAt: number; madeBy: string | null };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (res.status === 401) signedOut();
  if (!res.ok) throw new Oops(`${init?.method ?? "GET"} ${path} → ${res.status}`, res.status, {});
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const listImages = () => api<ImageMeta[]>("/api/images");
export const getImage = (id: string) => api<ImageMeta & { scene: Scene }>(`/api/images/${id}`);
export const deleteImage = (id: string) => api<void>(`/api/images/${id}`, { method: "DELETE" });

export function putImage(scene: Scene, files: { png: Blob; mono: Blob; bin: Blob }) {
  const form = new FormData();
  form.set("scene", JSON.stringify(scene));
  form.set("png", files.png);
  form.set("mono", files.mono);
  form.set("bin", files.bin);
  return api<ImageMeta>(`/api/images/${scene.id}`, { method: "PUT", body: form });
}

/** The image file itself. `v` busts the cache when the image is re-saved. */
export const fileUrl = (img: ImageMeta, kind: "mono" | "png" = "mono") =>
  `/api/images/${img.id}/${kind}.png?v=${img.updatedAt}`;

/** The page that shows a saved image on its own. */
export const imageUrl = (id: string) => `/i/${id}`;

// ── Draft ──────────────────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("imagegen", 2);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("kv")) req.result.createObjectStore("kv");
      if (req.result.objectStoreNames.contains("images")) req.result.deleteObjectStore("images");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function kv<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction("kv", mode).objectStore("kv"));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const getDraft = () => kv<Scene | undefined>("readonly", (s) => s.get("draft"));
export const putDraft = (scene: Scene) => kv<void>("readwrite", (s) => s.put(scene, "draft"));

/** The drawing as last saved, as JSON: a draft that still matches it holds nothing new. */
export const getSaved = () => kv<string | undefined>("readonly", (s) => s.get("saved"));
export const putSaved = (scene: Scene) => kv<void>("readwrite", (s) => s.put(JSON.stringify(scene), "saved"));
