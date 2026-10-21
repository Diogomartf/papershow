// A playlist item shows a source: a drawing from Draw, a photo, or an app instance.
// This gives both the same shape so the playlist doesn't care which it is.
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { appFrameUrl, getCatalog, listApps, type AppKind } from "./apps";
import { fileUrl, listImages } from "./store";

export type Source = { kind: "image" | "app"; id: string };
/** `appKind` is which app an app instance is, so a page can pick out the clocks. */
export type Item = { source: Source; key: string; name: string; thumb: string; label: string; appKind?: string };

export const keyOf = (s: Source) => `${s.kind}:${s.id}`;
export const parseKey = (key: string): Source | null => {
  const [kind, id] = key.split(":");
  return (kind === "image" || kind === "app") && id ? { kind, id } : null;
};

type Snapshot = { items: Item[]; catalog: AppKind[] };

// One copy for the whole tab, like the live state: every page starts from what's already loaded instead of from empty.
let snap: Snapshot | null = null;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

/** Fetch every drawing and app instance, and the app kinds. Resolves once the shared copy is fresh. */
export async function loadItems() {
  const [images, apps, kinds] = await Promise.all([listImages(), listApps(), getCatalog()]);
  const name = new Map(kinds.map((k) => [k.kind, k.name]));
  snap = {
    catalog: kinds,
    items: [
      ...apps.map((a) => ({
        source: { kind: "app" as const, id: a.id },
        key: `app:${a.id}`,
        name: a.name,
        thumb: appFrameUrl(a),
        label: name.get(a.kind) ?? "App",
        appKind: a.kind,
      })),
      ...images.map((i) => ({
        source: { kind: "image" as const, id: i.id },
        key: `image:${i.id}`,
        name: i.name,
        thumb: fileUrl(i),
        label: i.kind === "photo" ? "Photo" : "Drawing",
      })),
    ],
  };
  for (const l of listeners) l();
}

const EMPTY: Snapshot = { items: [], catalog: [] };

/** Every drawing and app instance, refreshed when the window regains focus. */
export function useItems() {
  const { items, catalog } = useSyncExternalStore(subscribe, () => snap ?? EMPTY);

  useEffect(() => {
    const run = () => void loadItems().catch(() => {});
    if (!snap) run();
    addEventListener("focus", run);
    return () => removeEventListener("focus", run);
  }, []);

  const byKey = useMemo(() => new Map(items.map((i) => [i.key, i])), [items]);
  const itemOf = useCallback((s: Source | null | undefined) => (s ? byKey.get(keyOf(s)) : undefined), [byKey]);
  return { items, itemOf, catalog, reload: loadItems };
}
