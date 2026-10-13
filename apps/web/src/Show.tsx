import { useEffect, useState } from "react";
import { LightSwitch } from "./LightSwitch";
import { LiveLink } from "./LiveLink";
import { Nav, navigate } from "./Nav";
import { useLiveState, useNow } from "./live";
import * as api from "./slides";
import type { ShowEntry } from "./slides";
import { useItems, type Item } from "./sources";
import { useUndoToast } from "./Undo";

const every = (m: number) => (m === 60 ? "Hourly" : m % 60 ? `${m} min` : `${m / 60} h`);
const repeatLine = (m: number) => (m === 60 ? "every hour" : m % 60 ? `every ${m} min` : `every ${m / 60} hours`);
/** "08:00", "08:00 and 20:00", "08:00, 13:00 and 20:00" */
const timesLine = (t: string[]) => (t.length < 2 ? (t[0] ?? "") : `${t.slice(0, -1).join(", ")} and ${t.at(-1)}`);
/** What At times starts with: twice a day, to edit from there. */
const FIRST_TIMES = ["08:00", "20:00"];

/** The times an entry plays at, typed as "08:00, 20:00": saved on Enter or when you leave the box. */
function TimesInput({ times, onSave, label }: { times: string[]; onSave: (t: string[]) => void; label: string }) {
  const [text, setText] = useState(times.join(", "));
  const [was, setWas] = useState(times);
  // The server's answer (sorted, cleaned) replaces what was typed.
  if (was !== times) {
    setWas(times);
    setText(times.join(", "));
  }
  const save = () => {
    const next = text.split(/[,\s]+/).filter(Boolean);
    if (next.join() !== times.join()) onSave(next);
  };
  return (
    <input
      className="times-input tabular"
      // As wide as what's in it, so four times still read at a glance.
      style={{ width: `${text.length + 3}ch` }}
      value={text}
      onChange={(ev) => setText(ev.target.value)}
      onBlur={save}
      onKeyDown={(ev) => ev.key === "Enter" && (ev.target as HTMLInputElement).blur()}
      placeholder="08:00, 20:00"
      aria-label={label}
      title="Times of day, separated by commas, like 08:00, 13:00, 20:00"
      spellCheck={false}
    />
  );
}

const fmt = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`);

/** /show — what runs: playlists, images and apps, top to bottom, then again. */
export function Show() {
  const { state, accept, skew } = useLiveState();
  const now = useNow(skew, 1000);
  const { items, itemOf } = useItems();
  const toast = useUndoToast();

  useEffect(() => {
    document.title = "Show · Papershow";
  }, []);

  const show = state?.show ?? [];
  const playlists = state?.playlists ?? [];
  const clipsOf = (playlistId: string) => (state?.slides ?? []).filter((s) => s.playlistId === playlistId);
  const minutesOf = (e: ShowEntry) =>
    e.everyM || e.times?.length
      ? 0
      : e.playlistId
      ? clipsOf(e.playlistId).filter((s) => s.enabled).reduce((n, s) => n + s.durationS / 60, 0)
      : e.durationS / 60;
  const loopMin = show.filter((e) => e.enabled).reduce((n, e) => n + minutesOf(e), 0);
  const onAir = state?.live.mode === "rotate" && !state.showing?.asleep ? state?.showing?.entryId : null;

  // How far the entry on air is through its turn. A playlist's turn spans all its clips, so it began
  // the clips before this one ago. Null when nothing ends it: then there's nothing to count down.
  const turn = (() => {
    const s = state?.showing;
    const entry = show.find((e) => e.id === onAir);
    if (!s?.clip || !s.endsAt || !entry) return null;
    let { startedAt, endsAt } = s.clip;
    if (entry.playlistId) {
      const clips = clipsOf(entry.playlistId).filter((c) => c.enabled);
      const i = clips.findIndex((c) => c.id === s.clipId);
      startedAt -= clips.slice(0, Math.max(i, 0)).reduce((n, c) => n + c.durationS * 1000, 0);
      endsAt += clips.slice(i + 1).reduce((n, c) => n + c.durationS * 1000, 0);
    }
    const done = Math.min(1, Math.max(0, (now - startedAt) / (endsAt - startedAt)));
    return { done, leftM: Math.max(1, Math.ceil((endsAt - now) / 60_000)) };
  })();
  const onAirBadge = (
    <span className="on-air" data-on="true">
      On air{turn && <span className="left">· {fmt(turn.leftM)} left</span>}
    </span>
  );

  const nameOf = (e: ShowEntry) =>
    e.playlistId ? (playlists.find((p) => p.id === e.playlistId)?.name ?? "Playlist") : (itemOf(e.source)?.name ?? "…");

  const move = (i: number, dir: -1 | 1) => {
    const ids = show.map((e) => e.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    api.reorderShow(ids).then(accept);
  };

  const remove = (e: ShowEntry, index: number) => {
    api.removeFromShow(e.id).then(accept);
    toast.show(`Removed ${nameOf(e)} from the show`, () => api.restoreShowEntry(e, index).then(accept));
  };

  /** On the panel now, once: for its turn in the loop (a cut-in's minute is too short; those get 15), then the show carries on. */
  const showNow = (e: ShowEntry) =>
    e.source &&
    api.setLive({ mode: "pin", source: e.source, forS: e.everyM ? undefined : e.durationS }).then((s) => {
      accept(s);
      const until = s.live.mode === "pin" && s.live.until ? new Date(s.live.until) : null;
      toast.show(`${nameOf(e)} is on the panel${until ? ` until ${until.toTimeString().slice(0, 5)}` : ""}`);
    });

  const add = (what: { playlistId: string } | { source: Item["source"] }, name: string) =>
    api.addToShow(what).then((s) => {
      accept(s);
      toast.show(`Added ${name} to the show`);
    });

  return (
    <div className="app">
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

      <main className="pl-overview">
        <div className="pl-head">
          <div>
            <h1>Show</h1>
            <p className="muted">
              Runs top to bottom, then starts over{loopMin ? ` · one time around takes ${fmt(loopMin)}` : ""}. Set a drawing or app
              to repeat on the clock, like a clock every hour, or anything, playlists too, to play only at set times of day, and it
              cuts in between turns.
            </p>
          </div>
        </div>

        <ol className="pl-rows">
          {show.map((e, i) => {
            const clips = e.playlistId ? clipsOf(e.playlistId) : [];
            const single = e.source ? itemOf(e.source) : undefined;
            return (
              <li key={e.id} data-off={!e.enabled} data-onair={onAir === e.id} data-turn={onAir === e.id && !!turn}>
                {onAir === e.id && turn && (
                  // The border fills clockwise as the turn runs out; full means the next thing is due.
                  <svg className="turn" aria-hidden>
                    <rect width="100%" height="100%" rx={14} pathLength={100} strokeDasharray={`${turn.done * 100} 100`} />
                  </svg>
                )}
                <div className="pl-order">
                  <button onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Play ${nameOf(e)} earlier`}>↑</button>
                  <button onClick={() => move(i, 1)} disabled={i === show.length - 1} aria-label={`Play ${nameOf(e)} later`}>↓</button>
                </div>

                {e.playlistId ? (
                  <button className="pl-main" onClick={() => navigate(`/playlist/${e.playlistId}`)}>
                    <span className="pl-title">
                      {nameOf(e)}
                      {onAir === e.id && onAirBadge}
                    </span>
                    <span className="muted">
                      Playlist ·{" "}
                      {clips.length
                        ? `${clips.length} ${clips.length === 1 ? "item" : "items"} · ${fmt(clips.filter((c) => c.enabled).reduce((n, c) => n + c.durationS / 60, 0))}`
                        : "empty, add items to it"}
                      {e.times?.length ? ` · at ${timesLine(e.times)}` : ""}
                    </span>
                    <span className="pl-strip" aria-hidden>
                      {clips.slice(0, 8).map((s) => {
                        const it = itemOf(s.source);
                        return it ? <img key={s.id} src={it.thumb} alt="" /> : null;
                      })}
                      {clips.length > 8 && <span className="pl-more">+{clips.length - 8}</span>}
                    </span>
                  </button>
                ) : (
                  <div className="pl-main single">
                    {single && <img className="single-thumb" src={single.thumb} alt="" />}
                    <span>
                      <span className="pl-title">
                        {nameOf(e)}
                        {onAir === e.id && onAirBadge}
                      </span>
                      <span className="muted">
                        {single?.label ?? "Item"}
                        {e.everyM ? ` · cuts in ${repeatLine(e.everyM)}` : e.times?.length ? ` · at ${timesLine(e.times)}` : ""}
                      </span>
                    </span>
                  </div>
                )}

                <div className="pl-row-actions">
                  <div className="segmented repeat" role="radiogroup" aria-label={`When ${nameOf(e)} plays`}>
                    <button
                      role="radio"
                      aria-checked={!e.everyM && !e.times?.length}
                      onClick={() => api.updateShowEntry(e.id, { everyM: null, times: null }).then(accept)}
                      title="Takes its turn in the loop"
                    >
                      In loop
                    </button>
                    {!e.playlistId &&
                      api.REPEAT_EVERY.map((m) => (
                        <button
                          key={m}
                          role="radio"
                          aria-checked={e.everyM === m}
                          title={`Interrupts the loop ${repeatLine(m)}`}
                          onClick={() =>
                            api
                              .updateShowEntry(e.id, { everyM: m, ...(e.durationS >= m * 60 ? { durationS: 60 } : {}) })
                              .then(accept)
                          }
                        >
                          {every(m)}
                        </button>
                      ))}
                    <button
                      role="radio"
                      aria-checked={!!e.times?.length}
                      onClick={() => !e.times?.length && api.updateShowEntry(e.id, { times: FIRST_TIMES }).then(accept)}
                      title="Out of the loop; plays only at the times you set"
                    >
                      At times
                    </button>
                  </div>
                  {!!e.times?.length && (
                    <TimesInput times={e.times} label={`Times ${nameOf(e)} plays`} onSave={(times) => api.updateShowEntry(e.id, { times }).then(accept)} />
                  )}
                  {!e.playlistId && (
                    <div className="stepper" aria-label="Duration">
                      <button
                        onClick={() => api.updateShowEntry(e.id, { durationS: e.durationS - 60 }).then(accept)}
                        disabled={e.durationS <= 60}
                        aria-label="One minute less"
                      >
                        −
                      </button>
                      <span className="tabular">{fmt(e.durationS / 60)}</span>
                      <button
                        onClick={() => api.updateShowEntry(e.id, { durationS: e.durationS + 60 }).then(accept)}
                        disabled={!!e.everyM && e.durationS >= (e.everyM - 1) * 60}
                        aria-label="One minute more"
                      >
                        +
                      </button>
                    </div>
                  )}
                  <button
                    className="toggle"
                    role="switch"
                    aria-checked={e.enabled}
                    aria-label={`${nameOf(e)} runs`}
                    title={e.enabled ? "Runs in the show" : "Skipped"}
                    onClick={() => api.updateShowEntry(e.id, { enabled: !e.enabled }).then(accept)}
                  >
                    <span />
                  </button>
                  {e.playlistId ? (
                    <button className="ghost" onClick={() => navigate(`/playlist/${e.playlistId}`)}>Open</button>
                  ) : (
                    <button className="ghost" onClick={() => showNow(e)} title="On the panel now, then the show carries on">
                      Show now
                    </button>
                  )}
                  <button className="ghost danger" onClick={() => remove(e, i)} aria-label={`Remove ${nameOf(e)} from the show`}>
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
          {state && !show.length && <li className="pl-empty muted">The show is empty. Add a playlist, a drawing or an app below.</li>}
        </ol>

        <section className="show-add">
          <h2>Add to the show</h2>
          <div className="add-group">
            <h3>Playlists</h3>
            <ul className="add-playlists">
              {playlists.map((p) => {
                const clips = clipsOf(p.id);
                const minutes = clips.filter((c) => c.enabled).reduce((n, c) => n + c.durationS / 60, 0);
                return (
                  <li key={p.id}>
                    <button onClick={() => add({ playlistId: p.id }, p.name)} title={`Add ${p.name} to the show`}>
                      {/* A glimpse of what's in it: the first few clips, stacked like a deck. */}
                      <span className="pl-deck" aria-hidden>
                        {clips.length ? (
                          clips
                            .slice(0, 3)
                            .map((c, i) => {
                              const it = itemOf(c.source);
                              return it ? <img key={c.id} src={it.thumb} alt="" style={{ ["--i" as string]: i }} /> : null;
                            })
                            .reverse()
                        ) : (
                          <span className="pl-deck-empty">Empty</span>
                        )}
                      </span>
                      <span>
                        <span className="plus">+</span> {p.name}
                      </span>
                      <small className="muted">
                        {clips.length ? `${clips.length} ${clips.length === 1 ? "item" : "items"} · ${fmt(minutes)}` : "No items yet"}
                      </small>
                    </button>
                  </li>
                );
              })}
              <li>
                <button
                  className="new"
                  onClick={() =>
                    api.createPlaylist().then((s) => {
                      accept(s);
                      navigate(`/playlist/${s.created}`);
                    })
                  }
                >
                  <span className="pl-deck" aria-hidden>
                    <span className="pl-deck-empty">+</span>
                  </span>
                  <span>New playlist</span>
                </button>
              </li>
            </ul>
          </div>
          <div className="add-group">
            <h3>Drawings and apps, on their own</h3>
            <ul className="add-items">
              {items.map((it) => (
                <li key={it.key}>
                  <button onClick={() => add({ source: it.source }, it.name)} title={`Add ${it.name} to the show`}>
                    <img src={it.thumb} alt="" />
                    <span>
                      <span className="plus">+</span> {it.name}
                    </span>
                    <small className="muted">{it.label}</small>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>
      {toast.node}
    </div>
  );
}
