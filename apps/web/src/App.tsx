import { useCallback, useEffect, useRef, useState } from "react";
import { Draw, type DrawHandle, type Stroke } from "drawesome";
import "drawesome/styles.css";
import { PANEL, type Scene } from "@imagegen/scene";
import { paintMono, renderScene } from "./render";
import { getDraft, imageUrl, putDraft, putImage } from "./store";
import { Gallery } from "./Gallery";

// Ink mode: greys dither, colours become greys.
const SWATCHES = ["#111111", "#555555", "#999999", "#d4d4d4", "#ffffff", "#e5484d", "#f5a524", "#3e63dd", "#30a46c"];
// E-ink mode: only what the panel can actually show.
const SWATCHES_EINK = ["#000000", "#ffffff"];

const newScene = (): Scene => {
  const now = Date.now();
  return {
    id: crypto.randomUUID().slice(0, 8),
    name: "Untitled",
    width: PANEL.w,
    height: PANEL.h,
    background: "#ffffff",
    strokes: [],
    createdAt: now,
    updatedAt: now,
  };
};

type View = "ink" | "eink";

export default function App() {
  const draw = useRef<DrawHandle>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const [scene, setScene] = useState<Scene | null>(null);
  const [view, setView] = useState<View>("ink");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryKey, setGalleryKey] = useState(0);

  useEffect(() => {
    getDraft().then((d) => setScene(d ?? newScene()));
  }, []);

  // Keep the draft and the e-ink preview in step with the drawing.
  useEffect(() => {
    if (!scene) return;
    putDraft(scene);
    if (view === "eink" && preview.current) paintMono(scene, preview.current);
  }, [scene, view]);

  const onStrokes = useCallback((strokes: Stroke[]) => {
    setScene((s) => (s ? { ...s, strokes, updatedAt: Date.now() } : s));
  }, []);

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2400);
  };

  const save = useCallback(async () => {
    if (!scene || saving) return;
    // Open the tab now, while we still hold the click: a tab opened after an
    // await is a popup as far as Safari is concerned.
    const tab = window.open("", "_blank");
    setSaving(true);
    try {
      const current = { ...scene, strokes: draw.current?.getStrokes() ?? scene.strokes, updatedAt: Date.now() };
      const { png, mono } = await renderScene(current);
      await putImage({ id: current.id, scene: current, png, mono });
      setScene(current);
      setGalleryKey((k) => k + 1);
      if (tab) tab.location.href = imageUrl(current.id);
      flash(tab ? "Saved · opened in a new tab" : "Saved");
    } catch (err) {
      tab?.close();
      flash("Couldn't save. Try again");
      console.error(err);
    } finally {
      setSaving(false);
    }
  }, [scene, saving]);

  const open = (s: Scene) => {
    setScene(s);
    draw.current?.setStrokes(s.strokes);
    setGalleryOpen(false);
  };

  const startNew = () => {
    const s = newScene();
    setScene(s);
    draw.current?.setStrokes([]);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  if (!scene) return null;

  return (
    <div className="app">
      <header className="bar">
        <div className="bar-left">
          <span className="mark" aria-hidden />
          <input
            className="name"
            value={scene.name}
            onChange={(e) => setScene({ ...scene, name: e.target.value })}
            onFocus={(e) => e.target.select()}
            aria-label="Image name"
            spellCheck={false}
          />
        </div>

        <div className="segmented" role="radiogroup" aria-label="Preview">
          {(["ink", "eink"] as const).map((v) => (
            <button key={v} role="radio" aria-checked={view === v} onClick={() => setView(v)}>
              {v === "ink" ? "Ink" : "E-ink"}
            </button>
          ))}
        </div>

        <div className="bar-right">
          <button className="ghost" onClick={startNew}>New</button>
          <button className="ghost" onClick={() => setGalleryOpen(true)}>Gallery</button>
          <button className="primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save & open"}
            <kbd>⌘S</kbd>
          </button>
        </div>
      </header>

      <main className="stage">
        <div className="device">
          <div className="panel">
            <Draw
              ref={draw}
              board={{ w: scene.width, h: scene.height }}
              background="transparent"
              initialStrokes={scene.strokes}
              onChange={onStrokes}
              swatches={view === "eink" ? SWATCHES_EINK : SWATCHES}
              controls={{ custom: view !== "eink" }}
              look="studio"
              theme="light"
              inset={-102}
            />
            <canvas ref={preview} className="eink" data-on={view === "eink"} aria-hidden />
          </div>
          <span className="ribbon" aria-hidden />
        </div>
        <div className="shelf" aria-hidden>
          <span className="engraving">Waveshare 7.5″ · {scene.width}×{scene.height} · 1-bit</span>
        </div>
      </main>

      <Gallery
        open={galleryOpen}
        refreshKey={galleryKey}
        currentId={scene.id}
        onClose={() => setGalleryOpen(false)}
        onOpen={open}
      />

      <div className="toast" data-on={!!toast} role="status">{toast}</div>
    </div>
  );
}
