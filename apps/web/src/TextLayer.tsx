import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PANEL, TEXT_FONT, TEXT_LINE, type TextItem } from "@papershow/scene";
import { shortId } from "./id";
import { cue } from "./sound";

const SIZES = [24, 32, 48, 64, 96, 128, 160, 200, 240, 280];
/** How big scaling by a corner can make or shrink a text, in panel pixels. */
const MIN_SIZE = 12;
const MAX_SIZE = 280;
type Corner = "nw" | "ne" | "sw" | "se";
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

/** Screen pixels within which a dragged text snaps to the centre. */
const SNAP_PX = 8;
const DEFAULT_SIZE = 48;

/** Panel pixels from a pointer position over the layer. */
const toPanel = (el: HTMLElement, e: { clientX: number; clientY: number }) => {
  const r = el.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * PANEL.w, y: ((e.clientY - r.top) / r.height) * PANEL.h };
};

/**
 * Words on top of the drawing. While `active`, a click on the panel starts a new line of text,
 * a click on one edits it, and dragging moves it. Otherwise the texts just sit there and pens draw through.
 */
export function TextLayer({
  texts,
  onChange,
  active,
}: {
  texts: TextItem[];
  onChange: (texts: TextItem[]) => void;
  active: boolean;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const [picked, setSelected] = useState<string | null>(null);
  const [typingIn, setEditing] = useState<string | null>(null);
  // Leaving text mode lets go of whatever was selected.
  const selected = active ? picked : null;
  const editing = active ? typingIn : null;
  const drag = useRef<{
    id: string;
    el: HTMLElement;
    dx: number;
    dy: number;
    moved: boolean;
    /** Started inside the text being typed: a click places the caret, only a real drag moves it. */
    typing: boolean;
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);
  // Centre guides while dragging: which lines show.
  const [guides, setGuides] = useState<{ v: boolean; h: boolean } | null>(null);
  // The latest texts for event handlers that outlive a render.
  const latest = useRef(texts);
  useLayoutEffect(() => {
    latest.current = texts;
  });

  const update = (id: string, patch: Partial<TextItem>) =>
    onChange(latest.current.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const remove = (id: string) => {
    onChange(latest.current.filter((t) => t.id !== id));
    setSelected(null);
    setEditing(null);
  };

  // Figma's text size keys, even while typing: ⌘⇧> bigger, ⌘⇧< smaller.
  useEffect(() => {
    if (!active || !selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      const t = latest.current.find((x) => x.id === selected);
      if (!t) return;
      if (e.key === ">" || e.key === ".") {
        e.preventDefault();
        update(t.id, { size: Math.min(MAX_SIZE, t.size + 4) });
      } else if (e.key === "<" || e.key === ",") {
        e.preventDefault();
        update(t.id, { size: Math.max(MIN_SIZE, t.size - 4) });
      }
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  });

  // Delete or Backspace removes the selected text when you aren't typing in it.
  useEffect(() => {
    if (!active || !selected || editing) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "Delete" || e.key === "Backspace") && !(e.target as HTMLElement).closest("input, [contenteditable]")) {
        e.preventDefault();
        cue(["close", { emphasis: "subtle" }]);
        remove(selected);
      }
      if (e.key === "Enter") {
        cue(["open", { emphasis: "subtle" }]);
        setEditing(selected);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  const onLayerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".text-item, .text-tools")) return;
    // Keep focus where we put it: the new text, not the layer.
    e.preventDefault();
    // The first click away just lets go of the current text.
    if (selected || editing) {
      (document.activeElement as HTMLElement | null)?.blur();
      setSelected(null);
      setEditing(null);
      return;
    }
    const p = toPanel(layer.current!, e);
    const t: TextItem = {
      id: shortId(),
      x: Math.round(p.x),
      y: Math.round(p.y - (DEFAULT_SIZE * TEXT_LINE) / 2),
      text: "",
      size: DEFAULT_SIZE,
      bold: false,
      color: "#000000",
    };
    onChange([...latest.current, t]);
    setSelected(t.id);
    setEditing(t.id);
  };

  const onItemDown = (e: React.PointerEvent, t: TextItem) => {
    if (!active) return;
    const typing = editing === t.id;
    // While typing, let the browser place the caret; the drag only takes over once it moves.
    if (!typing) e.preventDefault();
    e.stopPropagation();
    const p = toPanel(layer.current!, e);
    drag.current = {
      id: t.id,
      el: e.currentTarget as HTMLElement,
      dx: p.x - t.x,
      dy: p.y - t.y,
      moved: false,
      typing,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
    };
    if (typing) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSelected(t.id);
  };
  const onItemMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
    if (!d.moved && d.typing) {
      // Dragging the text you're typing: stop typing and pick it up instead of selecting letters.
      getSelection()?.removeAllRanges();
      (document.activeElement as HTMLElement | null)?.blur();
      d.el.setPointerCapture(d.pointerId);
    }
    d.moved = true;
    const box = layer.current!.getBoundingClientRect();
    const scale = PANEL.w / box.width;
    const p = toPanel(layer.current!, e);
    // The text's size in panel pixels, to find its centre.
    const r = d.el.getBoundingClientRect();
    const w = r.width * scale;
    const h = r.height * scale;
    let x = Math.round(p.x - d.dx);
    let y = Math.round(p.y - d.dy);
    // Close to the middle: snap onto it and show the guide, Instagram style.
    const snap = SNAP_PX * scale;
    const v = Math.abs(x + w / 2 - PANEL.w / 2) < snap;
    const hz = Math.abs(y + h / 2 - PANEL.h / 2) < snap;
    if (v) x = (PANEL.w - w) / 2;
    if (hz) y = (PANEL.h - h) / 2;
    // A little tap on phones that can, the moment it locks on.
    if ((v && !guides?.v) || (hz && !guides?.h)) navigator.vibrate?.(8);
    setGuides({ v, h: hz });
    update(d.id, { x, y });
  };
  // Scaling by a corner, like Figma's scale tool: the opposite corner stays put.
  const scaling = useRef<{ id: string; corner: Corner; ax: number; ay: number; w0: number; h0: number; size0: number } | null>(null);
  const [isScaling, setIsScaling] = useState(false);
  const onHandleDown = (e: React.PointerEvent, t: TextItem, corner: Corner) => {
    e.preventDefault();
    e.stopPropagation();
    const el = layer.current?.querySelector<HTMLElement>(`[data-id="${t.id}"]`);
    if (!el || !layer.current) return;
    const scale = PANEL.w / layer.current.getBoundingClientRect().width;
    const r = el.getBoundingClientRect();
    const w0 = r.width * scale;
    const h0 = r.height * scale;
    scaling.current = {
      id: t.id,
      corner,
      ax: corner.includes("e") ? t.x : t.x + w0,
      ay: corner.includes("s") ? t.y : t.y + h0,
      w0,
      h0,
      size0: t.size,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setIsScaling(true);
  };
  const onHandleMove = (e: React.PointerEvent) => {
    const sc = scaling.current;
    if (!sc) return;
    const p = toPanel(layer.current!, e);
    const east = sc.corner.includes("e");
    const south = sc.corner.includes("s");
    // How far the corner is from the anchor, against where it started, whichever way grew more.
    const ratio = Math.max(((east ? p.x - sc.ax : sc.ax - p.x) / sc.w0), ((south ? p.y - sc.ay : sc.ay - p.y) / sc.h0));
    const size = Math.round(Math.min(MAX_SIZE, Math.max(MIN_SIZE, sc.size0 * ratio)));
    const k = size / sc.size0;
    update(sc.id, {
      size,
      x: east ? sc.ax : sc.ax - sc.w0 * k,
      y: south ? sc.ay : sc.ay - sc.h0 * k,
    });
  };
  const onHandleUp = () => {
    scaling.current = null;
    setIsScaling(false);
  };

  const onItemUp = () => {
    const d = drag.current;
    drag.current = null;
    setGuides(null);
    // A click without a drag: start typing (or keep typing, caret where you clicked).
    if (d && !d.moved && !d.typing) setEditing(d.id);
  };

  const sel = texts.find((t) => t.id === selected);

  /** Put a text in the middle of the panel, across (`x`) or up and down (`y`). */
  const center = (t: TextItem, axis: "x" | "y") => {
    const el = layer.current?.querySelector<HTMLElement>(`[data-id="${t.id}"]`);
    if (!el || !layer.current) return;
    const scale = PANEL.w / layer.current.getBoundingClientRect().width;
    const r = el.getBoundingClientRect();
    if (axis === "x") update(t.id, { x: (PANEL.w - r.width * scale) / 2 });
    else update(t.id, { y: (PANEL.h - r.height * scale) / 2 });
  };

  // Keep the tools inside the panel when the text sits near its right edge.
  const tools = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = tools.current;
    if (!el || !layer.current) return;
    el.style.translate = "";
    const over = el.getBoundingClientRect().right - layer.current.getBoundingClientRect().right;
    if (over > 0) el.style.translate = `${-over}px 0`;
  });

  return (
    <div
      ref={layer}
      className="text-layer"
      data-active={active}
      onPointerDown={active ? onLayerDown : undefined}
      aria-hidden={!active}
    >
      {guides && (
        <>
          <span className="guide v" data-on={guides.v} aria-hidden />
          <span className="guide h" data-on={guides.h} aria-hidden />
        </>
      )}
      {/* Like the panel itself, words past the edge don't show. */}
      <div className="text-clip">
      {texts.map((t) => (
        <div
          key={t.id}
          data-id={t.id}
          className="text-item"
          data-selected={selected === t.id}
          data-editing={editing === t.id}
          style={{
            left: `${(t.x / PANEL.w) * 100}%`,
            top: `${(t.y / PANEL.h) * 100}%`,
            fontSize: `calc(${t.size} / ${PANEL.w} * 100cqw)`,
            fontWeight: t.bold ? 700 : 450,
            fontFamily: TEXT_FONT,
            lineHeight: TEXT_LINE,
            color: t.color,
          }}
          onPointerDown={(e) => onItemDown(e, t)}
          onPointerMove={onItemMove}
          onPointerUp={onItemUp}
        >
          {editing === t.id ? (
            <Editable
              text={t.text}
              onInput={(text) => update(t.id, { text })}
              onDone={() => {
                setEditing(null);
                if (!latest.current.find((x) => x.id === t.id)?.text.trim()) remove(t.id);
              }}
            />
          ) : (
            t.text
          )}
          {active && selected === t.id &&
            CORNERS.map((c) => (
              <span
                key={c}
                className={`handle ${c}`}
                aria-hidden
                onPointerDown={(e) => onHandleDown(e, t, c)}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={onHandleUp}
              />
            ))}
        </div>
      ))}
      </div>

      {active && sel && !guides && !isScaling && (
        <div
          ref={tools}
          className="text-tools"
          style={{ left: `${(sel.x / PANEL.w) * 100}%`, top: `${(sel.y / PANEL.h) * 100}%` }}
          // Keep the caret in the text while using the tools.
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <button
            onClick={() => update(sel.id, { size: [...SIZES].reverse().find((s) => s < sel.size) ?? sel.size })}
            disabled={sel.size <= SIZES[0]}
            aria-label="Smaller"
          >
            A−
          </button>
          <span className="tabular">{sel.size}</span>
          <button
            onClick={() => update(sel.id, { size: SIZES.find((s) => s > sel.size) ?? sel.size })}
            disabled={sel.size >= SIZES[SIZES.length - 1]}
            aria-label="Bigger"
          >
            A+
          </button>
          <button aria-pressed={sel.bold} onClick={() => update(sel.id, { bold: !sel.bold })} aria-label="Bold">
            <b>B</b>
          </button>
          <button
            className="swatch-btn"
            onClick={() => update(sel.id, { color: sel.color === "#ffffff" ? "#000000" : "#ffffff" })}
            aria-label={sel.color === "#ffffff" ? "White text, make it black" : "Black text, make it white"}
            title="Black or white"
          >
            <span style={{ background: sel.color }} />
          </button>
          <span className="tools-sep" aria-hidden />
          <button onClick={() => center(sel, "x")} aria-label="Centre horizontally" title="Centre horizontally">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
              <path d="M8 1.5v13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <rect x="3" y="3.5" width="10" height="3" rx="1" fill="currentColor" />
              <rect x="5" y="9.5" width="6" height="3" rx="1" fill="currentColor" />
            </svg>
          </button>
          <button onClick={() => center(sel, "y")} aria-label="Centre vertically" title="Centre vertically">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
              <path d="M1.5 8h13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <rect x="3.5" y="3" width="3" height="10" rx="1" fill="currentColor" />
              <rect x="9.5" y="5" width="3" height="6" rx="1" fill="currentColor" />
            </svg>
          </button>
          <span className="tools-sep" aria-hidden />
          <button className="danger" onClick={() => remove(sel.id)}>Delete</button>
        </div>
      )}
    </div>
  );
}

/** While typing, stop phones zooming in on small text; pinch zoom comes back afterwards. */
function useNoFocusZoom() {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return;
    const before = meta.content;
    meta.content = `${before}, maximum-scale=1`;
    return () => {
      meta.content = before;
    };
  }, []);
}

/** The text being typed. Uncontrolled, so React never moves the caret. */
function Editable({ text, onInput, onDone }: { text: string; onInput: (text: string) => void; onDone: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  useNoFocusZoom();
  useEffect(() => {
    const node = el.current!;
    node.innerText = text;
    node.focus({ preventScroll: true });
    // Caret at the end.
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    // Only on the way in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      ref={el}
      className="text-edit"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      onInput={(e) => onInput((e.currentTarget as HTMLDivElement).innerText.replace(/\n$/, ""))}
      onBlur={onDone}
      onKeyDown={(e) => {
        if (e.key === "Escape") (e.currentTarget as HTMLDivElement).blur();
        e.stopPropagation();
      }}
    />
  );
}
