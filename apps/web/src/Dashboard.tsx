import { useEffect, useRef, useState } from "react";
import { EinkImage } from "./EinkImage";
import { LightSwitch } from "./LightSwitch";
import { LiveLink } from "./LiveLink";
import { Nav, navigate } from "./Nav";
import { useLiveState, useNow } from "./live";
import { NightSettings } from "./NightSettings";
import * as api from "./slides";
import { frameAt, setLive } from "./slides";
import { FloatingMenu, MenuDivider, MenuItem, useUndoToast } from "./Undo";
import { useItems } from "./sources";

const hhmm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const countdown = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};
const ago = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
};
const mins = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60}` : ""}`;
};

export function Dashboard() {
  const { state, accept, skew } = useLiveState();
  const now = useNow(skew, 1000);
  const { itemOf } = useItems();
  const [menu, setMenu] = useState<{ key: string; el: HTMLElement } | null>(null);
  const toast = useUndoToast();
  const closeMenu = useRef(() => setMenu(null)).current;

  useEffect(() => {
    document.title = "Papershow";
  }, []);

  const showing = state?.showing ?? null;
  const asleep = showing?.asleep ?? null;
  const pinned = state?.live.mode === "pin";
  const pinnedUntil = state?.live.mode === "pin" ? (state.live.until ?? null) : null;
  const onAir = itemOf(showing?.source);
  const playlistName = (id: string | null) => (id ? (state?.playlists.find((p) => p.id === id)?.name ?? "") : "In the show");
  const seq = state?.sequence ?? [];
  const currentTurn = !pinned && !asleep ? seq.find((t) => t.key === showing?.slideId) : undefined;
  const nextTurn = !pinned && !asleep ? seq.find((t) => t.at > now) : undefined;
  const nextItem = itemOf(nextTurn?.source);
  const clip = showing?.clip;
  const progress = clip ? Math.min(1, Math.max(0, (now - clip.startedAt) / (clip.endsAt - clip.startedAt))) : 0;

  return (
    <div className="app dash">
      <header className="bar">
        <div className="bar-left">
          <Nav current="dashboard" />
        </div>
        <div />
        <div className="bar-right">
          <LightSwitch />
          <LiveLink />
        </div>
      </header>

      <main className="dash-main">
        <section className="dash-top">
          {/* On air: exactly what /live serves right now */}
          <div className="dash-onair">
            <div className="device small">
              <div className="panel">
                {showing && !showing.blank ? (
                  <EinkImage src={`/live.png?e=${encodeURIComponent(showing.etag)}`} />
                ) : (
                  <p className="panel-empty">
                    {asleep ? `Asleep. The panel keeps its last picture until ${hhmm(asleep)}.` : "Nothing on /live yet. Build a playlist to start."}
                  </p>
                )}
              </div>
              <span className="ribbon" aria-hidden />
            </div>
            <div className="dash-caption">
              <span className="on-air" data-on={!!showing && !asleep} data-asleep={!!asleep}>
                {asleep ? "Asleep" : showing ? "On air" : "Off air"}
              </span>
              <h1>{asleep ? "Good night" : onAir?.name ?? (showing ? "…" : "Nothing showing")}</h1>
              <p className="muted">
                {asleep
                  ? `Night until ${hhmm(asleep)}`
                  : pinned
                    ? pinnedUntil
                      ? `Show now · until ${hhmm(pinnedUntil)}`
                      : "Pinned with Show now"
                    : currentTurn
                      ? `${playlistName(currentTurn.playlistId)} · ${countdown((clip?.endsAt ?? now) - now)} left`
                      : ""}
                {pinned && !asleep && (
                  <>
                    {" · "}
                    <button className="link" onClick={() => setLive({ mode: "rotate" }).then(accept)}>Resume now</button>
                  </>
                )}
              </p>
              {currentTurn && <div className="progress" style={{ ["--p" as string]: progress }} aria-hidden />}
            </div>
          </div>

          <div className="dash-side">
            {/* Up next: rendered as it will look when it airs */}
            <div className="card next">
              <h2>Up next</h2>
              {nextTurn ? (
                <>
                  <img className="next-frame" src={frameAt(nextTurn.source, nextTurn.at)} alt="" />
                  <strong>{nextItem?.name ?? "…"}</strong>
                  <p className="muted">
                    at <span className="tabular">{hhmm(nextTurn.at)}</span>, in{" "}
                    <span className="tabular">{countdown(nextTurn.at - now)}</span> · {playlistName(nextTurn.playlistId)}
                  </p>
                </>
              ) : (
                <p className="muted">
                  {asleep ? `The playlists pick up at ${hhmm(asleep)}.` : pinned ? (pinnedUntil ? `The playlists pick up at ${hhmm(pinnedUntil)}.` : "Resume the playlists to see what's next.") : "Nothing else in the loop."}
                </p>
              )}
            </div>

            <div className="card">
              <h2>Device</h2>
              {state?.display ? (
                <p>
                  <span className="dot" data-on={now - state.display.at < 120_000} /> Checked in{" "}
                  <span className="tabular">{ago(now - state.display.at)}</span>
                </p>
              ) : (
                <p className="muted">No display has connected yet. Point ShowPi at <code>/live.bin</code>.</p>
              )}
              {state && <NightSettings sleep={state.sleep} onChange={(p) => api.setSleep(p).then(accept)} />}
            </div>
          </div>
        </section>

        {/* The whole loop ahead, every frame as it will look */}
        <section className="desk">
          <div className="timeline seq">
            <div className="timeline-head">
              <h2>Sequence</h2>
              <span className="muted">
                {seq.length
                  ? `${seq.length} in the loop · ${mins(seq[seq.length - 1].endsAt - seq[0].at)} around`
                  : "Empty"}
              </span>
              <a className="ghost" href="/show" onClick={(e) => (e.preventDefault(), navigate("/show"))}>
                Edit show
              </a>
            </div>
            <ol className="seq-strip">
              {seq.map((t, i) => {
                const item = itemOf(t.source);
                const live = t.key === currentTurn?.key && i === 0;
                const newList = i === 0 || seq[i - 1].entryId !== t.entryId;
                const key = `${t.key}-${t.at}`;
                return (
                  <li key={key} data-live={live} data-new-list={newList && (state!.show.length > 1)} data-open={menu?.key === key}>
                    {newList && state!.show.length > 1 && <span className="seq-list">{t.playlistId ? playlistName(t.playlistId) : "Single"}</span>}
                    <button
                      className="seq-frame"
                      aria-haspopup="menu"
                      aria-label={`${item?.name ?? "Item"} at ${hhmm(t.at)}`}
                      onClick={(e) => setMenu(menu?.key === key ? null : { key, el: e.currentTarget })}
                    >
                      <img
                        src={live && showing ? `/live.png?e=${encodeURIComponent(showing.etag)}` : frameAt(t.source, t.at)}
                        alt=""
                        loading="lazy"
                      />
                      {live && <div className="progress" style={{ ["--p" as string]: progress }} aria-hidden />}
                    </button>
                    <span className="seq-time tabular">{live ? "Now" : hhmm(t.at)}</span>
                    <strong>{item?.name ?? "…"}</strong>
                    <small className="muted">{mins(t.endsAt - t.at)}</small>
                  </li>
                );
              })}
            </ol>
          </div>
        </section>
      </main>

      {menu &&
        (() => {
          const turn = seq.find((t) => `${t.key}-${t.at}` === menu.key);
          if (!turn || !state) return null;
          const name = itemOf(turn.source)?.name ?? "clip";
          const clip = turn.clipId ? state.slides.find((x) => x.id === turn.clipId) : undefined;
          const entry = state.show.find((e) => e.id === turn.entryId);
          return (
            <FloatingMenu anchor={menu.el} onClose={closeMenu}>
              <MenuItem icon="show" onClick={() => (setMenu(null), setLive({ mode: "pin", source: turn.source }).then(accept))}>
                Show now
              </MenuItem>
              {turn.playlistId && (
                <MenuItem icon="open" onClick={() => navigate(`/playlist/${turn.playlistId}`)}>Open playlist</MenuItem>
              )}
              <MenuDivider />
              <MenuItem
                icon="remove"
                danger
                title={clip ? "Remove from its playlist" : "Remove from the show"}
                onClick={async () => {
                  setMenu(null);
                  if (clip) {
                    // A clip inside a playlist: take it out of that playlist.
                    const index = state.slides.filter((x) => x.playlistId === clip.playlistId).findIndex((x) => x.id === clip.id);
                    accept(await api.removeSlide(clip.id));
                    toast.show(`Removed ${name} from ${playlistName(clip.playlistId)}`, () => api.restoreSlide(clip, index).then(accept));
                  } else if (entry) {
                    // An image or app on its own in the show.
                    const index = state.show.findIndex((e) => e.id === entry.id);
                    accept(await api.removeFromShow(entry.id));
                    toast.show(`Removed ${name} from the show`, () => api.restoreShowEntry(entry, index).then(accept));
                  }
                }}
              >
                Remove
              </MenuItem>
            </FloatingMenu>
          );
        })()}
      {toast.node}
    </div>
  );
}
