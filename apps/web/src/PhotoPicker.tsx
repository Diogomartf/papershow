import { useEffect } from "react";
import { fileUrl, type ImageMeta } from "./store";
import { cue } from "./sound";

/** Draw's Photo: one of the house's photos, framed as it is in Photos, or a picture from this device. */
export function PhotoPicker({
  open,
  photos,
  onClose,
  onPick,
  onDevice,
}: {
  open: boolean;
  photos: ImageMeta[];
  onClose: () => void;
  onPick: (id: string) => void;
  onDevice: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (cue("close"), onClose());
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      <div className="scrim" data-on={open} data-cuelume-close onClick={onClose} />
      <aside className="sheet" data-on={open} aria-hidden={!open}>
        <div className="sheet-head">
          <h2>Draw on a photo</h2>
          <button className="ghost" data-cuelume-close onClick={onClose}>Close</button>
        </div>
        <div className="picker-device">
          <button className="ghost" onClick={onDevice}>From this device…</button>
        </div>
        <ul className="grid">
          {photos.map((p) => (
            <li key={p.id}>
              <button className="thumb" onClick={() => onPick(p.id)} aria-label={`Draw on ${p.name}`}>
                <img src={fileUrl(p, "png")} alt="" loading="lazy" />
              </button>
              <div className="meta">
                <span className="title">{p.name}</span>
              </div>
            </li>
          ))}
        </ul>
      </aside>
    </>
  );
}
