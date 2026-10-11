import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent } from "react";
import { Nav } from "./Nav";
import { fileUrl, listImages, type ImageMeta } from "./store";
import * as api from "./slides";
import type { Slide, State } from "./slides";

const PX_PER_MIN = 96;
const MIME_IMAGE = "application/x-imagegen-image";
const MIME_SLIDE = "application/x-imagegen-slide";
const DAYS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const fmtMinutes = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`);
const fmtCountdown = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

/** Server state, kept fresh by long-polling; `skew` lines our clock up with the server's. */
function useSlideGen() {
  const [state, setState] = useState<State | null>(null);
  const [skew, setSkew] = useState(0);
  const accept = useCallback((s: State) => {
    setState(s);
    setSkew(s.now - Date.now());
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        accept(await api.getState());
      } catch {
        /* the loop below retries */
      }
      while (alive) {
        try {
          const s = await api.waitState();
          if (alive) accept(s);
        } catch {
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [accept]);

  return { state, setState, accept, skew };
}

function useNow(skew: number, every = 250) {
  const [now, setNow] = useState(() => Date.now() + skew);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() + skew), every);
    return () => clearInterval(t);
  }, [skew, every]);
  return now;
}

export function Slides() {
  const { state, setState, accept, skew } = useSlideGen();
  const now = useNow(skew);
  const [images, setImages] = useState<ImageMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [resizing, setResizing] = useState<{ id: string; minutes: number } | null>(null);
  const clipEls = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    document.title = "SlideGen";
    const load = () => listImages().then(setImages, () => {});
    load();
    addEventListener("focus", load);
    return () => removeEventListener("focus", load);
  }, []);

  const byId = useMemo(() => new Map(images.map((i) => [i.id, i])), [images]);
  const slides = state?.slides ?? [];
  const minutesOf = (s: Slide) => (resizing?.id === s.id ? resizing.minutes : s.durationS / 60);
  const totalMin = slides.filter((s) => s.enabled).reduce((n, s) => n + minutesOf(s), 0);

  const showing = state?.showing ?? null;
  const pinned = state?.live.mode === "pin";
  const liveImage = showing ? byId.get(showing.imageId) : undefined;
  const next = state?.upcoming[0];
  const nextSlide = next && slides.find((s) => s.id === next.slideId);

  // Optimistic edit: show it now, then take whatever the server says.
  const edit = (local: (s: State) => State, remote: () => Promise<State>) => {
    if (state) setState(local(state));
    remote().then(accept, () => api.getState().then(accept));
  };

  // ── Dragging onto / within the track ────────────────────────────────────

  const indexAt = (clientX: number) => {
    let i = 0;
    for (const s of slides) {
      const el = clipEls.current.get(s.id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
      i++;
    }
    return slides.length;
  };

  const onDragOver = (e: DragEvent) => {
    const types = e.dataTransfer.types;
    if (!types.includes(MIME_IMAGE) && !types.includes(MIME_SLIDE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = types.includes(MIME_IMAGE) ? "copy" : "move";
    setDropAt(indexAt(e.clientX));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const at = indexAt(e.clientX);
    setDropAt(null);
    const imageId = e.dataTransfer.getData(MIME_IMAGE);
    const slideId = e.dataTransfer.getData(MIME_SLIDE);
    if (imageId) {
      api.addSlide(imageId, at).then((s) => {
        accept(s);
        setSelected(s.slides[at]?.id ?? null);
      });
    } else if (slideId) {
      const ids = slides.map((s) => s.id);
      const from = ids.indexOf(slideId);
      ids.splice(from, 1);
      ids.splice(from < at ? at - 1 : at, 0, slideId);
      edit(
        (s) => ({ ...s, slides: ids.map((id, i) => ({ ...s.slides.find((x) => x.id === id)!, position: i })) }),
        () => api.reorderSlides(ids),
      );
    }
  };

  // ── Resizing a clip by its right edge: whole minutes, one at least ──────

  const startResize = (e: PointerEvent, slide: Slide) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startMin = slide.durationS / 60;
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    setSelected(slide.id);
    setResizing({ id: slide.id, minutes: startMin });

    const move = (ev: globalThis.PointerEvent) =>
      setResizing({ id: slide.id, minutes: Math.max(1, Math.round(startMin + (ev.clientX - startX) / PX_PER_MIN)) });
    const up = (ev: globalThis.PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      const minutes = Math.max(1, Math.round(startMin + (ev.clientX - startX) / PX_PER_MIN));
      setResizing(null);
      if (minutes !== startMin) setDuration(slide.id, minutes);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };

  const setDuration = (id: string, minutes: number) => {
    const durationS = Math.max(1, minutes) * 60;
    edit(
      (s) => ({ ...s, slides: s.slides.map((x) => (x.id === id ? { ...x, durationS } : x)) }),
      () => api.updateSlide(id, { durationS }),
    );
  };

  const patch = (id: string, p: Partial<Slide>) =>
    edit((s) => ({ ...s, slides: s.slides.map((x) => (x.id === id ? { ...x, ...p } : x)) }), () => api.updateSlide(id, p));

  const remove = (id: string) => {
    setSelected(null);
    edit((s) => ({ ...s, slides: s.slides.filter((x) => x.id !== id) }), () => api.removeSlide(id));
  };

  const pin = (imageId: string) => api.setLive({ mode: "pin", imageId }).then(accept);
  const resume = () => api.setLive({ mode: "rotate" }).then(accept);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selected || (e.target as HTMLElement).closest("input, select, textarea")) return;
      if (e.key === "Backspace" || e.key === "Delete") remove(selected);
      if (e.key === "Escape") setSelected(null);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  // ── Playhead: inside the clip that's on air ─────────────────────────────

  let playheadX: number | null = null;
  if (!pinned && showing?.slideId && showing.clip) {
    let x = 0;
    for (const s of slides) {
      const w = minutesOf(s) * PX_PER_MIN;
      if (s.id === showing.slideId) {
        const { startedAt, endsAt } = showing.clip;
        const f = Math.min(1, Math.max(0, (now - startedAt) / (endsAt - startedAt)));
        playheadX = x + f * w;
        break;
      }
      x += w;
    }
  }

  const sel = slides.find((s) => s.id === selected);
  const rulerMinutes = Math.max(Math.ceil(totalMin) + 4, 12);

  return (
    <div className="app show">
      <header className="bar">
        <div className="bar-left">
          <Nav current="show" />
        </div>
        <div />
        <div className="bar-right">
          <a className="ghost" href="/live" target="_blank" rel="noreferrer">Open /live ↗</a>
        </div>
      </header>

      <main className="show-main">
        <section className="onair">
          <div className="device small">
            <div className="panel">
              {showing ? (
                <img className="live-img" src={`/live.png?e=${encodeURIComponent(showing.etag)}`} alt="" />
              ) : (
                <p className="panel-empty">Nothing on /live. Drag an image onto the timeline, or show one now.</p>
              )}
            </div>
            <span className="ribbon" aria-hidden />
          </div>

          <div className="status">
            <span className="on-air" data-on={!!showing}>{showing ? "On air" : "Off air"}</span>
            <h1>{liveImage?.name ?? (showing ? "…" : "Nothing showing")}</h1>
            {pinned ? (
              <p>
                Pinned to /live until you resume the sequence.{" "}
                <button className="link" onClick={resume}>Resume sequence</button>
              </p>
            ) : showing?.slideId ? (
              <p>
                {nextSlide && next ? (
                  <>
                    Next: <strong>{byId.get(nextSlide.imageId)?.name ?? "…"}</strong> in{" "}
                    <span className="tabular">{fmtCountdown(next.at - now)}</span>
                  </>
                ) : (
                  "The only image in the sequence right now."
                )}
              </p>
            ) : (
              <p>The sequence is empty or nothing is scheduled for now.</p>
            )}
          </div>
        </section>

        <section className="desk">
          <div className="timeline">
            <div className="timeline-head">
              <h2>Sequence</h2>
              <span className="muted">
                {slides.length ? `Loops every ${fmtMinutes(totalMin)}` : "Drag images here to build a loop"}
              </span>
            </div>

            <div className="track-scroll">
              <div className="ruler" style={{ width: rulerMinutes * PX_PER_MIN }}>
                {Array.from({ length: rulerMinutes + 1 }, (_, m) => (
                  <span key={m} style={{ left: m * PX_PER_MIN }} data-major={m % 5 === 0}>
                    {m % 5 === 0 ? `${m}m` : ""}
                  </span>
                ))}
              </div>
              <div
                className="track"
                style={{ minWidth: rulerMinutes * PX_PER_MIN }}
                onDragOver={onDragOver}
                onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropAt(null)}
                onDrop={onDrop}
                onClick={(e) => e.target === e.currentTarget && setSelected(null)}
              >
                {slides.map((s, i) => {
                  const img = byId.get(s.imageId);
                  const minutes = minutesOf(s);
                  return (
                    <div
                      key={s.id}
                      ref={(el) => {
                        if (el) clipEls.current.set(s.id, el);
                        else clipEls.current.delete(s.id);
                      }}
                      className="clip"
                      data-selected={s.id === selected}
                      data-disabled={!s.enabled}
                      data-live={!pinned && showing?.slideId === s.id}
                      data-drop-before={dropAt === i}
                      style={{
                        width: minutes * PX_PER_MIN,
                        backgroundImage: img ? `url("${fileUrl(img)}")` : undefined,
                      }}
                      draggable={!resizing}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(MIME_SLIDE, s.id);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onClick={() => setSelected(s.id)}
                      title={img?.name}
                    >
                      <span className="clip-label">
                        <span className="clip-name">{img?.name ?? "Missing image"}</span>
                        <span className="clip-dur">{fmtMinutes(minutes)}</span>
                      </span>
                      {(s.start || s.days.length < 7) && <span className="clip-flag" title="Has a schedule">◷</span>}
                      <span
                        className="clip-handle"
                        onPointerDown={(e) => startResize(e, s)}
                        role="slider"
                        aria-label={`Duration of ${img?.name ?? "clip"}`}
                        aria-valuemin={1}
                        aria-valuenow={minutes}
                        aria-valuetext={fmtMinutes(minutes)}
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "ArrowRight") setDuration(s.id, minutes + 1);
                          if (e.key === "ArrowLeft") setDuration(s.id, minutes - 1);
                        }}
                      />
                    </div>
                  );
                })}
                <div className="drop-end" data-on={dropAt === slides.length && slides.length > 0} />
                {playheadX !== null && <div className="playhead" style={{ transform: `translateX(${playheadX}px)` }} />}
              </div>
            </div>

            {sel ? (
              <Inspector
                slide={sel}
                image={byId.get(sel.imageId)}
                minutes={minutesOf(sel)}
                onDuration={(m) => setDuration(sel.id, m)}
                onPatch={(p) => patch(sel.id, p)}
                onShowNow={() => pin(sel.imageId)}
                onRemove={() => remove(sel.id)}
              />
            ) : (
              <div className="bin">
                <span className="bin-label">Images</span>
                <ul>
                  {images.map((img) => (
                    <li key={img.id}>
                      <div
                        className="bin-item"
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData(MIME_IMAGE, img.id);
                          e.dataTransfer.effectAllowed = "copy";
                        }}
                        data-live={showing?.imageId === img.id}
                        title={`Drag “${img.name}” onto the timeline`}
                      >
                        <img src={fileUrl(img)} alt="" draggable={false} />
                        <span>{img.name}</span>
                      </div>
                      <button className="bin-live" onClick={() => pin(img.id)} title="Show this on /live now">
                        Show now
                      </button>
                    </li>
                  ))}
                  {!images.length && <li className="muted">No images yet. Make one in ImageGen.</li>}
                </ul>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

type InspectorProps = {
  slide: Slide;
  image: ImageMeta | undefined;
  minutes: number;
  onDuration: (minutes: number) => void;
  onPatch: (p: Partial<Slide>) => void;
  onShowNow: () => void;
  onRemove: () => void;
};

function Inspector({ slide, image, minutes, onDuration, onPatch, onShowNow, onRemove }: InspectorProps) {
  const allDay = !slide.start || !slide.end;
  return (
    <div className="inspector">
      <img src={image ? fileUrl(image) : undefined} alt="" />
      <div className="field">
        <label>Clip</label>
        <strong>{image?.name ?? "Missing image"}</strong>
      </div>

      <div className="field">
        <label>Duration</label>
        <div className="stepper">
          <button onClick={() => onDuration(minutes - 1)} disabled={minutes <= 1} aria-label="One minute less">−</button>
          <span className="tabular">{fmtMinutes(minutes)}</span>
          <button onClick={() => onDuration(minutes + 1)} aria-label="One minute more">+</button>
        </div>
      </div>

      <div className="field">
        <label>Days</label>
        <div className="days">
          {DAYS.map((d, i) => (
            <button
              key={i}
              aria-pressed={slide.days.includes(i)}
              aria-label={DAY_NAMES[i]}
              onClick={() =>
                onPatch({ days: slide.days.includes(i) ? slide.days.filter((x) => x !== i) : [...slide.days, i] })
              }
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label>Hours</label>
        <div className="hours">
          <button
            aria-pressed={allDay}
            onClick={() => onPatch(allDay ? { start: "08:00", end: "22:00" } : { start: null, end: null })}
          >
            All day
          </button>
          {!allDay && (
            <>
              <input type="time" value={slide.start!} onChange={(e) => e.target.value && onPatch({ start: e.target.value })} />
              <span className="muted">to</span>
              <input type="time" value={slide.end!} onChange={(e) => e.target.value && onPatch({ end: e.target.value })} />
            </>
          )}
        </div>
      </div>

      <div className="field">
        <label>In loop</label>
        <button className="toggle" role="switch" aria-checked={slide.enabled} onClick={() => onPatch({ enabled: !slide.enabled })}>
          <span />
        </button>
      </div>

      <div className="inspector-actions">
        <button className="ghost" onClick={onShowNow}>Show now</button>
        <button className="ghost danger" onClick={onRemove}>Remove</button>
      </div>
    </div>
  );
}
