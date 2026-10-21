import { useEffect, useState } from "react";
import type { Scene } from "@papershow/scene";
import { deleteImage, fileUrl, getImage, imageUrl, listImages, type ImageMeta } from "./store";
import { ask, setLive } from "./slides";
import { mine, tint, useMe } from "./house";
import { useLiveState } from "./live";
import { cue } from "./sound";

type Props = {
  open: boolean;
  refreshKey: number;
  currentId: string;
  onClose: () => void;
  onOpen: (scene: Scene) => void;
  /** Seconds Show now holds the panel. */
  showFor?: number;
  onLive: (name: string) => void;
  onFail: (err: unknown) => void;
};

export function Gallery({ open, refreshKey, currentId, onClose, onOpen, showFor, onLive, onFail }: Props) {
  const [items, setItems] = useState<ImageMeta[] | null>(null);
  const { me } = useMe();
  const everyone = useLiveState().state?.people ?? [];

  useEffect(() => {
    // Photos have their own page; this is what was drawn.
    if (open) listImages().then((xs) => setItems(xs.filter((x) => x.kind !== "photo")), () => setItems([]));
  }, [open, refreshKey]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (cue("close"), onClose());
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const remove = async (id: string) => {
    await deleteImage(id);
    setItems((xs) => xs?.filter((x) => x.id !== id) ?? null);
  };

  /** On the panel now, or, for a guest, ask the household to put it there. */
  const guest = me.role === "guest";
  const live = async (item: ImageMeta) => {
    const source = { kind: "image", id: item.id } as const;
    try {
      await (guest ? ask(source, showFor, "draw") : setLive({ mode: "pin", source, forS: showFor, from: "draw" }));
      onLive(item.name);
    } catch (err) {
      onFail(err);
    }
  };

  return (
    <>
      <div className="scrim" data-on={open} data-cuelume-close onClick={onClose} />
      <aside className="sheet" data-on={open} aria-hidden={!open}>
        <div className="sheet-head">
          <h2>Gallery</h2>
          <button className="ghost" data-cuelume-close onClick={onClose}>Close</button>
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
                    <button onClick={() => live(item)}>{guest ? "Ask to show" : "Show on /live"}</button>
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
