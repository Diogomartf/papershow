import { useEffect, useState } from "react";
import { fileUrl, getImage, type ImageMeta } from "./store";
import { useLights } from "./theme";
import { navigate } from "./Nav";
import { cue } from "./sound";
import type { Scene } from "@papershow/scene";

/** Back where you came from in Papershow; opened on its own (a new tab, a shared link), home. */
const goBack = () => (cue(["navigate", { direction: "back" }]), history.state?.from ? history.back() : navigate("/"));

/** /i/:id — the saved image on its own, ready to look at, drag out, or download. */
export function Viewer({ id }: { id: string }) {
  useLights();
  const [image, setImage] = useState<(ImageMeta & { scene: Scene }) | null | undefined>(undefined);
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
  // Over a photo, the Ink copy is a JPEG.
  const ext = mode === "png" && image.scene.photo ? "jpg" : "png";
  const file = `${image.name.trim() || "image"}${mode === "mono" ? "" : "-ink"}.${ext}`;

  return (
    <div className="viewer">
      <button className="pg-big viewer-back" data-quiet onClick={goBack}>
        <span aria-hidden>←</span> Back
      </button>
      <img src={src} alt={image.name} width={800} height={480} />
      <footer>
        <span className="title">{image.name}</span>
        <div className="segmented" role="radiogroup" aria-label="Version">
          <button role="radio" aria-checked={mode === "mono"} onClick={() => setMode("mono")}>E-ink</button>
          <button role="radio" aria-checked={mode === "png"} onClick={() => setMode("png")}>Ink</button>
        </div>
        <a className="ghost" href={`/draw?open=${encodeURIComponent(image.id)}`}>Open in Draw</a>
        <a className="primary" href={src} download={file}>Download</a>
      </footer>
    </div>
  );
}
