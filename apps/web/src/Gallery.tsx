import { useEffect, useState } from "react";
import type { Scene } from "@imagegen/scene";
import { deleteImage, imageUrl, listImages, type SavedImage } from "./store";

type Props = {
  open: boolean;
  refreshKey: number;
  currentId: string;
  onClose: () => void;
  onOpen: (scene: Scene) => void;
};

export function Gallery({ open, refreshKey, currentId, onClose, onOpen }: Props) {
  const [items, setItems] = useState<(SavedImage & { thumb: string })[]>([]);

  useEffect(() => {
    if (!open) return;
    let urls: string[] = [];
    listImages().then((list) => {
      const withThumbs = list.map((i) => ({ ...i, thumb: URL.createObjectURL(i.mono) }));
      urls = withThumbs.map((i) => i.thumb);
      setItems(withThumbs);
    });
    return () => urls.forEach(URL.revokeObjectURL);
  }, [open, refreshKey]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const remove = async (id: string) => {
    await deleteImage(id);
    setItems((xs) => xs.filter((x) => x.id !== id));
  };

  return (
    <>
      <div className="scrim" data-on={open} onClick={onClose} />
      <aside className="sheet" data-on={open} aria-hidden={!open}>
        <div className="sheet-head">
          <h2>Gallery</h2>
          <button className="ghost" onClick={onClose}>Close</button>
        </div>
        {items.length === 0 ? (
          <p className="empty">Nothing saved yet. Press ⌘S to save what's on the panel.</p>
        ) : (
          <ul className="grid">
            {items.map((item) => (
              <li key={item.id} data-current={item.id === currentId}>
                <button className="thumb" onClick={() => onOpen(item.scene)} aria-label={`Edit ${item.scene.name}`}>
                  <img src={item.thumb} alt="" />
                </button>
                <div className="meta">
                  <span className="title">{item.scene.name}</span>
                  <span className="actions">
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
