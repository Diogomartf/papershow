import { useEffect, useState } from "react";
import { getImage, type SavedImage } from "./store";

/** /i/:id — the saved image on its own, ready to look at, drag out, or download. */
export function Viewer({ id }: { id: string }) {
  const [image, setImage] = useState<SavedImage | null | undefined>(undefined);
  const [mode, setMode] = useState<"mono" | "png">(
    new URLSearchParams(location.search).get("v") === "ink" ? "png" : "mono",
  );
  const [src, setSrc] = useState<string>();

  useEffect(() => {
    getImage(id).then((img) => setImage(img ?? null));
  }, [id]);

  useEffect(() => {
    if (!image) return;
    const url = URL.createObjectURL(image[mode]);
    setSrc(url);
    document.title = image.scene.name;
    return () => URL.revokeObjectURL(url);
  }, [image, mode]);

  if (image === undefined) return null;
  if (image === null) return <div className="viewer"><p className="empty">This image doesn't exist on this device.</p></div>;

  const file = `${image.scene.name.trim() || "image"}${mode === "mono" ? "" : "-ink"}.png`;

  return (
    <div className="viewer">
      <img src={src} alt={image.scene.name} width={image.scene.width} height={image.scene.height} />
      <footer>
        <span className="title">{image.scene.name}</span>
        <div className="segmented" role="radiogroup" aria-label="Version">
          <button role="radio" aria-checked={mode === "mono"} onClick={() => setMode("mono")}>E-ink</button>
          <button role="radio" aria-checked={mode === "png"} onClick={() => setMode("png")}>Ink</button>
        </div>
        <a className="primary" href={src} download={file}>Download PNG</a>
      </footer>
    </div>
  );
}
