import { useEffect, useState } from "react";
import { fileUrl, getImage, type ImageMeta } from "./store";

/** /i/:id — the saved image on its own, ready to look at, drag out, or download. */
export function Viewer({ id }: { id: string }) {
  const [image, setImage] = useState<ImageMeta | null | undefined>(undefined);
  const [mode, setMode] = useState<"mono" | "png">(
    new URLSearchParams(location.search).get("v") === "ink" ? "png" : "mono",
  );

  useEffect(() => {
    getImage(id).then(
      (img) => {
        setImage(img);
        document.title = img.name;
      },
      () => setImage(null),
    );
  }, [id]);

  if (image === undefined) return null;
  if (image === null) return <div className="viewer"><p className="empty">This image doesn't exist.</p></div>;

  const src = fileUrl(image, mode);
  const file = `${image.name.trim() || "image"}${mode === "mono" ? "" : "-ink"}.png`;

  return (
    <div className="viewer">
      <img src={src} alt={image.name} width={800} height={480} />
      <footer>
        <span className="title">{image.name}</span>
        <div className="segmented" role="radiogroup" aria-label="Version">
          <button role="radio" aria-checked={mode === "mono"} onClick={() => setMode("mono")}>E-ink</button>
          <button role="radio" aria-checked={mode === "png"} onClick={() => setMode("png")}>Ink</button>
        </div>
        <a className="primary" href={src} download={file}>Download PNG</a>
      </footer>
    </div>
  );
}
