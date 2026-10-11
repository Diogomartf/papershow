// A playlist item shows a source: a drawing from Draw, or an app instance.
// This gives both the same shape so the playlist doesn't care which it is.
import { useCallback, useEffect, useMemo, useState } from "react";
import { appFrameUrl, getCatalog, listApps, type AppKind } from "./apps";
import { fileUrl, listImages } from "./store";

export type Source = { kind: "image" | "app"; id: string };
export type Item = { source: Source; key: string; name: string; thumb: string; label: string };

export const keyOf = (s: Source) => `${s.kind}:${s.id}`;
export const parseKey = (key: string): Source | null => {
  const [kind, id] = key.split(":");
  return (kind === "image" || kind === "app") && id ? { kind, id } : null;
};

/** Every drawing and app instance, refreshed when the window regains focus. */
export function useItems() {
  const [items, setItems] = useState<Item[]>([]);
  const [catalog, setCatalog] = useState<AppKind[]>([]);

  const load = useCallback(async () => {
    const [images, apps, kinds] = await Promise.all([listImages(), listApps(), getCatalog()]);
    const name = new Map(kinds.map((k) => [k.kind, k.name]));
    setCatalog(kinds);
    setItems([
      ...apps.map((a) => ({
        source: { kind: "app" as const, id: a.id },
        key: `app:${a.id}`,
        name: a.name,
        thumb: appFrameUrl(a),
        label: name.get(a.kind) ?? "App",
      })),
      ...images.map((i) => ({
        source: { kind: "image" as const, id: i.id },
        key: `image:${i.id}`,
        name: i.name,
        thumb: fileUrl(i),
        label: "Drawing",
      })),
    ]);
  }, []);

  useEffect(() => {
    const run = () => void load().catch(() => {});
    run();
    addEventListener("focus", run);
    return () => removeEventListener("focus", run);
  }, [load]);

  const byKey = useMemo(() => new Map(items.map((i) => [i.key, i])), [items]);
  const itemOf = useCallback((s: Source | null | undefined) => (s ? byKey.get(keyOf(s)) : undefined), [byKey]);
  return { items, itemOf, catalog, reload: load };
}
