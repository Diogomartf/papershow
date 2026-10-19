import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PANEL, photoFit, photoSize, type PhotoAt } from "@papershow/scene";

/** How small or big the photo can go: 1 fills the panel. */
const MIN_SCALE = 0.1;
const MAX_SCALE = 3;
/** One tap of Smaller or Bigger. */
const STEP = 1.25;
/** Turning snaps straight within this many degrees; with Shift it goes in steps of 15, as in Figma. */
const SNAP_DEG = 4;
const SHIFT_STEP = 15;
/** The photo's corners, as which way they lie from its centre. */
const CORNERS = [
  { sx: -1, sy: -1, resize: "nwse-resize" },
  { sx: 1, sy: -1, resize: "nesw-resize" },
  { sx: 1, sy: 1, resize: "nwse-resize" },
  { sx: -1, sy: 1, resize: "nesw-resize" },
] as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

type Point = { x: number; y: number };

/** Degrees from 0 to 360, snapped to the nearest straight angle when close. */
const settle = (deg: number) => {
  const straight = Math.round(deg / 90) * 90;
  const a = Math.abs(deg - straight) < SNAP_DEG ? straight : deg;
  return ((a % 360) + 360) % 360;
};

/**
 * The photo under the drawing. While `active`, it works as in Figma: drag it to move it, drag a corner to resize it,
 * and hover just outside a corner for the turning cursor, then drag to turn it to any angle. Two fingers pinch and
 * twist it; scrolling resizes it. Big buttons make it smaller, bigger, or fit it whole. Otherwise pens draw over it.
 */
export function PhotoLayer({
  photo,
  at,
  onChange,
  active,
  onDone,
  hidden,
}: {
  photo: string;
  at: PhotoAt;
  onChange: (at: PhotoAt) => void;
  active: boolean;
  onDone: () => void;
  /** The e-ink preview shows the photo dithered instead. */
  hidden: boolean;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  // The latest placement for handlers that outlive a render.
  const latest = useRef(at);
  useLayoutEffect(() => {
    latest.current = at;
  });

  const place = (next: PhotoAt) =>
    onChange({
      ...next,
      scale: clamp(next.scale, MIN_SCALE, MAX_SCALE),
      // Keep the middle of the photo on the panel, so it can't be lost off an edge.
      x: Math.round(clamp(next.x, 0, PANEL.w)),
      y: Math.round(clamp(next.y, 0, PANEL.h)),
      angle: settle(next.angle),
    });

  const [turningNow, setTurningNow] = useState(false);
  // A corner being dragged: what it does, and where the press started around the photo's centre on screen.
  const handle = useRef<{ kind: "turn" | "size"; at: PhotoAt; centre: Point; angle: number; dist: number } | null>(null);
  const fromCentre = (c: Point, e: { clientX: number; clientY: number }) => ({
    angle: (Math.atan2(e.clientY - c.y, e.clientX - c.x) * 180) / Math.PI,
    dist: Math.hypot(e.clientX - c.x, e.clientY - c.y),
  });

  const onHandleDown = (kind: "turn" | "size") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const r = layer.current!.getBoundingClientRect();
    const a = latest.current;
    const centre = { x: r.left + (a.x / PANEL.w) * r.width, y: r.top + (a.y / PANEL.h) * r.height };
    handle.current = { kind, at: a, centre, ...fromCentre(centre, e) };
    if (kind === "turn") setTurningNow(true);
  };
  const onHandleMove = (e: React.PointerEvent) => {
    const h = handle.current;
    if (!h) return;
    const now = fromCentre(h.centre, e);
    if (h.kind === "size") return place({ ...h.at, scale: h.at.scale * (now.dist / Math.max(1, h.dist)) });
    const angle = h.at.angle + now.angle - h.angle;
    place({ ...h.at, angle: e.shiftKey ? Math.round(angle / SHIFT_STEP) * SHIFT_STEP : angle });
  };
  const onHandleUp = () => {
    handle.current = null;
    setTurningNow(false);
  };

  // Fingers on the layer, and where the photo and the fingers were when the gesture (re)started.
  const pointers = useRef(new Map<number, Point>());
  const start = useRef<{ at: PhotoAt; mid: Point; dist: number; angle: number } | null>(null);

  const gesture = () => {
    const pts = [...pointers.current.values()];
    const mid = { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
    const two = pts.length > 1;
    const dist = two ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    const angle = two ? (Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) * 180) / Math.PI : 0;
    return { mid, dist, angle };
  };
  const restart = () => {
    start.current = pointers.current.size ? { at: latest.current, ...gesture() } : null;
  };

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".photo-tools, .photo-corner, .photo-rotate")) return;
    e.preventDefault();
    layer.current!.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    restart();
  };
  const onMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !start.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const s = start.current;
    const { mid, dist, angle } = gesture();
    const k = PANEL.w / layer.current!.getBoundingClientRect().width;
    place({
      ...s.at,
      x: s.at.x + (mid.x - s.mid.x) * k,
      y: s.at.y + (mid.y - s.mid.y) * k,
      scale: s.dist && dist ? s.at.scale * (dist / s.dist) : s.at.scale,
      angle: s.dist && dist ? s.at.angle + angle - s.angle : s.at.angle,
    });
  };
  const onUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    restart();
  };

  // Scrolling (or a trackpad pinch, which arrives as a wheel with ctrl) resizes. Not passive, so the page stays put.
  useEffect(() => {
    const el = layer.current;
    if (!el || !active) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const a = latest.current;
      place({ ...a, scale: a.scale * Math.exp(-e.deltaY / (e.ctrlKey ? 100 : 400)) });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // place only reads latest and onChange; re-adding the listener on each change isn't needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, onChange]);

  const size = natural && photoSize(natural.w, natural.h, at);
  const box = size && {
    left: `${(at.x / PANEL.w) * 100}%`,
    top: `${(at.y / PANEL.h) * 100}%`,
    width: `${(size.w / PANEL.w) * 100}%`,
    height: `${(size.h / PANEL.h) * 100}%`,
    transform: `translate(-50%, -50%) rotate(${at.angle}deg)`,
  };
  // Where each corner sits on the panel, turned with the photo.
  const rad = (at.angle * Math.PI) / 180;
  const corners =
    size &&
    CORNERS.map((c) => {
      const dx = (c.sx * size.w) / 2;
      const dy = (c.sy * size.h) / 2;
      const x = at.x + dx * Math.cos(rad) - dy * Math.sin(rad);
      const y = at.y + dx * Math.sin(rad) + dy * Math.cos(rad);
      return { ...c, left: `${(x / PANEL.w) * 100}%`, top: `${(y / PANEL.h) * 100}%` };
    });
  const fit = natural ? photoFit(natural.w, natural.h, at.angle) : 1;
  const whole = Math.abs(at.scale - fit) < 0.01 && at.x === PANEL.w / 2 && at.y === PANEL.h / 2;

  return (
    <>
      <div className="photo-clip">
        <img
        className="photo"
        src={photo}
        alt=""
        draggable={false}
        data-hidden={hidden}
        style={box ?? { visibility: "hidden" }}
        onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
      />
      </div>
      <div
        ref={layer}
        className="photo-layer"
        data-active={active}
        onPointerDown={active ? onDown : undefined}
        onPointerMove={active ? onMove : undefined}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {active && box && <div className="photo-frame" style={box} />}
        {active &&
          corners?.map((c) => (
            <div key={`${c.sx}${c.sy}`}>
              {/* Just outside the corner: the turning cursor, as in Figma */}
              <div
                className="photo-rotate"
                style={{ left: c.left, top: c.top, transform: `translate(-50%, -50%) rotate(${at.angle}deg) translate(${c.sx * 14}px, ${c.sy * 14}px)` }}
                onPointerDown={onHandleDown("turn")}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={onHandleUp}
              />
              <div
                className="photo-corner"
                style={{ left: c.left, top: c.top, transform: `translate(-50%, -50%) rotate(${at.angle}deg)`, cursor: c.resize }}
                onPointerDown={onHandleDown("size")}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={onHandleUp}
              />
            </div>
          ))}
        {active && turningNow && <div className="photo-angle">{`${Math.round(at.angle)}°`}</div>}
        {active && (
          <div className="photo-tools" onPointerDown={(e) => e.stopPropagation()}>
            <button onClick={() => place({ ...at, scale: at.scale / STEP })} disabled={at.scale <= MIN_SCALE} aria-label="Smaller">
              <span aria-hidden>−</span>
            </button>
            <button onClick={() => place({ ...at, scale: at.scale * STEP })} disabled={at.scale >= MAX_SCALE} aria-label="Bigger">
              <span aria-hidden>+</span>
            </button>
            <button
              onClick={() => place(whole ? { ...at, x: PANEL.w / 2, y: PANEL.h / 2, scale: 1 } : { ...at, x: PANEL.w / 2, y: PANEL.h / 2, scale: fit })}
              title={whole ? "Fill the panel, edge to edge" : "Show the whole photo"}
            >
              {whole ? "Fill" : "Whole"}
            </button>
            <button className="photo-done" onClick={onDone}>Done</button>
          </div>
        )}
      </div>
    </>
  );
}
