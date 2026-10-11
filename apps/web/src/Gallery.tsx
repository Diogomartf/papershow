import { useEffect, useState } from "react";
import type { Scene } from "@papershow/scene";
import { deleteImage, fileUrl, getImage, imageUrl, listImages, type ImageMeta } from "./store";
import { setLive } from "./slides";

type Props = {
  open: boolean;
  refreshKey: number;
  currentId: string;
  onClose: () => void;
  onOpen: (scene: Scene) => void;
  onLive: (name: string) => void;
};

export function Gallery({ open, refreshKey, currentId, onClose, onOpen, onLive }: Props) {
  const [items, setItems] = useState<ImageMeta[] | null>(null);

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
    await setLive({ mode: "pin", source: { kind: "image", id: item.id } });
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
                  <span className="title">{item.name}</span>
                  <span className="actions">
                    <button onClick={() => live(item)}>Show on /live</button>
                    <a href={imageUrl(item.id)} target="_blank" rel="noreferrer">Open ↗</a>
                    <button onClick={() => remove(item.id)}>Delete</button>
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
