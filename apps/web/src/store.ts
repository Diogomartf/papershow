// Saved images live in IndexedDB until SlideGen exists; then this becomes a fetch client.
import type { Scene } from "@imagegen/scene";

export type SavedImage = {
  id: string;
  scene: Scene;
  /** What you drew, in colour. */
  png: Blob;
  /** What the panel will show: 800×480, dithered to 1 bit. */
  mono: Blob;
};

const DB = "imagegen";
const IMAGES = "images";
const KV = "kv";

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IMAGES, { keyPath: "id" });
      req.result.createObjectStore(KV);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const putImage = (img: SavedImage) => run(IMAGES, "readwrite", (s) => s.put(img));
export const getImage = (id: string) => run<SavedImage | undefined>(IMAGES, "readonly", (s) => s.get(id));
export const deleteImage = (id: string) => run(IMAGES, "readwrite", (s) => s.delete(id));

export async function listImages(): Promise<SavedImage[]> {
  const all = await run<SavedImage[]>(IMAGES, "readonly", (s) => s.getAll());
  return all.sort((a, b) => b.scene.updatedAt - a.scene.updatedAt);
}

/** The scene being edited, so a refresh never loses work. */
export const getDraft = () => run<Scene | undefined>(KV, "readonly", (s) => s.get("draft"));
export const putDraft = (scene: Scene) => run(KV, "readwrite", (s) => s.put(scene, "draft"));

export const imageUrl = (id: string) => `/i/${id}`;
