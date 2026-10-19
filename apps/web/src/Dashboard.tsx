import { useEffect, useRef, useState } from "react";
import { EinkImage } from "./EinkImage";
import { LightSwitch } from "./LightSwitch";
import { LiveLink } from "./LiveLink";
import { MeMenu } from "./MeMenu";
import { Nav, navigate } from "./Nav";
import { useLiveState, useNow } from "./live";
import { NightSettings } from "./NightSettings";
import { Power } from "./Power";
import * as api from "./slides";
import { frameAt, setLive } from "./slides";
import { FloatingMenu, MenuDivider, MenuItem, useUndoToast } from "./Undo";
import { useItems } from "./sources";
import * as house from "./house";
import { reason, tint, useMe } from "./house";
import { LogList } from "./People";

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
  const { me } = useMe();
  const admin = me.role === "admin";
  const guest = me.role === "guest";
  const [menu, setMenu] = useState<{ key: string; el: HTMLElement } | null>(null);
  const toast = useUndoToast();
  const closeMenu = useRef(() => setMenu(null)).current;

  useEffect(() => {
    document.title = "Papershow";
  }, []);

  const showing = state?.showing ?? null;
  const away = !!showing?.away;
  // While away, `asleep` is 0 when there's no date to be back on, so test it against null, not for truth.
  const asleep = showing?.asleep ?? null;
  const resting = asleep !== null;
  const dayTime = (t: number) => new Date(t).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const restsUntil = away ? (asleep ? `until ${dayTime(asleep)}` : "until you turn it on") : `until ${hhmm(asleep ?? 0)}`;
  const pinned = state?.live.mode === "pin";
  const pinnedUntil = state?.live.mode === "pin" ? (state.live.until ?? null) : null;
  // A Show now or a drawing sent from Draw: on the panel, but not from the program.
  const outside = pinned && !resting && !showing?.invite;
  const onAir = itemOf(showing?.source);
  const playlistName = (id: string | null) => (id ? (state?.playlists.find((p) => p.id === id)?.name ?? "") : "In the show");
  const seq = state?.sequence ?? [];
  const currentTurn = !pinned && !resting ? seq.find((t) => t.key === showing?.slideId) : undefined;
  const nextTurn = !pinned && !resting ? seq.find((t) => t.at > now) : undefined;
  const nextItem = itemOf(nextTurn?.source);
  const clip = showing?.clip;
  const progress = clip ? Math.min(1, Math.max(0, (now - clip.startedAt) / (clip.endsAt - clip.startedAt))) : 0;

  return (
    <div className="app dash" data-off={away}>
      <header className="bar">
        <div className="bar-left">
          <Nav current="dashboard" />
        </div>
        <div />
        <div className="bar-right">
          <LightSwitch />
          <LiveLink />
          <MeMenu />
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
                    {resting ? `Asleep. The panel keeps its last picture ${restsUntil}.` : "Nothing on /live yet. Build a playlist to start."}
                  </p>
                )}
              </div>
              <span className="ribbon" aria-hidden />
            </div>
            <div className="dash-caption">
              <span className="on-air" data-on={!!showing && !resting} data-asleep={resting} data-outside={outside}>
                {away ? "Off" : resting ? "Asleep" : outside ? "Outside the program" : showing ? "On air" : "Off air"}
              </span>
              <h1>
                {away ? "Turned off" : resting ? "Good night" : showing?.invite ? "Invite" : onAir?.name ?? (showing ? "…" : "Nothing showing")}
              </h1>
              <p className="muted">
                {showing?.invite ? (
                  <>
                    Code {showing.invite}, until {hhmm(showing.endsAt ?? now)} or someone joins
                    {admin && (
                      <>
                        {" · "}
                        <button className="link" onClick={() => house.hideInvite(showing.invite!)}>Take it down</button>
                      </>
                    )}
                  </>
                ) : resting
                  ? `${away ? "Off" : "Night"} ${restsUntil}`
                  : pinned && state
                    ? `${api.pinnedBy(state.live, state.people, state.me)}${pinnedUntil ? ` · until ${hhmm(pinnedUntil)}` : ""}`
                    : currentTurn
                      ? `${playlistName(currentTurn.playlistId)} · ${countdown((clip?.endsAt ?? now) - now)} left`
                      : ""}
                {pinned && !resting && !guest && (
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
            {state?.asks.map((a) => {
              const who = state.people.find((p) => p.id === a.by);
              const name = itemOf(a.source)?.name ?? "something";
              const answer = (yes: boolean) =>
                (yes ? api.sayYes(a.id) : api.dropAsk(a.id)).then(accept, (e) => toast.show(reason(e, "That didn't work")));
              return (
                <div key={a.id} className="card knock-mini ask-card">
                  <h2>{guest ? "Waiting for a yes" : "Can I show this?"}</h2>
                  <img className="next-frame" src={frameAt(a.source, a.at)} alt="" />
                  <p>
                    {guest ? (
                      <>
                        <strong>{name}</strong> goes on the panel for {mins(a.forS * 1000)} once someone in the house says yes.
                      </>
                    ) : (
                      <>
                        <span className="face-mini" style={tint(who?.color ?? "#ccc")} aria-hidden>{who?.face ?? "👤"}</span>{" "}
                        <strong>{who?.name ?? "A guest"}</strong> wants to show <strong>{name}</strong> for {mins(a.forS * 1000)}
                      </>
                    )}
                  </p>
                  <div className="knock-actions">
                    {guest ? (
                      <button className="ghost" onClick={() => answer(false)}>Take it back</button>
                    ) : (
                      <>
                        <button className="big-yes" onClick={() => answer(true)}>Show it</button>
                        <button className="ghost" onClick={() => answer(false)}>Not now</button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}

            {!guest &&
              state?.people
                .filter((p) => p.status === "knocking")
                .map((p) => (
                  <div key={p.id} className="card knock-mini">
                    <h2>Knock knock</h2>
                    <p>
                      <span className="face-mini" style={tint(p.color)} aria-hidden>{p.face}</span> <strong>{p.name}</strong> wants to come in
                    </p>
                    <div className="knock-actions">
                      <button className="big-yes" onClick={() => house.updatePerson(p.id, { status: "in" }).then((s) => accept(s as api.State))}>
                        Let in
                      </button>
                      <button className="ghost" onClick={() => house.updatePerson(p.id, { status: "in", role: "guest" }).then((s) => accept(s as api.State))}>
                        As a guest
                      </button>
                      <button className="ghost" onClick={() => house.notNow(p.id).then((s) => accept(s as api.State))}>
                        Not now
                      </button>
                    </div>
                  </div>
                ))}

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
                  {resting ? (away && !asleep ? "The playlists wait until you're back." : `The playlists pick up ${restsUntil.replace("until", "at")}.`) : pinned ? (pinnedUntil ? `The playlists pick up at ${hhmm(pinnedUntil)}.` : "Resume the playlists to see what's next.") : "Nothing else in the loop."}
                </p>
              )}
            </div>

            <div className="card device-card">
              <h2>Device</h2>
              {state?.display ? (
                <p>
                  <span className="dot" data-on={now - state.display.at < 120_000} /> Checked in{" "}
                  <span className="tabular">{ago(now - state.display.at)}</span>
                </p>
              ) : (
                <p className="muted">No display has connected yet. Point ShowPi at <code>/live.bin</code>.</p>
              )}
              {state && admin && <Power sleep={state.sleep} back={away ? asleep || null : null} onChange={(p) => api.setSleep(p).then(accept)} />}
              {state && admin && !away && <NightSettings sleep={state.sleep} onChange={(p) => api.setSleep(p).then(accept)} />}
              {state && !admin && (
                <p className="muted">
                  {state.sleep.enabled ? `Sleeps ${state.sleep.start}–${state.sleep.end}.` : "Never sleeps."} An admin changes this.
                </p>
              )}
            </div>

            {!guest && (
              <div className="card lately">
                <h2>Lately</h2>
                <LogList entries={(state?.log ?? []).slice(0, 4)} people={state?.people ?? []} now={now} />
                <a className="link" href="/log" onClick={(e) => (e.preventDefault(), navigate("/log"))}>Whole log</a>
              </div>
            )}
          </div>
        </section>

        {/* The whole loop ahead, every frame as it will look */}
        <section className="desk">
          <div className="timeline seq">
            <div className="timeline-head">
              <h2>Sequence</h2>
              <span className="muted">
                {seq.length
                  ? `${seq.length} coming up · until ${hhmm(seq[seq.length - 1].endsAt)}`
                  : "Empty"}
              </span>
              {!guest && (
                <a className="ghost" href="/show" onClick={(e) => (e.preventDefault(), navigate("/show"))}>
                  Edit show
                </a>
              )}
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
          const failed = (e: unknown) => toast.show(reason(e, "That didn't work"));
          if (guest)
            return (
              <FloatingMenu anchor={menu.el} onClose={closeMenu}>
                <MenuItem
                  icon="show"
                  onClick={() => {
                    setMenu(null);
                    api.ask(turn.source).then((s) => (accept(s), toast.show(`Asked to show ${name} 🙋`)), failed);
                  }}
                >
                  Ask to show
                </MenuItem>
              </FloatingMenu>
            );
          return (
            <FloatingMenu anchor={menu.el} onClose={closeMenu}>
              <MenuItem icon="show" onClick={() => (setMenu(null), setLive({ mode: "pin", source: turn.source }).then(accept, failed))}>
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
                    const index = state.show.filter((e) => e.blockId === entry.blockId).findIndex((e) => e.id === entry.id);
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
