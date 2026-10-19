import { useCallback, useEffect, useRef, useState } from "react";
import { Draw, type DrawHandle, type Stroke } from "drawesome";
import "drawesome/styles.css";
import "@fontsource-variable/inter";
import { PANEL, PHOTO_FILL, type PhotoAt, type Scene, type TextItem } from "@papershow/scene";
import { paintMono, photoFor, renderScene } from "./render";
import { getDraft, getImage, getSaved, imageUrl, putDraft, putImage, putSaved } from "./store";
import { Oops, reason, useMe } from "./house";
import { Gallery } from "./Gallery";
import { ask, setLive } from "./slides";
import { useLiveState, useNow } from "./live";
import { Nav } from "./Nav";
import { useNarrow } from "./media";
import { LightSwitch } from "./LightSwitch";
import { MeMenu } from "./MeMenu";
import { TextLayer } from "./TextLayer";
import { PhotoLayer } from "./PhotoLayer";
import { shortId } from "./id";

// Ink mode: greys dither, colours become greys.
const SWATCHES = ["#111111", "#555555", "#999999", "#d4d4d4", "#ffffff", "#e5484d", "#f5a524", "#3e63dd", "#30a46c"];
// E-ink mode: only what the panel can actually show.
const SWATCHES_EINK = ["#000000", "#ffffff"];

const UNTITLED = "Untitled";

/** How long Show now holds the panel, in seconds. A quick doodle is up for five minutes unless you pick otherwise. */
const SHOW_FOR = [
  { s: 60, label: "1 min" },
  { s: 5 * 60, label: "5 min" },
  { s: 10 * 60, label: "10 min" },
  { s: 30 * 60, label: "30 min" },
  { s: 60 * 60, label: "1 hour" },
  { s: 3 * 60 * 60, label: "3 hours" },
];
const SHOW_FOR_KEY = "draw-show-for";

function savedShowFor(): number {
  try {
    const s = Number(localStorage.getItem(SHOW_FOR_KEY));
    if (SHOW_FOR.some((o) => o.s === s)) return s;
  } catch {
    // No storage (a private window): the default will do.
  }
  return 5 * 60;
}

/** "until 18:45", for a Show now that's up. */
const until = (t: number | null | undefined) =>
  t ? `until ${new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : "now";

const forLabel = (s: number) => SHOW_FOR.find((o) => o.s === s)?.label ?? `${Math.round(s / 60)} min`;

const newScene = (): Scene => {
  const now = Date.now();
  return {
    id: shortId(),
    name: UNTITLED,
    width: PANEL.w,
    height: PANEL.h,
    background: "#ffffff",
    strokes: [],
    texts: [],
    createdAt: now,
    updatedAt: now,
  };
};

/** A name from the first words on the drawing. Empty text stays Untitled. */
function nameFromText(texts: TextItem[] | undefined): string {
  for (const item of texts ?? []) {
    const line = item.text.replace(/\s+/g, " ").trim();
    if (!line) continue;
    if (line.length <= 48) return line;
    const cut = line.slice(0, 48);
    const at = cut.lastIndexOf(" ");
    return (at > 16 ? cut.slice(0, at) : cut).trimEnd();
  }
  return UNTITLED;
}

type View = "ink" | "eink";

/** What the panel would show of a drawing: two scenes with the same key look the same. */
const looksKey = (s: Scene) => JSON.stringify([s.strokes, s.texts ?? [], s.photo ?? null, s.photo ? (s.photoAt ?? PHOTO_FILL) : null]);

export default function App() {
  const draw = useRef<DrawHandle>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const [scene, setScene] = useState<Scene | null>(null);
  const [view, setView] = useState<View>("ink");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryKey, setGalleryKey] = useState(0);
  // Text mode: clicks on the panel type instead of draw.
  const [typing, setTyping] = useState(false);
  // Photo mode: dragging on the panel moves and resizes the photo instead of drawing.
  const [placing, setPlacing] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const narrow = useNarrow();
  const [showFor, setShowFor] = useState(savedShowFor);
  // Show now: "sending" while it saves and goes up, then "on" for a moment to celebrate.
  const [beam, setBeam] = useState<"sending" | "on" | null>(null);
  // How the drawing looked when last saved, so Show now can tell it's already up as it is.
  const [savedLooks, setSavedLooks] = useState<string | null>(null);
  const { state: live, accept, skew } = useLiveState();
  // A guest's Show now asks the household first.
  const guest = useMe().me.role === "guest";
  const now = useNow(skew, 5000);
  const photoInput = useRef<HTMLInputElement>(null);
  // True once the name field is typed in. Until then the name follows the text, instead of staying Untitled.
  const nameEdited = useRef(false);

  /** A drawing nobody named takes its name from its text. A name that already is that text still follows it. */
  const adopt = (s: Scene): Scene => {
    const fromText = nameFromText(s.texts);
    const untouched = !s.name.trim() || s.name === UNTITLED || s.name === fromText;
    nameEdited.current = !untouched;
    return untouched ? { ...s, name: fromText } : s;
  };

  useEffect(() => {
    document.title = "Draw · Papershow";
    // /draw?open=<id> (from a picture's own page) opens that drawing, as saved.
    const id = new URLSearchParams(location.search).get("open");
    if (id) {
      history.replaceState(null, "", "/draw");
      getImage(id).then(
        ({ scene }) => {
          putSaved(scene);
          setSavedLooks(looksKey(scene));
          setScene(adopt(scene));
        },
        () => setScene(newScene()),
      );
      return;
    }
    // Coming back to Draw starts a new canvas, unless the last one has changes that weren't saved.
    Promise.all([getDraft(), getSaved()]).then(([d, saved]) => {
      if (saved) setSavedLooks(looksKey(JSON.parse(saved) as Scene));
      setScene(adopt(d && JSON.stringify(d) !== saved ? d : newScene()));
    });
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

  const onPhotoAt = useCallback((photoAt: PhotoAt) => {
    setScene((s) => (s ? { ...s, photoAt, updatedAt: Date.now() } : s));
  }, []);

  const onTexts = useCallback((texts: TextItem[]) => {
    setScene((s) => (s ? { ...s, texts, name: nameEdited.current ? s.name : nameFromText(texts), updatedAt: Date.now() } : s));
  }, []);

  // Picking a pen from the drawing toolbar goes back to drawing.
  const loaded = scene !== null;
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const onDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('[class*="Draw_toolbar"]')) {
        setTyping(false);
        setPlacing(false);
      }
    };
    el.addEventListener("pointerdown", onDown, true);
    return () => el.removeEventListener("pointerdown", onDown, true);
  }, [loaded]);

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2400);
  };

  /**
   * Saves the drawing; then, with `then`, opens the saved picture in a new tab, or shows it on the panel now
   * (once: the playlists carry on after).
   */
  const save = useCallback(async (then?: "open" | "show") => {
    if (!scene || saving) return;
    // Open the tab now, while we still hold the click: a tab opened after an
    // await is a popup as far as Safari is concerned.
    const tab = then === "open" ? window.open("", "_blank") : null;
    setSaving(true);
    if (then === "show") setBeam("sending");
    try {
      let current = { ...scene, strokes: draw.current?.getStrokes() ?? scene.strokes, updatedAt: Date.now() };
      const files = await renderScene(current);
      let copied = false;
      try {
        await putImage(current, files);
      } catch (err) {
        // Someone else's drawing: keep theirs as it is and save yours as a copy.
        if (!(err instanceof Oops && err.status === 403)) throw err;
        current = { ...current, id: shortId(), name: `${current.name} (my version)` };
        nameEdited.current = true;
        await putImage(current, files);
        copied = true;
      }
      await putSaved(current);
      setSavedLooks(looksKey(current));
      setScene(current);
      setGalleryKey((k) => k + 1);
      if (tab) tab.location.href = imageUrl(current.id);
      if (then === "show" && guest) {
        accept(await ask({ kind: "image", id: current.id }, showFor, "draw"));
        setBeam(null);
      } else if (then === "show") {
        accept(await setLive({ mode: "pin", source: { kind: "image", id: current.id }, forS: showFor, from: "draw" }));
        setBeam("on");
        window.setTimeout(() => setBeam((b) => (b === "on" ? null : b)), 1800);
      }
      const saved = copied ? "Saved as your own copy" : "Saved";
      const shown = guest ? "asked to show it 🙋" : `on the panel for ${forLabel(showFor)}`;
      flash(then === "show" ? `${saved} · ${shown}` : tab ? `${saved} · opened in a new tab` : saved);
    } catch (err) {
      setBeam(null);
      tab?.close();
      flash(reason(err, "Couldn't save. Try again"));
      console.error(err);
    } finally {
      setSaving(false);
    }
  }, [scene, saving, showFor, accept, guest]);

  const pickFor = (s: number) => {
    setShowFor(s);
    try {
      localStorage.setItem(SHOW_FOR_KEY, String(s));
    } catch {
      // Not remembered, but still used this time.
    }
  };

  /** A photo goes under the drawing, filling the panel, ready to be moved, resized and turned. */
  const onPhoto = async (file: File | undefined) => {
    if (!file || !scene) return;
    try {
      const photo = await photoFor(file);
      const name = nameEdited.current || scene.name !== UNTITLED ? scene.name : file.name.replace(/\.[^.]+$/, "");
      setScene((s) => (s ? { ...s, photo, photoAt: PHOTO_FILL, name, updatedAt: Date.now() } : s));
      setTyping(false);
      setPlacing(true);
    } catch (err) {
      flash("Couldn't open that picture");
      console.error(err);
    }
  };

  const open = (s: Scene) => {
    // As saved: only changes to it keep it on the board when you come back.
    putSaved(s);
    setSavedLooks(looksKey(s));
    setScene(adopt(s));
    draw.current?.setStrokes(s.strokes);
    setPlacing(false);
    setGalleryOpen(false);
  };

  const startNew = () => {
    nameEdited.current = false;
    const s = newScene();
    setScene(s);
    setTyping(false);
    setPlacing(false);
    draw.current?.setStrokes([]);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
      // T for text, Escape back to drawing, unless you're typing somewhere.
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === "t") {
        setTyping((t) => !t);
        setPlacing(false);
      }
      if (e.key === "Escape") {
        setTyping(false);
        setPlacing(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  if (!scene) return null;

  // Already on the panel, just as it is: sending it again would only flash the panel. A change, or its time running out, frees it.
  const pin = live?.live.mode === "pin" ? live.live : null;
  const alreadyUp =
    !!pin && pin.source.kind === "image" && pin.source.id === scene.id && (!pin.until || now < pin.until) && looksKey(scene) === savedLooks;
  // A guest who already asked to show it, just as it is, waits for the answer. Saving a change takes the ask back.
  const asked = guest && looksKey(scene) === savedLooks && !!live?.asks.some((a) => a.source.kind === "image" && a.source.id === scene.id);

  return (
    <div className="app">
      <header className="bar">
        <div className="bar-left">
          <Nav current="draw" />
          <span className="divider" aria-hidden />
          <input
            className="name"
            value={scene.name}
            onChange={(e) => {
              nameEdited.current = true;
              setScene({ ...scene, name: e.target.value });
            }}
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

        <div className="bar-right draw-actions">
          <LightSwitch />
          <button
            className="ghost text-toggle"
            aria-pressed={typing}
            onClick={() => {
              setTyping((t) => !t);
              setPlacing(false);
            }}
            title={typing ? "Back to drawing (Esc)" : "Type on the panel (T)"}
          >
            <span aria-hidden className="text-glyph">T</span> <span className="text-label">Text</span>
          </button>
          <button className="ghost" onClick={startNew}>New</button>
          {scene.photo ? (
            // The photo on the drawing, and what you can do with it, together.
            <span className="photo-card">
              <img src={scene.photo} alt="" />
              <button
                className="ghost"
                aria-pressed={placing}
                onClick={() => {
                  setPlacing((p) => !p);
                  setTyping(false);
                }}
                title={placing ? "Back to drawing (Esc)" : "Move, resize or turn the photo"}
              >
                Move
              </button>
              <button
                className="ghost"
                onClick={() => {
                  setScene({ ...scene, photo: undefined, photoAt: undefined, updatedAt: Date.now() });
                  setPlacing(false);
                }}
                title="Take the photo off, keep the drawing"
              >
                Remove
              </button>
            </span>
          ) : (
            <button className="ghost" onClick={() => photoInput.current?.click()} title="Put a photo on the panel, and draw on it if you like">
              Photo
            </button>
          )}
          <input
            ref={photoInput}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              onPhoto(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <button className="ghost" onClick={() => setGalleryOpen(true)}>Gallery</button>
          <button className="ghost" onClick={() => save("open")} disabled={saving} title="Save, then open the picture in a new tab">
            Open
          </button>
          <span className="show-now" data-beam={beam ?? undefined} data-up={alreadyUp && !beam}>
            <button
              onClick={() => save("show")}
              disabled={saving || alreadyUp || asked}
              title={
                alreadyUp
                  ? "It's on the panel now. Change something to send it again"
                  : asked
                    ? "Someone in the house says yes, then it goes on the panel"
                    : guest
                      ? `Save, then ask someone in the house to put it on the panel for ${forLabel(showFor)}`
                      : `Save, then put it on the panel for ${forLabel(showFor)}, ahead of the program`
              }
            >
              <span className="show-now-dot" aria-hidden />
              <span className="show-now-word">
                {beam === "on"
                  ? "On air!"
                  : beam === "sending"
                    ? guest ? "Asking…" : "Beaming…"
                    : alreadyUp
                      ? `On air · ${until(pin?.until)}`
                      : asked
                        ? "Asked"
                        : guest
                          ? "Ask to show"
                          : "Show now"}
              </span>
            </button>
            <select value={showFor} onChange={(e) => pickFor(Number(e.target.value))} aria-label="For how long">
              {SHOW_FOR.map((o) => (
                <option key={o.s} value={o.s}>{o.label}</option>
              ))}
            </select>
          </span>
          <button className="primary" onClick={() => save()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
            <kbd>⌘S</kbd>
          </button>
          <MeMenu />
        </div>
      </header>

      <main className="stage">
        <div className="device">
          <div
            className="panel"
            ref={panel}
            data-typing={typing}
          >
            {scene.photo && (
              <PhotoLayer
                photo={scene.photo}
                at={scene.photoAt ?? PHOTO_FILL}
                onChange={onPhotoAt}
                active={placing}
                onDone={() => setPlacing(false)}
                hidden={view === "eink"}
              />
            )}
            <Draw
              ref={draw}
              board={{ w: scene.width, h: scene.height }}
              background="transparent"
              initialStrokes={scene.strokes}
              onChange={onStrokes}
              swatches={view === "eink" ? SWATCHES_EINK : SWATCHES}
              // A phone can't fit all seven pens: keep the essentials and the controls that matter.
              tools={narrow ? ["pencil", "pen", "marker", "brush"] : undefined}
              controls={narrow ? { custom: false, opacity: false, minimize: false, clear: false } : { custom: view !== "eink" }}
              look="studio"
              theme="light"
              inset={narrow ? -88 : -102}
            />
            <TextLayer texts={scene.texts ?? []} onChange={onTexts} active={typing} />
            <canvas ref={preview} className="eink" data-on={view === "eink"} aria-hidden />
          </div>
          <span className="ribbon" aria-hidden />
        </div>
        <div className="shelf" aria-hidden>
          <span className="engraving">
            {placing
              ? "Drag to move · pinch or scroll to resize · Esc to draw"
              : typing ? "Click to type · drag to move · Esc to draw" : `Waveshare 7.5″ · ${scene.width}×${scene.height} · 1-bit`}
          </span>
        </div>
      </main>

      <Gallery
        open={galleryOpen}
        refreshKey={galleryKey}
        currentId={scene.id}
        onClose={() => setGalleryOpen(false)}
        onOpen={open}
        showFor={showFor}
        onLive={(name) => flash(guest ? `Asked to show ${name} 🙋` : `${name} is on the panel for ${forLabel(showFor)}`)}
        onFail={(err) => flash(reason(err, "That didn't work"))}
      />

      <div className="toast" data-on={!!toast} role="status">{toast}</div>
    </div>
  );
}
