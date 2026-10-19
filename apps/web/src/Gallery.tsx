import { useEffect, useState } from "react";
import type { Scene } from "@papershow/scene";
import { deleteImage, fileUrl, getImage, imageUrl, listImages, type ImageMeta } from "./store";
import { setLive } from "./slides";
import { mine, tint, useMe } from "./house";
import { useLiveState } from "./live";

type Props = {
  open: boolean;
  refreshKey: number;
  currentId: string;
  onClose: () => void;
  onOpen: (scene: Scene) => void;
  /** Seconds Show now holds the panel. */
  showFor?: number;
  onLive: (name: string) => void;
};

export function Gallery({ open, refreshKey, currentId, onClose, onOpen, showFor, onLive }: Props) {
  const [items, setItems] = useState<ImageMeta[] | null>(null);
  const { me } = useMe();
  const everyone = useLiveState().state?.people ?? [];

  useEffect(() => {
    if (open) listImages().then(setItems, () => setItems([]));
  }, [open, refreshKey]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const remove = async (id: string) => {
    await deleteImage(id);
    setItems((xs) => xs?.filter((x) => x.id !== id) ?? null);
  };

  const live = async (item: ImageMeta) => {
    await setLive({ mode: "pin", source: { kind: "image", id: item.id }, forS: showFor, from: "draw" });
    onLive(item.name);
  };

  return (
    <>
      <div className="scrim" data-on={open} onClick={onClose} />
      <aside className="sheet" data-on={open} aria-hidden={!open}>
        <div className="sheet-head">
          <h2>Gallery</h2>
          <button className="ghost" onClick={onClose}>Close</button>
        </div>
        {items?.length === 0 ? (
          <p className="empty">Nothing saved yet. Press ⌘S to save what's on the panel.</p>
        ) : (
          <ul className="grid">
            {items?.map((item) => (
              <li key={item.id} data-current={item.id === currentId}>
                <button
                  className="thumb"
                  onClick={async () => onOpen((await getImage(item.id)).scene)}
                  aria-label={`Edit ${item.name}`}
                >
                  <img src={fileUrl(item)} alt="" />
                </button>
                <div className="meta">
                  <span className="title">
                    {(() => {
                      const maker = everyone.find((p) => p.id === item.madeBy);
                      return maker ? <span className="face-mini" style={tint(maker.color)} title={`By ${maker.name}`}>{maker.face}</span> : null;
                    })()}{" "}
                    {item.name}
                  </span>
                  <span className="actions">
                    <button onClick={() => live(item)}>Show on /live</button>
                    <a href={imageUrl(item.id)} target="_blank" rel="noreferrer">Open ↗</a>
                    {mine(me, item.madeBy) && <button onClick={() => remove(item.id)}>Delete</button>}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </>
  );
}
