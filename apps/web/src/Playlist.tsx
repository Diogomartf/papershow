import { useCallback, useEffect, useRef, useState, type DragEvent, type PointerEvent } from "react";
import { Nav } from "./Nav";
import { EinkImage } from "./EinkImage";
import { LightSwitch } from "./LightSwitch";
import { LiveLink } from "./LiveLink";
import { useSideScroll } from "./scroll";
import { keyOf, parseKey, useItems, type Item, type Source } from "./sources";
import * as api from "./slides";
import { useLiveState, useNow } from "./live";
import { FloatingMenu, MenuDivider, MenuItem, useUndoToast } from "./Undo";
import type { Playlist as PlaylistT, Slide, State } from "./slides";
import { navigate } from "./Nav";

/** Timeline zoom, in pixels per minute. */
const ZOOMS = [2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96];
const DEFAULT_ZOOM = 8;
const pick = <T,>(steps: T[], ok: (t: T) => boolean) => steps.find(ok) ?? steps[steps.length - 1];
/** A drawing or app from the strip, as "kind:id". */
const MIME_SOURCE = "application/x-papershow-source";
const MIME_SLIDE = "application/x-papershow-slide";
/** Matches the server's default for a new clip. */
const NEW_CLIP_MIN = 15;
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

export function Playlist({ id }: { id: string | null }) {
  const { state, setState, accept, skew } = useLiveState();
  const now = useNow(skew);
  const { items, itemOf } = useItems();
  const [selected, setSelected] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  /** What's in hand, so the track can open a gap the right size for it. */
  const [dragging, setDragging] = useState<{ kind: "source" | "slide"; id: string; minutes: number } | null>(null);
  const trackEl = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState<{ id: string; minutes: number } | null>(null);
  const clipEls = useRef(new Map<string, HTMLElement>());
  const scroller = useRef<HTMLDivElement>(null);
  const binList = useRef<HTMLUListElement>(null);
  const [ppm, setPpm] = useState(DEFAULT_ZOOM);
  const fitted = useRef(false);

  useEffect(() => {
    document.title = "Playlists · Papershow";
  }, []);

  const playlists = state?.playlists ?? [];
  const current = playlists.find((p) => p.id === id) ?? playlists[0];
  const pid = current?.id;
  const allSlides = state?.slides ?? [];
  /** The open playlist's clips; the loop plays every enabled playlist in turn. */
  const slides = allSlides.filter((s) => s.playlistId === pid);
  const inShow = !!state?.show.some((e) => e.playlistId === pid);
  const minutesOf = (s: Slide) => (resizing?.id === s.id ? resizing.minutes : s.durationS / 60);
  const totalMin = slides.filter((s) => s.enabled).reduce((n, s) => n + minutesOf(s), 0);

  const showing = state?.showing ?? null;
  const pinned = state?.live.mode === "pin";
  const pinnedUntil = state?.live.mode === "pin" ? (state.live.until ?? null) : null;
  const liveItem = itemOf(showing?.source);
  const next = state?.sequence[1];

  // Optimistic edit: show it now, then take whatever the server says.
  const edit = (local: (s: State) => State, remote: () => Promise<State>) => {
    if (state) setState(local(state));
    remote().then(accept, () => api.getState().then(accept));
  };

  // ── Dragging onto / within the track ────────────────────────────────────

  // Clips other than the one in hand, in order: where a drop can land between.
  const others = slides.filter((s) => s.id !== (dragging?.kind === "slide" ? dragging.id : null));

  /**
   * Where a drop at `clientX` lands, among `others`. Measured on the timeline as it
   * would be without the gap, so the preview doesn't jitter as clips slide aside.
   */
  const indexAt = (clientX: number) => {
    const x = clientX - (trackEl.current?.getBoundingClientRect().left ?? 0);
    let acc = 0;
    for (let i = 0; i < others.length; i++) {
      const w = minutesOf(others[i]) * ppm;
      if (x < acc + w / 2) return i;
      acc += w;
    }
    return others.length;
  };

  const endDrag = () => {
    setDragging(null);
    setDropAt(null);
  };

  const onDragOver = (e: DragEvent) => {
    const types = e.dataTransfer.types;
    if (!types.includes(MIME_SOURCE) && !types.includes(MIME_SLIDE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = types.includes(MIME_SOURCE) ? "copy" : "move";
    setDropAt(indexAt(e.clientX));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const at = indexAt(e.clientX);
    const source = parseKey(e.dataTransfer.getData(MIME_SOURCE));
    const slideId = e.dataTransfer.getData(MIME_SLIDE);
    endDrag();
    if (source) {
      api.addSlide(source, pid, at).then((s) => {
        accept(s);
        setSelected(s.slides.filter((x) => x.playlistId === pid)[at]?.id ?? null);
      });
    } else if (slideId) {
      const ids = slides.map((s) => s.id).filter((id) => id !== slideId);
      ids.splice(at, 0, slideId);
      if (ids.join() === slides.map((s) => s.id).join()) return;
      edit(
        (s) => ({
          ...s,
          slides: [
            ...s.slides.filter((x) => x.playlistId !== pid),
            ...ids.map((id, i) => ({ ...s.slides.find((x) => x.id === id)!, position: i })),
          ],
        }),
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
      setResizing({ id: slide.id, minutes: Math.max(1, Math.round(startMin + (ev.clientX - startX) / ppm)) });
    const up = (ev: globalThis.PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      const minutes = Math.max(1, Math.round(startMin + (ev.clientX - startX) / ppm));
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

  const toast = useUndoToast();

  /** Remove at once; the toast offers to put it back exactly as it was. */
  const remove = (id: string) => {
    const slide = allSlides.find((x) => x.id === id);
    if (!slide) return;
    const index = slides.findIndex((x) => x.id === id);
    setSelected(null);
    edit((s) => ({ ...s, slides: s.slides.filter((x) => x.id !== id) }), () => api.removeSlide(id));
    toast.show(`Removed ${itemOf(slide.source)?.name ?? "clip"}`, () => api.restoreSlide(slide, index).then(accept));
  };

  /** Show now: on /live for `forS` (a clip's own length; else the server's 15 minutes), then the playlists carry on. */
  const pin = (source: Source, forS?: number) => api.setLive({ mode: "pin", source, forS }).then(accept);

  /** Swap a clip with its neighbour: reordering without dragging. */
  const move = (id: string, dir: -1 | 1) => {
    const ids = slides.map((s) => s.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    edit(
      (s) => ({
        ...s,
        slides: [
          ...s.slides.filter((x) => x.playlistId !== pid),
          ...ids.map((x, k) => ({ ...s.slides.find((y) => y.id === x)!, position: k })),
        ],
      }),
      () => api.reorderSlides(ids),
    );
  };
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
  if (!pinned && showing?.clipId && showing.clip) {
    let x = 0;
    for (const s of slides) {
      const w = minutesOf(s) * ppm;
      if (s.id === showing.clipId) {
        const { startedAt, endsAt } = showing.clip;
        const f = Math.min(1, Math.max(0, (now - startedAt) / (endsAt - startedAt)));
        playheadX = x + f * w;
        break;
      }
      x += w;
    }
  }

  const sel = slides.find((s) => s.id === selected);
  // Zoom: largest step where the whole loop fits; on first load, start there.
  const fit = useCallback(() => {
    const width = (scroller.current?.clientWidth ?? 1000) - 36 - 80;
    const total = slides.reduce((n, s) => n + s.durationS / 60, 0);
    if (total) setPpm([...ZOOMS].reverse().find((z) => z * total <= width) ?? ZOOMS[0]);
  }, [slides]);
  useEffect(() => {
    fitted.current = false;
  }, [pid]);
  useEffect(() => {
    if (!fitted.current && slides.length) {
      fitted.current = true;
      fit();
    }
  }, [slides, fit]);
  const zoom = useCallback(
    (dir: 1 | -1) => setPpm((z) => ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, ZOOMS.indexOf(z) + dir))]),
    [],
  );
  const trackEdges = useSideScroll(scroller, zoom);
  const binEdges = useSideScroll(binList);

  // Ruler: ticks at least 8px apart, labels at least 64px apart, on friendly minute steps.
  const allMin = slides.reduce((n, s) => n + minutesOf(s), 0);
  const visibleMin = Math.floor(((scroller.current?.clientWidth ?? 1200) - 36) / ppm);
  const rulerMinutes = Math.max(Math.ceil(allMin), visibleMin);
  const minor = pick([1, 5, 15, 60], (m) => m * ppm >= 8);
  const major = pick([5, 15, 30, 60, 120, 240], (m) => m * ppm >= 64);
  const fmtTick = (m: number) => (m === 0 ? "0" : m % 60 === 0 ? `${m / 60}h` : m > 60 ? `${Math.floor(m / 60)}h${m % 60}` : `${m}m`);

  return (
    <div className="app show">
      <header className="bar">
        <div className="bar-left">
          <Nav current="show" />
        </div>
        <div />
        <div className="bar-right">
          <LightSwitch />
          <LiveLink />
        </div>
      </header>

      <main className="show-main">
        <section className="onair">
          <div className="device small">
            <div className="panel">
              {showing && !showing.blank ? (
                <EinkImage src={`/live.png?e=${encodeURIComponent(showing.etag)}`} />
              ) : showing?.asleep ? (
                <p className="panel-empty">Asleep. The panel keeps its last picture until {clock(showing.asleep)}.</p>
              ) : (
                <p className="panel-empty">Nothing on /live. Add this playlist to the show, or show something now.</p>
              )}
            </div>
            <span className="ribbon" aria-hidden />
          </div>

          <div className="status">
            <span className="on-air" data-on={!!showing && !showing.asleep} data-asleep={!!showing?.asleep}>
              {showing?.asleep ? "Asleep" : showing ? "On air" : "Off air"}
            </span>
            <h1>{showing?.asleep ? "Good night" : liveItem?.name ?? (showing ? "…" : "Nothing showing")}</h1>
            {showing?.asleep ? (
              <p>
                Night until <span className="tabular">{clock(showing.asleep)}</span>. The playlist
                {pinned ? " and the pinned item resume" : " resumes"} then.
              </p>
            ) : pinned ? (
              <p>
                {pinnedUntil ? (
                  <>
                    Shown now until <span className="tabular">{clock(pinnedUntil)}</span>, then the playlist carries on.{" "}
                  </>
                ) : (
                  "Pinned to /live until you resume the sequence. "
                )}
                <button className="link" onClick={resume}>Resume now</button>
              </p>
            ) : showing?.slideId ? (
              <p>
                {next ? (
                  <>
                    Next: <strong>{itemOf(next.source)?.name ?? "…"}</strong> in{" "}
                    <span className="tabular">{fmtCountdown(next.at - now)}</span>
                  </>
                ) : (
                  "The only item in the playlist right now."
                )}
              </p>
            ) : (
              <p>The playlist is empty or nothing is scheduled for now.</p>
            )}
          </div>
        </section>

        <section className="desk">
          <div className="timeline">
            <div className="timeline-head">
              {state && !current && (
                <button
                  className="ghost"
                  onClick={() => api.createPlaylist().then((s) => (accept(s), navigate(`/playlist/${s.created}`)))}
                >
                  + New playlist
                </button>
              )}
              {state && current && (
                <PlaylistTabs
                  playlists={playlists}
                  current={current}
                  onPick={(p) => navigate(`/playlist/${p.id}`)}
                  onCreate={() =>
                    api.createPlaylist().then((s) => {
                      accept(s);
                      navigate(`/playlist/${s.created}`);
                    })
                  }
                  onRename={(p, name) => api.updatePlaylist(p.id, { name }).then(accept)}
                  onDelete={(p) =>
                    api.deletePlaylist(p.id).then((s) => {
                      accept(s);
                      navigate(s.playlists[0] ? `/playlist/${s.playlists[0].id}` : "/show");
                    })
                  }
                />
              )}
              <span className="muted">
                {slides.length
                  ? `${fmtMinutes(totalMin)} · ${inShow ? "in the show" : "not in the show"}`
                  : "Drag drawings or apps here"}
              </span>
              <div className="zoom" role="group" aria-label="Zoom">
                <button onClick={() => zoom(-1)} disabled={ppm === ZOOMS[0]} aria-label="Zoom out">−</button>
                <button onClick={fit} disabled={!slides.length}>Fit</button>
                <button onClick={() => zoom(1)} disabled={ppm === ZOOMS[ZOOMS.length - 1]} aria-label="Zoom in">+</button>
              </div>
            </div>

            <div className="track-scroll" ref={scroller} data-more-start={trackEdges.start} data-more-end={trackEdges.end}>
              <div className="ruler" style={{ width: rulerMinutes * ppm }}>
                {Array.from({ length: Math.floor(rulerMinutes / minor) + 1 }, (_, i) => {
                  const m = i * minor;
                  return (
                    <span key={m} style={{ left: m * ppm }} data-major={m % major === 0}>
                      {m % major === 0 ? fmtTick(m) : ""}
                    </span>
                  );
                })}
              </div>
              <div
                ref={trackEl}
                className="track"
                style={{ minWidth: rulerMinutes * ppm, ["--grid" as string]: `${15 * ppm}px` }}
                onDragOver={onDragOver}
                onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropAt(null)}
                onDrop={onDrop}
                onClick={(e) => e.target === e.currentTarget && setSelected(null)}
              >
                {slides.map((s) => {
                  const img = itemOf(s.source);
                  const minutes = minutesOf(s);
                  const lifted = dragging?.kind === "slide" && dragging.id === s.id && dropAt !== null;
                  const ghostHere = dropAt !== null && !lifted && others.indexOf(s) === dropAt;
                  return [
                    ghostHere && <Ghost key="ghost" minutes={dragging?.minutes ?? 15} ppm={ppm} />,
                    <div
                      key={s.id}
                      ref={(el) => {
                        if (el) clipEls.current.set(s.id, el);
                        else clipEls.current.delete(s.id);
                      }}
                      className="clip"
                      data-selected={s.id === selected}
                      data-disabled={!s.enabled}
                      data-live={!pinned && showing?.clipId === s.id}
                      data-lifted={lifted}
                      data-size={minutes * ppm < 44 ? "xs" : minutes * ppm < 96 ? "s" : undefined}
                      style={{
                        width: minutes * ppm,
                        backgroundImage: img ? `url("${img.thumb}")` : undefined,
                      }}
                      draggable={!resizing}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(MIME_SLIDE, s.id);
                        e.dataTransfer.effectAllowed = "move";
                        setDragging({ kind: "slide", id: s.id, minutes });
                      }}
                      onDragEnd={endDrag}
                      onClick={() => setSelected(s.id)}
                      aria-haspopup="menu"
                      title={img?.name}
                    >
                      <span className="clip-label">
                        <span className="clip-name">{img?.name ?? "Missing"}</span>
                        <span className="clip-dur">{fmtMinutes(minutes)}</span>
                      </span>
                      {(s.start || s.days.length < 7) && <span className="clip-flag" title="Has a schedule">◷</span>}
                      <button
                        className="clip-x"
                        aria-label={`Remove ${img?.name ?? "clip"}`}
                        title="Remove"
                        draggable={false}
                        onClick={(e) => {
                          e.stopPropagation();
                          remove(s.id);
                        }}
                      >
                        ✕
                      </button>
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
                    </div>,
                  ];
                })}
                {dropAt !== null && dropAt >= others.length && <Ghost key="ghost" minutes={dragging?.minutes ?? 15} ppm={ppm} />}
                {playheadX !== null && <div className="playhead" style={{ transform: `translateX(${playheadX}px)` }} />}
              </div>
            </div>

            {sel ? (
              <Inspector
                slide={sel}
                item={itemOf(sel.source)}
                minutes={minutesOf(sel)}
                onDuration={(m) => setDuration(sel.id, m)}
                onPatch={(p) => patch(sel.id, p)}
                onShowNow={() => pin(sel.source, sel.durationS)}
                onRemove={() => remove(sel.id)}
              />
            ) : (
              <div className="bin">
                <span className="bin-label">Add</span>
                <ul ref={binList} data-more-start={binEdges.start} data-more-end={binEdges.end}>
                  {items.map((item) => (
                    <li key={item.key}>
                      <div
                        className="bin-item"
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData(MIME_SOURCE, item.key);
                          e.dataTransfer.effectAllowed = "copy";
                          setDragging({ kind: "source", id: item.key, minutes: NEW_CLIP_MIN });
                        }}
                        onDragEnd={endDrag}
                        // Tap to add at the end: drag and drop doesn't exist on touch screens.
                        onClick={() =>
                          pid &&
                          api.addSlide(item.source, pid).then((s) => {
                            accept(s);
                            toast.show(`Added ${item.name}`);
                          })
                        }
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLElement).click()}
                        data-live={!!showing?.source && keyOf(showing.source) === item.key}
                        data-kind={item.source.kind}
                        title={`Add “${item.name}”: tap to put it at the end, or drag it into place`}
                      >
                        <img src={item.thumb} alt="" draggable={false} />
                        <span>{item.name}</span>
                        <small>{item.label}</small>
                      </div>
                      <button className="bin-live" onClick={() => pin(item.source)} title="Show this on /live now">
                        Show now
                      </button>
                    </li>
                  ))}
                  {!items.length && <li className="muted">Nothing yet. Draw something, or set up an app.</li>}
                </ul>
              </div>
            )}
          </div>
        </section>
      </main>

      {sel && !resizing && !dragging && (
        // Clicks in the clip's settings below keep it selected: only clicking elsewhere lets go.
        <FloatingMenu anchor={clipEls.current.get(sel.id) ?? null} onClose={() => setSelected(null)} keepOpenWithin=".inspector">
          <MenuItem icon="show" onClick={() => pin(sel.source, sel.durationS)}>Show now</MenuItem>
          {slides.indexOf(sel) > 0 && (
            <MenuItem icon="earlier" onClick={() => move(sel.id, -1)} aria-label="Play earlier">Earlier</MenuItem>
          )}
          {slides.indexOf(sel) < slides.length - 1 && (
            <MenuItem icon="later" onClick={() => move(sel.id, 1)} aria-label="Play later">Later</MenuItem>
          )}
          <MenuDivider />
          <MenuItem icon="remove" danger onClick={() => remove(sel.id)}>Remove</MenuItem>
        </FloatingMenu>
      )}
      {toast.node}
    </div>
  );
}

type TabsProps = {
  playlists: PlaylistT[];
  current: PlaylistT;
  onPick: (p: PlaylistT) => void;
  onCreate: () => void;
  onRename: (p: PlaylistT, name: string) => void;
  onDelete: (p: PlaylistT) => void;
};

/** The playlists, in loop order. Double-click a name to rename it. */
function PlaylistTabs({ playlists, current, onPick, onCreate, onRename, onDelete }: TabsProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="pl-tabs">
      <a className="pl-all" href="/show" onClick={(e) => (e.preventDefault(), navigate("/show"))} title="The show">
        Show
      </a>
      <div className="pl-list" role="tablist" aria-label="Playlists">
        {playlists.map((p) =>
          editing === p.id ? (
            <input
              key={p.id}
              className="pl-rename"
              defaultValue={p.name}
              autoFocus
              onFocus={(e) => e.target.select()}
              onBlur={(e) => {
                setEditing(null);
                if (e.target.value.trim() && e.target.value !== p.name) onRename(p, e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setEditing(null);
              }}
              aria-label="Playlist name"
            />
          ) : (
            <button
              key={p.id}
              role="tab"
              aria-selected={p.id === current.id}
              onClick={() => onPick(p)}
              onDoubleClick={() => setEditing(p.id)}
              title="Double-click to rename"
            >
              {p.name}
            </button>
          ),
        )}
        <button className="pl-add" onClick={onCreate} aria-label="New playlist" title="New playlist">+</button>
      </div>
      <div className="pl-actions">
        {confirm ? (
          <>
            <span className="muted">Delete {current.name}?</span>
            <button className="danger" onClick={() => (setConfirm(false), onDelete(current))}>Delete</button>
            <button onClick={() => setConfirm(false)}>Cancel</button>
          </>
        ) : (
          <button className="danger" onClick={() => setConfirm(true)} title="Delete this playlist and its items">Delete</button>
        )}
      </div>
    </div>
  );
}

const clock = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Where the clip in hand will land if you let go: a glowing gap its own length. */
function Ghost({ minutes, ppm }: { minutes: number; ppm: number }) {
  return (
    <div className="drop-ghost" style={{ width: minutes * ppm }} aria-hidden>
      {minutes * ppm >= 44 && <span>{fmtMinutes(minutes)}</span>}
    </div>
  );
}

type InspectorProps = {
  slide: Slide;
  item: Item | undefined;
  minutes: number;
  onDuration: (minutes: number) => void;
  onPatch: (p: Partial<Slide>) => void;
  onShowNow: () => void;
  onRemove: () => void;
};

function Inspector({ slide, item, minutes, onDuration, onPatch, onShowNow, onRemove }: InspectorProps) {
  const allDay = !slide.start || !slide.end;
  return (
    <div className="inspector">
      <img src={item?.thumb} alt="" />
      <div className="field">
        <label>Clip</label>
        <strong>{item?.name ?? "Missing"}</strong>
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
