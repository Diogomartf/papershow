import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { eraseLayers, type DrawHandle, type Stroke } from "drawesome";
import { PANEL, TEXT_FONT, TEXT_LINE, type TextItem } from "@papershow/scene";
import { cue } from "./sound";

/** What's on the drawing, as one thing to change and to undo. */
export type Arrangement = { strokes: Stroke[]; texts: TextItem[] };

type Box = { x0: number; y0: number; x1: number; y1: number };
type Picked = { strokes: Set<number>; texts: Set<string> };
type Corner = "nw" | "ne" | "sw" | "se";
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];
/** A move and a scale about `o`: a point p goes to (p - o) * k + o + d. */
type Change = { k: number; ox: number; oy: number; dx: number; dy: number };
const NONE: Change = { k: 1, ox: 0, oy: 0, dx: 0, dy: 0 };

/** How small a scale can take things, and how small text can get, in panel pixels. */
const MIN_K = 0.05;
const MIN_TEXT = 8;
/** What − and + scale by. */
const STEP = 1.15;
/** Screen pixels a press can wander before it counts as a drag, and how near a line counts as on it. */
const SLOP_PX = 4;
const HIT_PX = 8;

const nothing = (): Picked => ({ strokes: new Set(), texts: new Set() });
const empty = (p: Picked) => !p.strokes.size && !p.texts.size;

const toPanel = (el: HTMLElement, e: { clientX: number; clientY: number }) => {
  const r = el.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * PANEL.w, y: ((e.clientY - r.top) / r.height) * PANEL.h };
};

const apply = (c: Change, x: number, y: number): [number, number] => [(x - c.ox) * c.k + c.ox + c.dx, (y - c.oy) * c.k + c.oy + c.dy];

const strokeBox = (s: Stroke): Box => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of s.points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const r = s.size / 2;
  return { x0: x0 - r, y0: y0 - r, x1: x1 + r, y1: y1 + r };
};

const union = (boxes: Box[]): Box | null =>
  boxes.length
    ? boxes.reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }))
    : null;

/** The same things in the same order, even if not the same list. */
const same = <T,>(a: T[], b: T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

const overlaps = (a: Box, b: Box) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
const inside = (b: Box, x: number, y: number) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;

let pen: CanvasRenderingContext2D | null = null;

/** Where a text sits: measured in its own font as the text layer sets it, so it fits the words however they're shown. */
function textBox(t: TextItem): Box {
  pen ??= document.createElement("canvas").getContext("2d");
  const lines = t.text.split("\n");
  let w = t.size;
  if (pen) {
    pen.font = `${t.bold ? 700 : 450} ${t.size}px ${TEXT_FONT}`;
    w = Math.max(...lines.map((l) => pen!.measureText(l).width));
  }
  return { x0: t.x, y0: t.y, x1: t.x + w, y1: t.y + lines.length * t.size * TEXT_LINE };
}

/** How far (x, y) is from the line through a stroke's points. */
function distance(s: Stroke, x: number, y: number): number {
  const ps = s.points;
  if (ps.length === 1) return Math.hypot(ps[0][0] - x, ps[0][1] - y);
  let best = Infinity;
  for (let i = 1; i < ps.length; i++) {
    const [ax, ay] = ps[i - 1];
    const [bx, by] = ps[i];
    const l = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = l ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / l)) : 0;
    best = Math.min(best, Math.hypot(ax + t * (bx - ax) - x, ay + t * (by - ay) - y));
  }
  return best;
}

/**
 * Picking things on the drawing up, as in Figma. While `active`, a drag on the panel draws a box and selects every
 * stroke and text it touches, a click selects the one under it (Shift adds), and the selection can be dragged to
 * move it or by a corner to scale it. Each change is one step for ⌘Z or the pens' Undo button, and goes to `onChange` once,
 * when the pointer lets go: while it moves, the strokes and texts on the page are only transformed in place.
 */
export function SelectLayer({
  strokes,
  texts,
  onChange,
  pens,
  active,
  onDone,
}: {
  strokes: Stroke[];
  texts: TextItem[];
  onChange: (next: Arrangement) => void;
  /** The pens' drawing. Strokes change through it, so its own undo stays one step per change made here. */
  pens: React.RefObject<DrawHandle | null>;
  active: boolean;
  onDone: () => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const [held, setPicked] = useState<Picked>(nothing);
  // What's gone (undone, rubbed out) can't stay selected.
  const picked: Picked = {
    strokes: new Set([...held.strokes].filter((id) => strokes.some((x) => x.id === id))),
    texts: new Set([...held.texts].filter((id) => texts.some((x) => x.id === id))),
  };
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [change, setChange] = useState<Change>(NONE);
  const [past, setPast] = useState<Arrangement[]>([]);
  const [future, setFuture] = useState<Arrangement[]>([]);
  const gesture = useRef<
    | { kind: "marquee"; x: number; y: number; add: Picked | null; sx: number; sy: number; moved: boolean }
    | { kind: "move"; x: number; y: number; sx: number; sy: number; moved: boolean; clicked: Picked | null }
    | { kind: "scale"; corner: Corner; ax: number; ay: number; cx: number; cy: number }
    | null
  >(null);
  // The drawing as it is now. Every handler is made afresh each render, so this is never stale.
  const now: Arrangement = { strokes, texts };
  // What this layer last made of the drawing.
  const mine = useRef<Arrangement | null>(null);
  // Elements on the page moved in place while dragging, to put back once the drawing itself has moved.
  const moved = useRef<{ el: Element; svg: boolean }[]>([]);

  /** Puts back what was moved in place. */
  const unmove = () => {
    for (const { el, svg } of moved.current) {
      if (svg) el.removeAttribute("transform");
      else Object.assign((el as HTMLElement).style, { transform: "", transformOrigin: "" });
    }
    moved.current = [];
  };

  useLayoutEffect(() => {
    // The drawing caught up with the drag: the page draws it there itself now, so the stand-in transforms go.
    unmove();
    // Something else changed the drawing (a pen, the text tool, the toolbar's undo): this layer's steps no longer apply.
    if (mine.current && (!same(mine.current.strokes, strokes) || mine.current.texts !== texts)) {
      setPast([]);
      setFuture([]);
    }
  }, [strokes, texts]);

  // Leaving select lets go of the selection.
  useEffect(() => {
    if (!active) setPicked(nothing());
  }, [active]);

  const panelEl = () => layer.current?.closest(".panel") ?? null;
  /** Panel pixels per screen pixel. */
  const ratio = () => PANEL.w / (layer.current?.getBoundingClientRect().width || PANEL.w);

  const ink = (s: Stroke) => !s.erase && s.points.length > 0;
  const boxOf = (p: Picked): Box | null =>
    union([
      ...now.strokes.filter((s) => p.strokes.has(s.id)).map(strokeBox),
      ...now.texts.filter((t) => p.texts.has(t.id)).map(textBox),
    ]);

  /** The text or stroke under a point, the one on top first. */
  const hit = (x: number, y: number): Picked | null => {
    const { strokes, texts } = now;
    for (let i = texts.length - 1; i >= 0; i--) if (inside(textBox(texts[i]), x, y)) return { strokes: new Set(), texts: new Set([texts[i].id]) };
    const slack = HIT_PX * ratio();
    for (let i = strokes.length - 1; i >= 0; i--) {
      const s = strokes[i];
      if (ink(s) && distance(s, x, y) <= s.size / 2 + slack) return { strokes: new Set([s.id]), texts: new Set() };
    }
    return null;
  };

  /** Everything the box touches. */
  const within = (b: Box): Picked => ({
    strokes: new Set(now.strokes.filter((s) => ink(s) && overlaps(strokeBox(s), b) && s.points.some(([x, y]) => inside(b, x, y))).map((s) => s.id)),
    texts: new Set(now.texts.filter((t) => overlaps(textBox(t), b)).map((t) => t.id)),
  });

  /**
   * The strokes a change carries: the picked ones, and the eraser passes over them, so what was rubbed out
   * stays rubbed out where it went.
   */
  const carried = (p: Picked): Set<number> => {
    const all = now.strokes;
    const box = union(all.filter((s) => p.strokes.has(s.id)).map(strokeBox));
    const out = new Set(p.strokes);
    if (!box) return out;
    const first = all.findIndex((s) => p.strokes.has(s.id));
    all.forEach((s, i) => {
      if (s.erase && i > first && s.points.length && overlaps(strokeBox(s), box)) out.add(s.id);
    });
    return out;
  };

  /** Moves the picked things on the page without touching the drawing, for the length of a drag. */
  const preview = (c: Change, p: Picked) => {
    const panel = panelEl();
    const svg = panel?.querySelector('[class*="Draw_surface"]');
    if (!panel || !svg) return;
    unmove();
    const m = `matrix(${c.k} 0 0 ${c.k} ${c.ox * (1 - c.k) + c.dx} ${c.oy * (1 - c.k) + c.dy})`;
    // Drawesome draws each run of ink under the same eraser passes as a group, its ink in order, one element per
    // stroke, and those passes in the group's mask. Matching them up by position finds the stroke's element.
    const take = carried(p);
    const all = now.strokes;
    const groups = svg.querySelectorAll(":scope g[clip-path] > g");
    eraseLayers(all).forEach((layer, li) => {
      const g = groups[li];
      if (!g) return;
      const marks = [...g.children].filter((el) => el.tagName !== "defs");
      const cuts = g.querySelectorAll("mask > path");
      const shown = layer.ink.filter((i) => all[i].points.length > 0);
      if (marks.length !== shown.length) return;
      shown.forEach((i, n) => take.has(all[i].id) && moved.current.push({ el: marks[n], svg: true }));
      layer.erasers.forEach((i, n) => take.has(all[i].id) && cuts[n] && moved.current.push({ el: cuts[n], svg: true }));
    });
    for (const { el } of moved.current) el.setAttribute("transform", m);
    const px = panel.getBoundingClientRect().width / PANEL.w;
    for (const t of now.texts) {
      if (!p.texts.has(t.id)) continue;
      const el = panel.querySelector<HTMLElement>(`.text-layer [data-id="${t.id}"]`);
      if (!el) continue;
      const [x, y] = apply(c, t.x, t.y);
      Object.assign(el.style, { transformOrigin: "0 0", transform: `translate(${(x - t.x) * px}px, ${(y - t.y) * px}px) scale(${c.k})` });
      moved.current.push({ el, svg: false });
    }
  };

  /** Changes the drawing, as one step back. The pens hear of it only when their strokes changed. */
  const commit = (next: Arrangement) => {
    setPast((h) => [...h, now]);
    setFuture([]);
    mine.current = next;
    if (!same(next.strokes, now.strokes)) pens.current?.setStrokes(next.strokes);
    onChange(next);
  };

  /** The picked things, moved and scaled. */
  const changed = (c: Change, p: Picked): Arrangement => {
    const take = carried(p);
    const r = (n: number) => Math.round(n * 100) / 100;
    return {
      strokes: now.strokes.map((s) =>
        take.has(s.id)
          ? { ...s, size: r(s.size * c.k), points: s.points.map(([x, y, pr]) => [...apply(c, x, y).map(r), pr] as Stroke["points"][number]) }
          : s,
      ),
      texts: now.texts.map((t) => {
        if (!p.texts.has(t.id)) return t;
        const [x, y] = apply(c, t.x, t.y);
        return { ...t, x: Math.round(x), y: Math.round(y), size: Math.max(MIN_TEXT, Math.round(t.size * c.k)) };
      }),
    };
  };

  const finish = (c: Change, p: Picked) => {
    setChange(NONE);
    if (c.k === 1 && !c.dx && !c.dy) return unmove();
    commit(changed(c, p));
  };

  const scaleBy = (k: number) => {
    const b = boxOf(picked);
    if (!b) return;
    finish({ k, ox: (b.x0 + b.x1) / 2, oy: (b.y0 + b.y1) / 2, dx: 0, dy: 0 }, picked);
  };

  const remove = () => {
    if (empty(picked)) return;
    cue(["close", { emphasis: "subtle" }]);
    const take = carried(picked);
    commit({ strokes: now.strokes.filter((s) => !take.has(s.id)), texts: now.texts.filter((t) => !picked.texts.has(t.id)) });
    setPicked(nothing());
  };

  /** One step back. `quiet` when the button pressed already made its sound. */
  const undo = (quiet = false) => {
    const prev = past.at(-1);
    if (!prev) return;
    if (!quiet) cue(["navigate", { emphasis: "subtle", direction: "back" }]);
    setPast(past.slice(0, -1));
    setFuture([now, ...future]);
    mine.current = prev;
    // The strokes go back through the pens' own undo, which took this change as one step.
    if (!same(prev.strokes, now.strokes)) pens.current?.undo();
    onChange(prev);
  };
  const redo = (quiet = false) => {
    const next = future[0];
    if (!next) return;
    if (!quiet) cue(["navigate", { emphasis: "subtle", direction: "forward" }]);
    setFuture(future.slice(1));
    setPast([...past, now]);
    mine.current = next;
    if (!same(next.strokes, now.strokes)) pens.current?.redo();
    onChange(next);
  };

  // While selecting, ⌘Z steps back through what was moved and scaled here, ahead of the pens' own undo.
  // Delete takes the selection away, arrows nudge it, ⌘A picks up everything.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
      const meta = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      // Nothing of this layer's to step through: the pens' own undo takes it.
      if (meta && (k === "z" || k === "y") && (k === "y" || e.shiftKey ? future.length : past.length)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (k === "y" || e.shiftKey) redo();
        else undo();
        return;
      }
      if (meta && k === "a") {
        e.preventDefault();
        setPicked({
          strokes: new Set(now.strokes.filter(ink).map((s) => s.id)),
          texts: new Set(now.texts.map((t) => t.id)),
        });
        return;
      }
      if (meta || empty(picked)) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        remove();
      }
      const step = e.shiftKey ? 10 : 1;
      const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (arrows[e.key]) {
        e.preventDefault();
        finish({ ...NONE, dx: arrows[e.key][0], dy: arrows[e.key][1] }, picked);
      }
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  });

  // The pens' Undo and Redo buttons step through what was moved and scaled here too, texts and all, while there's
  // any of it; otherwise they do their own.
  useEffect(() => {
    const panel = layer.current?.closest(".panel");
    if (!active || !panel) return;
    const onClick = (e: Event) => {
      const button = (e.target as HTMLElement).closest('[class*="Draw_toolbar"] button[aria-label="Undo"], [class*="Draw_toolbar"] button[aria-label="Redo"]');
      if (!button) return;
      const back = button.getAttribute("aria-label") === "Undo";
      if (!(back ? past.length : future.length)) return;
      e.preventDefault();
      e.stopPropagation();
      if (back) undo(true);
      else redo(true);
    };
    panel.addEventListener("click", onClick, true);
    return () => panel.removeEventListener("click", onClick, true);
  });

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".select-tools")) return;
    e.preventDefault();
    // Out of the toolbar's buttons, so the keys work here and not on them.
    (document.activeElement as HTMLElement | null)?.blur();
    layer.current!.setPointerCapture(e.pointerId);
    const { x, y } = toPanel(layer.current!, e);
    const corner = (e.target as HTMLElement).dataset.corner as Corner | undefined;
    const box = boxOf(picked);
    if (corner && box) {
      // The opposite corner stays where it is.
      const ax = corner.includes("e") ? box.x0 : box.x1;
      const ay = corner.includes("s") ? box.y0 : box.y1;
      gesture.current = { kind: "scale", corner, ax, ay, cx: corner.includes("e") ? box.x1 : box.x0, cy: corner.includes("s") ? box.y1 : box.y0 };
      return;
    }
    const base = { x, y, sx: e.clientX, sy: e.clientY, moved: false };
    if (box && inside(box, x, y) && !e.shiftKey) {
      gesture.current = { kind: "move", ...base, clicked: hit(x, y) };
      return;
    }
    const under = hit(x, y);
    if (under) {
      if (e.shiftKey) {
        // Shift-click adds it, or takes it back out if it was in.
        const next = { strokes: new Set(picked.strokes), texts: new Set(picked.texts) };
        under.strokes.forEach((id) => (next.strokes.has(id) ? next.strokes.delete(id) : next.strokes.add(id)));
        under.texts.forEach((id) => (next.texts.has(id) ? next.texts.delete(id) : next.texts.add(id)));
        setPicked(next);
        return;
      }
      // Pressing on something picks it up, ready to drag straight away.
      setPicked(under);
      gesture.current = { kind: "move", ...base, clicked: null };
      return;
    }
    gesture.current = { kind: "marquee", ...base, add: e.shiftKey ? picked : null };
  };

  const onMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const { x, y } = toPanel(layer.current!, e);
    if (g.kind === "scale") {
      // How far the corner is from the anchor, along the diagonal it started on.
      const vx = g.cx - g.ax;
      const vy = g.cy - g.ay;
      const k = Math.max(MIN_K, ((x - g.ax) * vx + (y - g.ay) * vy) / (vx * vx + vy * vy || 1));
      const c = { k, ox: g.ax, oy: g.ay, dx: 0, dy: 0 };
      setChange(c);
      preview(c, picked);
      return;
    }
    if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < SLOP_PX) return;
    g.moved = true;
    if (g.kind === "marquee") {
      setMarquee({ x0: Math.min(g.x, x), y0: Math.min(g.y, y), x1: Math.max(g.x, x), y1: Math.max(g.y, y) });
      return;
    }
    const c = { ...NONE, dx: x - g.x, dy: y - g.y };
    setChange(c);
    preview(c, picked);
  };

  const onUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.kind === "marquee") {
      setMarquee(null);
      if (!g.moved) return setPicked(nothing());
      const { x, y } = toPanel(layer.current!, e);
      const got = within({ x0: Math.min(g.x, x), y0: Math.min(g.y, y), x1: Math.max(g.x, x), y1: Math.max(g.y, y) });
      setPicked(g.add ? { strokes: new Set([...g.add.strokes, ...got.strokes]), texts: new Set([...g.add.texts, ...got.texts]) } : got);
      return;
    }
    // A click inside a selection of several picks out just the one under it, as Figma does.
    if (g.kind === "move" && !g.moved) {
      if (g.clicked) setPicked(g.clicked);
      return;
    }
    finish(change, picked);
  };

  // The selection's box, following a drag as it goes.
  const box = (() => {
    const b = boxOf(picked);
    if (!b) return null;
    const [x0, y0] = apply(change, b.x0, b.y0);
    const [x1, y1] = apply(change, b.x1, b.y1);
    return { x0, y0, x1, y1 };
  })();
  const pct = (b: Box) => ({
    left: `${(b.x0 / PANEL.w) * 100}%`,
    top: `${(b.y0 / PANEL.h) * 100}%`,
    width: `${((b.x1 - b.x0) / PANEL.w) * 100}%`,
    height: `${((b.y1 - b.y0) / PANEL.h) * 100}%`,
  });

  // The buttons hang above the device, as the photo's do, off what's being arranged.
  const [device, setDevice] = useState<Element | null>(null);
  useLayoutEffect(() => setDevice(layer.current?.closest(".device") ?? null), []);

  return (
    <div
      ref={layer}
      className="select-layer"
      data-active={active}
      onPointerDown={active ? onDown : undefined}
      onPointerMove={active ? onMove : undefined}
      onPointerUp={active ? onUp : undefined}
      onPointerCancel={active ? onUp : undefined}
      aria-hidden={!active}
    >
      {active && marquee && <div className="select-marquee" style={pct(marquee)} />}
      {active && box && (
        <div className="select-box" style={pct(box)}>
          {CORNERS.map((c) => (
            <span key={c} className={`select-corner ${c}`} data-corner={c} />
          ))}
          {change.k !== 1 && <span className="select-size">{`${Math.round(change.k * 100)}%`}</span>}
        </div>
      )}
      {active &&
        device &&
        createPortal(
          <div className="photo-tools select-tools" onPointerDown={(e) => e.stopPropagation()}>
            <button onClick={() => scaleBy(1 / STEP)} disabled={empty(picked)} aria-label="Smaller" title="Smaller">
              <span aria-hidden>−</span>
            </button>
            <button onClick={() => scaleBy(STEP)} disabled={empty(picked)} aria-label="Bigger" title="Bigger">
              <span aria-hidden>+</span>
            </button>
            <button className="danger" data-quiet onClick={remove} disabled={empty(picked)} title="Delete (⌫)">
              Delete
            </button>
            <button className="photo-done" onClick={onDone}>Done</button>
          </div>,
          device,
        )}
    </div>
  );
}
