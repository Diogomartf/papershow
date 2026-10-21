import { useEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { EinkImage } from "./EinkImage";
import { LightSwitch } from "./LightSwitch";
import { LiveLink } from "./LiveLink";
import { MeMenu } from "./MeMenu";
import { Nav, navigate } from "./Nav";
import { useLiveState, useNow } from "./live";
import * as api from "./slides";
import { ENTRY_COLORS, type Block, type Days, type EntryColor, type ShowEntry, type State, type Turn } from "./slides";
import { Grip } from "./Grip";
import { reason } from "./house";
import { useSortable } from "./sortable";
import { useItems, type Item } from "./sources";
import { useUndoToast } from "./Undo";
import { cue } from "./sound";

const fmt = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`);
const hhmm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
/** Time left, ticking: 4:05, or 1:04:05 past the hour. */
const countdown = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};
/** How long a turn is on, in minutes; seconds for the short ones. */
const lasts = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : fmt(Math.round(ms / 60_000)));
const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** How long a single item can stay on, as big buttons rather than a number to nudge. */
const LENGTHS = [1, 5, 15, 30, 60];

/** The part of the day a block starts in, to name it. Only a name: the moon belongs to the panel's sleep. */
function partOf(start: string) {
  const h = Number(start.slice(0, 2));
  if (h >= 5 && h < 12) return "Morning";
  if (h >= 12 && h < 17) return "Afternoon";
  if (h >= 17 && h < 21) return "Evening";
  return "Night";
}

/** The day bar runs from 6:00 to 6:00 the next morning, the way a household's day goes, not midnight to midnight. */
const DAY_FROM = 6 * 60;
/** Minutes since the day bar starts. */
const sinceDayFrom = (min: number) => (min - DAY_FROM + 1440) % 1440;
/** A stretch of `len` minutes from `at` on the bar, cut in two where it runs past the bar's end. */
const onBar = (at: number, len: number): [number, number][] => {
  const a = sinceDayFrom(at);
  return a + len <= 1440 ? [[a, len]] : [[a, 1440 - a], [0, a + len - 1440]];
};
/** How much of the day the bar shows, in minutes: all of it, or two hours or one up close to read what plays when. */
const VIEWS = [
  { span: 1440, label: "Day", step: 60, major: 360, tick: 180 },
  { span: 120, label: "2 hours", step: 15, major: 60, tick: 30 },
  { span: 60, label: "1 hour", step: 5, major: 15, tick: 15 },
] as const;
type View = (typeof VIEWS)[number];
/** Day bar minutes as a clock time. */
const clockOf = (barMin: number) => {
  const m = (((Math.round(DAY_FROM + barMin) % 1440) + 1440) % 1440);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** Which plan a day plays: the weekend's own, or the weekdays'. */
const daysOf = (t: number, weekendOwn: boolean): Days => (weekendOwn && [0, 6].includes(new Date(t).getDay()) ? "weekend" : "weekdays");

/** A time of day you type: kept on Enter or when you leave the box, so half-typed times don't move anything. */
function TimeInput({ value, onSave, label }: { value: string; onSave: (t: string) => void; label: string }) {
  const [text, setText] = useState(value);
  const [was, setWas] = useState(value);
  if (was !== value) {
    setWas(value);
    setText(value);
  }
  const save = () => text && text !== value && onSave(text);
  return (
    <input
      className="pg-time tabular"
      type="time"
      value={text}
      aria-label={label}
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

/** A bottom sheet on phones, a card in the middle on bigger screens. */
/** On the tile playing now: a red dot, pulsing. */
function LiveDot() {
  return (
    <span className="pg-live-dot-box" role="img" aria-label="Live" title="Live">
      <span aria-hidden />
    </span>
  );
}

/** A playlist's first few pictures as a little pile. It fans out on hover, so you can see what else is in it. */
function Deck({ thumbs }: { thumbs: string[] }) {
  const cards = thumbs.slice(0, 3);
  if (!cards.length) return <span>Empty</span>;
  return (
    <span className="pg-deck" data-n={cards.length}>
      {cards.map((t, i) => <img key={i} src={t} alt="" data-i={i} />).reverse()}
    </span>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && (cue("close"), onClose());
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="pg-scrim" data-cuelume-close onClick={onClose}>
      <div className="pg-sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="pg-sheet-head">
          <h2>{title}</h2>
          <button className="pg-close" data-cuelume-close onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** /show — the week's program: what's on now, and what plays when, for weekdays and the weekend. */
export function Show() {
  const { state, accept, skew } = useLiveState();
  const now = useNow(skew, 1000);
  const { items, itemOf, catalog } = useItems();
  const toast = useUndoToast();

  useEffect(() => {
    document.title = "Show · Papershow";
  }, []);

  const weekendOwn = !!state?.program.weekendOwn;
  const today = daysOf(now, weekendOwn);
  const [picked, setPicked] = useState<Days | null>(null);
  const tab: Days = weekendOwn ? (picked ?? today) : "weekdays";
  const [adding, setAdding] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  // The bar remembers how close you last looked, on this device; two hours to start with.
  const [view, setView] = useState<View>(() => {
    try {
      return VIEWS.find((v) => String(v.span) === localStorage.getItem("show-view")) ?? VIEWS[1];
    } catch {
      return VIEWS[1];
    }
  });
  /** Where a close view was moved to, in day bar minutes; null follows now. */
  const [zoomAt, setZoomAt] = useState<number | null>(null);
  const cards = useRef(new Map<string, HTMLLIElement>());

  const show = state?.show ?? [];
  const playlists = state?.playlists ?? [];
  const clipsOf = (playlistId: string) => (state?.slides ?? []).filter((s) => s.playlistId === playlistId);
  const entryMin = (e: ShowEntry) =>
    e.playlistId ? clipsOf(e.playlistId).filter((s) => s.enabled).reduce((n, s) => n + s.durationS / 60, 0) : e.durationS / 60;
  const nameOf = (e: ShowEntry) =>
    e.playlistId ? (playlists.find((p) => p.id === e.playlistId)?.name ?? "Playlist") : (itemOf(e.source)?.name ?? "…");
  const thumbsOf = (playlistId: string) => clipsOf(playlistId).flatMap((c) => itemOf(c.source)?.thumb ?? []);
  const thumbOf = (e: ShowEntry) => (e.playlistId ? clipsOf(e.playlistId).map((c) => itemOf(c.source)?.thumb).find(Boolean) : itemOf(e.source)?.thumb);
  const entriesOf = (blockId: string) => show.filter((e) => e.blockId === blockId);
  /** An entry's colour on the day bar and its tile: the one picked, or one by its place in the block. */
  const colorOf = (e: ShowEntry): EntryColor =>
    e.color ?? ENTRY_COLORS[Math.max(0, entriesOf(e.blockId).filter((x) => x.enabled).findIndex((x) => x.id === e.id)) % ENTRY_COLORS.length];

  // In the order they come in the day, from 6:00; the last hands over to the first, the next morning.
  const blocks = (state?.program.blocks ?? [])
    .filter((b) => b.days === tab)
    .sort((a, b) => sinceDayFrom(minutesOf(a.start)) - sinceDayFrom(minutesOf(b.start)));
  /** When a block hands over: the next one's start, or the first one's (the next day) for the last. */
  const untilOf = (i: number) => blocks[(i + 1) % blocks.length]?.start ?? blocks[i].start;
  /** How long block `i` runs, in minutes: until the next one starts, or the whole day when it's alone. */
  const lengthOf = (i: number) => (blocks.length === 1 ? 1440 : (minutesOf(untilOf(i)) - minutesOf(blocks[i].start) + 1440) % 1440 || 1440);
  /** Each block's turns through the day: its things in order from its start, again and again until the next block. */
  const slots = blocks.flatMap((b, i) => {
    const entries = entriesOf(b.id).filter((e) => e.enabled);
    const from = minutesOf(b.start);
    const len = lengthOf(i);
    if (entries.length === 1) return [{ block: b, entry: entries[0], swatch: colorOf(entries[0]), at: from, len }];
    const out: { block: typeof b; entry: ShowEntry; swatch: EntryColor; at: number; len: number }[] = [];
    // Very short loops would draw hundreds of slivers; past a few hundred they read as one stripe anyway.
    for (let t = 0, k = 0; entries.length && t < len && out.length < 400; k++) {
      const e = entries[k % entries.length];
      const m = Math.max(entryMin(e), 0.5);
      out.push({ block: b, entry: e, swatch: colorOf(e), at: from + t, len: Math.min(m, len - t) });
      t += m;
    }
    return out;
  });
  const sleep = state?.sleep;
  // The time check isn't in any block: it cuts in on the hour, every hour, and the blocks carry on underneath.
  const timeCheck = state?.program.timeCheck;
  const clocks = items.filter((i) => catalog.find((k) => k.kind === i.appKind)?.category === "clock");
  const checking = !!timeCheck?.on && !!timeCheck.appId;
  const checkClock = timeCheck?.appId ? itemOf({ kind: "app", id: timeCheck.appId }) : undefined;

  // ── What's on ──
  const seq = state?.sequence ?? [];
  const showing = state?.showing ?? null;
  const away = !!showing?.away;
  const asleep = showing?.asleep ?? null;
  const resting = asleep !== null;
  const pinned = state?.live.mode === "pin";
  const pinnedUntil = state?.live.mode === "pin" ? (state.live.until ?? null) : null;
  const pinnedSource = state?.live.mode === "pin" ? state.live.source : null;
  // Something put on from outside the program (Show now, or sent from Draw), and who did it.
  const outside = pinned && !resting && !showing?.invite;
  const outsideBy = outside && state ? api.pinnedBy(state.live, state.people, state.me) : "";
  const onTurn = !pinned && !resting ? seq.find((t) => t.at <= now && now < t.endsAt) : undefined;
  const nextTurn = resting
    ? asleep
      ? seq.find((t) => t.endsAt > asleep)
      : undefined
    : pinned
      ? pinnedUntil
        ? (seq.find((t) => t.at <= pinnedUntil && pinnedUntil < t.endsAt) ?? seq.find((t) => t.at >= pinnedUntil))
        : undefined
      : seq.find((t) => t.at > now);
  // And the one after it, so you can see a little further ahead.
  const thenTurn = nextTurn ? seq[seq.indexOf(nextTurn) + 1] : undefined;
  const prevTurn = !pinned && !resting ? (state?.previous ?? null) : null;
  const turnName = (t: Turn) => itemOf(t.source)?.name ?? "…";
  const blockOnAir = state?.block?.id ?? null;

  const nowTitle = away
    ? "Turned off"
    : resting
      ? "Good night"
      : showing?.invite
        ? "Invite"
        : pinned
          ? (itemOf(pinnedSource)?.name ?? "On now")
          : onTurn
            ? turnName(onTurn)
            : "Nothing on";
  const nowFrame = showing && !showing.blank ? `/live.png?e=${encodeURIComponent(showing.etag)}` : null;
  const nowLine = away
    ? asleep
      ? `Off until ${new Date(asleep).toLocaleString(undefined, { weekday: "long", hour: "2-digit", minute: "2-digit" })}`
      : "Off until you turn it on"
    : resting
      ? `Asleep until ${hhmm(asleep ?? 0)}`
      : showing?.invite
        ? `Code ${showing.invite}`
        : pinned
          ? pinnedUntil
            ? `Until ${hhmm(pinnedUntil)}`
            : "Until you go back to the program"
          : onTurn
            ? `Until ${hhmm(onTurn.endsAt)}`
            : "Nothing planned right now";
  /** Time left on what's on, next to the On now badge. */
  const endsAt = away || resting || showing?.invite ? null : pinned ? pinnedUntil : (onTurn?.endsAt ?? null);
  const left = endsAt ? `${countdown(endsAt - now)} left` : null;
  const progress = onTurn ? Math.min(1, Math.max(0, (now - onTurn.at) / (onTurn.endsAt - onTurn.at))) : undefined;

  /** On the panel now, then the program carries on. */
  const air = (source: Item["source"], forS: number | undefined, name: string) =>
    api.setLive({ mode: "pin", source, forS }).then((s) => {
      accept(s);
      const until = s.live.mode === "pin" && s.live.until ? new Date(s.live.until) : null;
      toast.show(`${name} is on the panel${until ? ` until ${hhmm(until.getTime())}` : ""} 📺`, undefined, null);
    }, refused);
  const airTurn = (t: Turn) => air(t.source, Math.max(60, Math.round((t.endsAt - t.at) / 1000)), turnName(t));
  const airEntry = (e: ShowEntry) => {
    if (e.source) return air(e.source, e.durationS, nameOf(e));
    const clip = e.playlistId ? clipsOf(e.playlistId).find((c) => c.enabled) : undefined;
    if (clip) return air(clip.source, clip.durationS, itemOf(clip.source)?.name ?? nameOf(e));
  };

  // ── Changing the program ──
  const failed = (msg: string) => () => toast.show(msg, undefined, "error");
  /** The server said why it won't (a limit, say): show that. */
  function refused(e: unknown) {
    toast.show(reason(e, "That didn't work"), undefined, "error");
  }
  const addTime = () => {
    // An hour or three after the last block, or the first free hour of the day.
    const taken = new Set(blocks.map((b) => b.start));
    const last = blocks.length ? minutesOf(blocks.at(-1)!.start) : 6 * 60;
    // Otherwise any free hour, from 6:00 on, the way the day runs.
    const hours = [Math.floor(last / 60) + 3, Math.floor(last / 60) + 1, ...Array.from({ length: 24 }, (_, h) => (h + 6) % 24)];
    const h = hours.map((x) => x % 24).find((x) => !taken.has(`${String(x).padStart(2, "0")}:00`));
    if (h === undefined) return toast.show("Every hour already has something", undefined, "error");
    api.addBlock(tab, `${String(h).padStart(2, "0")}:00`).then((s) => {
      accept(s);
      requestAnimationFrame(() => cards.current.get(s.created)?.scrollIntoView({ behavior: "smooth", block: "center" }));
    }, failed("Couldn't add more content"));
  };
  const moveTime = (b: Block, start: string) =>
    api.moveBlock(b.id, start).then(accept, () => {
      toast.show(`There's already something at ${start}`, undefined, "error");
      api.getState().then(accept);
    });
  const removeTime = (b: Block) => {
    const kept = entriesOf(b.id);
    api.removeBlock(b.id).then(accept);
    toast.show(`Removed the ${partOf(b.start).toLowerCase()} from ${b.start}`, () => api.restoreBlock(b, kept).then(accept));
  };
  const add = (blockId: string, what: { playlistId: string } | { source: Item["source"] }, name: string) =>
    api.addToShow(what, blockId).then((s) => {
      accept(s);
      setAdding(null);
      toast.show(`Added ${name} 🎉`);
    }, refused);
  const move = (e: ShowEntry, dir: -1 | 1) => {
    const ids = entriesOf(e.blockId).map((x) => x.id);
    const i = ids.indexOf(e.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    api.reorderShow(ids).then(accept);
  };

  // Tiles sort by dragging, within their block.
  const { lifted, order, bind, float } = useSortable((_, ids) =>
    api.reorderShow(ids).then(accept, () => toast.show("Couldn't move it", undefined, "error")),
  );
  /** A block's entries, in the order being dragged into while a tile is lifted. */
  const sortedOf = (blockId: string) => {
    const entries = entriesOf(blockId);
    return order(blockId, entries.map((x) => x.id)).flatMap((id) => entries.find((x) => x.id === id) ?? []);
  };

  const remove = (e: ShowEntry) => {
    const index = entriesOf(e.blockId).findIndex((x) => x.id === e.id);
    setEditing(null);
    api.removeFromShow(e.id).then(accept);
    toast.show(`Removed ${nameOf(e)}`, () => api.restoreShowEntry(e, index).then(accept));
  };
  const setCheck = (patch: Partial<api.TimeCheck>) =>
    api.setTimeCheck(patch).then(accept, failed("Couldn't change the time check"));
  const setWeekend = (own: boolean) =>
    api.setWeekendOwn(own).then((s: State) => {
      accept(s);
      setPicked(own ? "weekend" : null);
      toast.show(own ? "The weekend has its own plan now, starting as a copy of the weekdays" : "Every day plays the same plan");
    });

  /** What a tile shows: its picture (a pile for a playlist), its name, and how long it plays. */
  const tileBody = (e: ShowEntry, live = false) => {
    const thumb = thumbOf(e);
    const count = e.playlistId ? clipsOf(e.playlistId).length : 0;
    return (
      <>
        {live && <LiveDot />}
        <Grip />
        <span className="pg-thumb" data-stack={!!e.playlistId}>
          {e.playlistId ? <Deck thumbs={thumbsOf(e.playlistId)} /> : thumb ? <img src={thumb} alt="" /> : <span>…</span>}
          {!e.enabled && <span className="pg-off">Off</span>}
        </span>
        <strong>{nameOf(e)}</strong>
        <small className="tabular">
          {e.enabled && <span className="pg-swatch" data-swatch={colorOf(e)} aria-hidden />}
          {e.playlistId ? `${count} ${count === 1 ? "thing" : "things"} · ` : ""}
          {fmt(entryMin(e))}
        </small>
      </>
    );
  };
  const liftedEntry = lifted && show.find((e) => e.id === lifted!.id);

  const editingEntry = show.find((e) => e.id === editing);
  const addingBlock = state?.program.blocks.find((b) => b.id === adding);
  const todayShown = tab === today;
  const nowMin = new Date(now).getHours() * 60 + new Date(now).getMinutes();
  // A close view follows now (a quarter of it already past), or 6:00 on the other plan, until it's moved.
  const span = view.span;
  const from = span === 1440 ? 0 : (zoomAt ?? (todayShown ? Math.floor((sinceDayFrom(nowMin) - span / 4) / 15) * 15 : 0));
  const vpct = (min: number) => `${(min / span) * 100}%`;
  /** The part of a stretch of the day bar in view, as minutes from the view's start. */
  const inView = ([a, len]: [number, number]): [number, number][] =>
    [0, 1440, -1440].flatMap((shift) => {
      const lo = Math.max(a + shift - from, 0);
      const hi = Math.min(a + shift - from + len, span);
      return hi > lo ? [[lo, hi - lo] as [number, number]] : [];
    });
  const sleepOnBar = sleep?.enabled ? onBar(minutesOf(sleep.start), (minutesOf(sleep.end) - minutesOf(sleep.start) + 1440) % 1440) : [];
  /** Tapping the whole day looks closer there, two hours around the tap. */
  // Up close, the bar drags sideways to move through the day. It only takes over the pointer once it has
  // moved a little, so a tap still reaches the turn under it.
  const drag = useRef<{ x: number; from: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragStart = (e: PointerEvent<HTMLElement>) => {
    if (span !== 1440) drag.current = { x: e.clientX, from, moved: false };
  };
  const dragMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 6) return;
    if (!d.moved) {
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
    }
    d.moved = true;
    setZoomAt(Math.round(d.from - (dx / e.currentTarget.getBoundingClientRect().width) * span));
  };
  const dragEnd = () => {
    // Let the click that ends a drag pass by before forgetting it, so it doesn't open a turn.
    setDragging(false);
    setTimeout(() => (drag.current = null));
  };
  const zoomTo = (e: MouseEvent<HTMLElement>) => {
    if (span !== 1440) return;
    const r = e.currentTarget.getBoundingClientRect();
    const at = ((e.clientX - r.left) / r.width) * 1440;
    pickView(VIEWS[1]);
    setZoomAt(Math.round((at - VIEWS[1].span / 2) / 15) * 15);
  };
  const pickView = (v: View) => {
    setView(v);
    setZoomAt(null);
    try {
      localStorage.setItem("show-view", String(v.span));
    } catch {
      // Private windows can refuse storage: it just won't be remembered.
    }
  };
  /** Lines every `step` minutes inside the view, as minutes from its start. */
  const every = (step: number) =>
    Array.from({ length: Math.floor(span / step) + 1 }, (_, k) => Math.ceil(from / step) * step + k * step - from).filter((m) => m >= 0 && m <= span);

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
          <MeMenu />
        </div>
      </header>

      <main className="pl-overview pg">
        {/* What's on: before, now, next, like a TV guide. */}
        <section className="pg-tv" aria-label="On the panel">
          <article className="pg-side" data-role="before">
            <span className="pg-badge" data-kind="before">Before</span>
            {prevTurn ? (
              <>
                <img className="pg-side-frame" src={api.frameAt(prevTurn.source, prevTurn.at)} alt="" />
                <strong>{turnName(prevTurn)}</strong>
                <span className="tabular">
                  {hhmm(prevTurn.at)}–{hhmm(prevTurn.endsAt)}
                </span>
                <span className="pg-span tabular">⏱ {lasts(prevTurn.endsAt - prevTurn.at)}</span>
              </>
            ) : (
              <p className="pg-quiet">{resting ? "The panel is resting" : "This is where it started"}</p>
            )}
          </article>

          <article className="pg-now" data-on={!!onTurn || pinned} data-outside={outside}>
            <div className="pg-frame">
              {nowFrame ? <EinkImage src={nowFrame} /> : <span className="pg-frame-empty">{resting ? "💤" : "📺"}</span>}
              {progress !== undefined && <div className="pg-progress" style={{ ["--p" as string]: progress }} aria-hidden />}
            </div>
            <div className="pg-now-text">
              <div className="pg-now-head">
                <span className="pg-badge" data-kind={resting ? "rest" : outside ? "outside" : "now"}>
                  {away ? "Off" : resting ? "Asleep" : outside ? "Outside the program" : "Live"}
                </span>
                {left && (
                  <span className="pg-left tabular">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <circle cx="8" cy="9" r="5.5" />
                      <path d="M8 6.5V9l1.6 1.2M6.5 1.5h3" />
                    </svg>
                    {left}
                  </span>
                )}
              </div>
              <div className="pg-now-head">
                <h1>{nowTitle}</h1>
                <span className="pg-now-when tabular">{nowLine}</span>
              </div>
              {outside && (
                <p className="pg-outside">
                  {outsideBy}
                  {pinnedUntil ? `. The program picks up at ${hhmm(pinnedUntil)}.` : "."}
                </p>
              )}
              {pinned && (
                <button className="pg-big" onClick={() => api.setLive({ mode: "rotate" }).then(accept)}>
                  ↩ Back to the program
                </button>
              )}
            </div>
          </article>

          {[nextTurn, thenTurn].map((t, i) =>
            i === 1 && !t ? null : (
              <article key={i} className="pg-side" data-role="next">
                <span className="pg-badge" data-kind="next">{i ? "Then" : resting ? "When it wakes" : "Next"}</span>
                {t ? (
                  <>
                    <img className="pg-side-frame" src={api.frameAt(t.source, t.at)} alt="" />
                    <strong>{turnName(t)}</strong>
                    <span className="tabular">At {hhmm(t.at)}</span>
                    <span className="pg-span tabular">⏱ {lasts(t.endsAt - t.at)}</span>
                    {!resting && (
                      <button className="pg-make-live" onClick={() => airTurn(t)}>
                        <span className="pg-live-dot" aria-hidden />
                        Make it live
                      </button>
                    )}
                  </>
                ) : (
                  <p className="pg-quiet">Nothing else coming up</p>
                )}
              </article>
            ),
          )}

        </section>

        {/* The week's plan. */}
        <section className="pg-week" aria-label="The week's program">
          <div className="pg-week-head">
            <h2>{weekendOwn ? "The week" : "Every day"}</h2>
            {weekendOwn ? (
              <div className="pg-tabs" role="tablist">
                {(["weekdays", "weekend"] as const).map((d) => (
                  <button key={d} role="tab" aria-selected={tab === d} onClick={() => setPicked(d)}>
                    <span>{d === "weekdays" ? "🎒 Weekdays" : "🎈 Weekend"}</span>
                    <small>{d === "weekdays" ? "Mon – Fri" : "Sat & Sun"}</small>
                    {today === d && <em>Today</em>}
                  </button>
                ))}
              </div>
            ) : (
              <button className="pg-big pg-soft" onClick={() => setWeekend(true)}>
                🎈 Make the weekend different
              </button>
            )}
          </div>

          {/* The day as one bar, 6:00 to 6:00, or up close: the blocks, the turns in them, the hours, and the night. */}
          {blocks.length > 0 && (
            <div className="pg-day">
              <div className="pg-day-head">
                <div className="pg-views" role="radiogroup" aria-label="How much to show">
                  {VIEWS.map((v) => (
                    <button key={v.span} role="radio" aria-checked={v === view} onClick={() => pickView(v)}>
                      {v.label}
                    </button>
                  ))}
                </div>
                {span !== 1440 && (
                  <div className="pg-move">
                    <button aria-label="Earlier" onClick={() => setZoomAt(from - span / 2)}>
                      ◀
                    </button>
                    <strong className="tabular">
                      {clockOf(from)} – {clockOf(from + span)}
                    </strong>
                    <button aria-label="Later" onClick={() => setZoomAt(from + span / 2)}>
                      ▶
                    </button>
                    {zoomAt !== null && todayShown && (
                      <button className="pg-link" onClick={() => setZoomAt(null)}>
                        Now
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div
                className="pg-day-bar"
                data-view={span}
                data-dragging={dragging}
                onClick={zoomTo}
                onPointerDown={dragStart}
                onPointerMove={dragMove}
                onPointerUp={dragEnd}
                onPointerCancel={dragEnd}
                title={span === 1440 ? "Tap to look closer" : "Drag to move through the day"}
              >
                {blocks.flatMap((b, i) =>
                  onBar(minutesOf(b.start), lengthOf(i))
                    .flatMap(inView)
                    .map(([a, len]) => (
                      <span key={`${b.id}-${a}`} className="pg-seg" data-on={todayShown && blockOnAir === b.id} style={{ left: vpct(a), width: vpct(len) }} />
                    )),
                )}
                {slots.flatMap((t) =>
                  onBar(t.at, t.len)
                    .flatMap(inView)
                    .map(([a, len]) =>
                      span === 1440 ? (
                        <span key={`${t.block.id}-${t.at}-${a}`} className="pg-slot" data-swatch={t.swatch} style={{ left: vpct(a), width: vpct(len) }} />
                      ) : (
                        <button
                          key={`${t.block.id}-${t.at}-${a}`}
                          className="pg-slot"
                          data-swatch={t.swatch}
                          style={{ left: vpct(a), width: vpct(len) }}
                          title={`${clockOf(sinceDayFrom(t.at))} ${nameOf(t.entry)}`}
                          // Quiet when the press was a pan of the day bar: only opening it sounds.
                          data-quiet
                          onClick={() => !drag.current?.moved && (cue("open"), setEditing(t.entry.id))}
                        >
                          {len >= span * 0.06 && <span>{nameOf(t.entry)}</span>}
                        </button>
                      ),
                    ),
                )}
                {every(view.step)
                  .filter((m) => m > 0 && m < span)
                  .map((m) => (
                    <span key={`h${m}`} className="pg-hour" data-major={(from + m) % view.major === 0} style={{ left: vpct(m) }} />
                  ))}
                {blocks.length > 1 &&
                  blocks.flatMap((b) =>
                    inView([sinceDayFrom(minutesOf(b.start)), 0.001])
                      .filter(([a]) => a > 0)
                      .map(([a]) => <span key={`s${b.id}`} className="pg-handover" style={{ left: vpct(a) }} />),
                  )}
                {checking &&
                  Array.from({ length: 24 }, (_, h) => sinceDayFrom(h * 60)).flatMap((m) =>
                    inView([m, timeCheck!.durationS / 60]).map(([a, len]) => (
                      <span key={`c${m}-${a}`} className="pg-chime" style={{ left: vpct(a), width: vpct(len) }} title={`${clockOf(m)} ${checkClock?.name ?? "Clock"}`} />
                    )),
                  )}
                {/* On top of the turns and the hours: the panel sleeps through them, so the night reads as one stretch. */}
                {sleepOnBar.flatMap(inView).map(([a, len]) => (
                  <span key={`z${a}`} className="pg-sleep" style={{ left: vpct(a), width: vpct(len) }}>
                    {len >= span * 0.06 && "🌙"}
                  </span>
                ))}
                {todayShown && inView([sinceDayFrom(nowMin), 0.001]).map(([a]) => <span key="now" className="pg-day-now" style={{ left: vpct(a) }} />)}
              </div>
              <div className="pg-day-ticks" aria-hidden>
                {every(view.tick).map((m) => (
                  <span key={m} style={{ left: vpct(m), transform: m === 0 ? "none" : m === span ? "translateX(-100%)" : "translateX(-50%)" }}>
                    {span === 1440 ? `${(6 + m / 60) % 24}h` : clockOf(from + m)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* The time check, outside the blocks: on the hour, every hour. */}
          {timeCheck && (
            <div className="pg-check" data-off={!checking}>
              <span className="pg-thumb">{checkClock?.thumb ? <img src={checkClock.thumb} alt="" /> : <span>🕐</span>}</span>
              <div>
                <strong>Time check on the hour</strong>
                <small>
                  {!clocks.length
                    ? "Make a clock on the Apps page and it shows for a minute at the top of every hour."
                    : `${checkClock?.name ?? "A clock"} cuts in for ${lasts(timeCheck.durationS * 1000)} at the top of every hour, whatever's on. Then the show carries on.`}
                </small>
                {clocks.length > 1 && timeCheck.on && (
                  <div className="segmented" role="radiogroup" aria-label="Which clock">
                    {clocks.map((c) => (
                      <button key={c.key} role="radio" aria-checked={c.source.id === timeCheck.appId} onClick={() => setCheck({ appId: c.source.id })}>
                        {c.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                className="toggle"
                role="switch"
                aria-checked={timeCheck.on}
                aria-label="Time check on the hour"
                disabled={!clocks.length}
                onClick={() => setCheck({ on: !timeCheck.on })}
              >
                <span />
              </button>
            </div>
          )}

          {/* One block is the whole day's content: it's named above the card, and the card holds just what plays. */}
          {blocks.length === 1 && (
            <div className="pg-blocks-head">
              <h3>Daily content</h3>
              <p>Plays in a loop from morning to morning. Add more content to play different things later in the day.</p>
            </div>
          )}
          <ol className="pg-blocks">
            {blocks.map((b, i) => {
              const name = partOf(b.start);
              const entries = entriesOf(b.id);
              const on = blockOnAir === b.id;
              const round = entries.filter((e) => e.enabled).reduce((n, e) => n + entryMin(e), 0);
              return (
                <li
                  key={b.id}
                  className="pg-block"
                  data-on={on}
                  ref={(el) => {
                    if (el) cards.current.set(b.id, el);
                    else cards.current.delete(b.id);
                  }}
                >
                  {on && (
                    <span className="pg-block-live">
                      <span aria-hidden />
                      Live
                    </span>
                  )}
                  {blocks.length > 1 && (
                    <header className="pg-block-head">
                      <div className="pg-when">
                        <span className="pg-part">{name}</span>
                        <span className="pg-range">
                          <TimeInput value={b.start} label={`${name} starts at`} onSave={(t) => moveTime(b, t)} />
                          <span className="pg-until tabular">→ {untilOf(i)}</span>
                        </span>
                      </div>
                    </header>
                  )}

                  <ol className="pg-tiles">
                    {sortedOf(b.id).map((e) => (
                      <li key={e.id} {...bind(b.id, e.id, entries.map((x) => x.id))}>
                        {lifted?.id === e.id ? (
                          // Where it will land.
                          <div className="sort-ghost" style={{ height: lifted.height }} aria-hidden />
                        ) : (
                          <button className="pg-tile" data-cuelume-open data-off={!e.enabled} data-on={on && onTurn?.entryId === e.id} onClick={() => setEditing(e.id)}>
                            {tileBody(e, on && onTurn?.entryId === e.id)}
                          </button>
                        )}
                      </li>
                    ))}
                    <li>
                      <button className="pg-tile pg-add" data-cuelume-open onClick={() => setAdding(b.id)}>
                        <span className="pg-thumb">
                          <span>＋</span>
                        </span>
                        <strong>Add</strong>
                        <small>a picture or playlist</small>
                      </button>
                    </li>
                  </ol>

                  <footer className="pg-block-foot">
                    <span>
                      {entries.length
                        ? `🔁 Plays in order, then starts again · ${fmt(Math.max(1, Math.round(round)))} each time round`
                        : "Nothing here yet: the panel keeps its last picture"}
                    </span>
                    {/* The only block is the whole day: removing it would leave nothing to add to. */}
                    {blocks.length > 1 && (
                      <button className="pg-link-danger" onClick={() => removeTime(b)}>
                        Remove
                      </button>
                    )}
                  </footer>
                </li>
              );
            })}
            {state && !blocks.length && <li className="pg-empty">No times yet. Add one to plan the day.</li>}
          </ol>

          <div className="pg-week-foot">
            <button className="pg-big pg-go" onClick={addTime}>
              ＋ Add more content
            </button>
            {weekendOwn && tab === "weekend" && (
              <button className="pg-big pg-soft" onClick={() => setWeekend(false)}>
                Same as weekdays
              </button>
            )}
          </div>
        </section>

        {/* The tile being dragged, under the pointer. */}
        {lifted && liftedEntry && (
          <div ref={float} className="sort-float" style={{ width: lifted.width, height: lifted.height }} aria-hidden>
            <div className="pg-tile" data-lifted>
              {tileBody(liftedEntry)}
            </div>
          </div>
        )}
      </main>

      {editingEntry && (
        <Sheet title={nameOf(editingEntry)} onClose={() => setEditing(null)}>
          {editingEntry.playlistId ? (
            // Everything in the playlist, in the order it plays.
            <div className="pg-sheet-hero">
              <span>
                Playlist · {clipsOf(editingEntry.playlistId).length} things · {fmt(entryMin(editingEntry))} each time round
              </span>
              <ol className="pg-gallery">
                {clipsOf(editingEntry.playlistId).map((c) => {
                  const it = itemOf(c.source);
                  return (
                    <li key={c.id} data-off={!c.enabled}>
                      {it?.thumb ? <img src={it.thumb} alt="" /> : <span className="pg-gallery-empty">…</span>}
                      <strong>{it?.name ?? "…"}</strong>
                      <small className="tabular">{c.enabled ? lasts(c.durationS * 1000) : "Skipped"}</small>
                    </li>
                  );
                })}
              </ol>
            </div>
          ) : (
            <div className="pg-sheet-hero">
              {thumbOf(editingEntry) && <img src={thumbOf(editingEntry)} alt="" />}
              <span>
                {itemOf(editingEntry.source)?.label ?? "Item"} · {fmt(entryMin(editingEntry))}
              </span>
            </div>
          )}
          <div className="pg-colors" role="radiogroup" aria-label="Colour on the day bar">
            {ENTRY_COLORS.map((c) => (
              <button
                key={c}
                role="radio"
                aria-label={c}
                aria-checked={colorOf(editingEntry) === c}
                data-swatch={c}
                onClick={() => api.updateShowEntry(editingEntry.id, { color: c }).then(accept)}
              />
            ))}
          </div>
          <div className="pg-actions">
            <button className="pg-big pg-go" onClick={() => (airEntry(editingEntry), setEditing(null))}>
              <span className="pg-live-dot" aria-hidden />
              Make it live
            </button>
            {!editingEntry.playlistId && (
              <div className="pg-lengths" role="radiogroup" aria-label="How long it stays on">
                {LENGTHS.map((m) => (
                  <button
                    key={m}
                    role="radio"
                    aria-checked={editingEntry.durationS === m * 60}
                    onClick={() => api.updateShowEntry(editingEntry.id, { durationS: m * 60 }).then(accept)}
                  >
                    {m === 60 ? "1 hour" : `${m} min`}
                  </button>
                ))}
              </div>
            )}
            <div className="pg-row">
              <button className="pg-big" onClick={() => move(editingEntry, -1)} disabled={entriesOf(editingEntry.blockId)[0]?.id === editingEntry.id}>
                ⬅ Earlier
              </button>
              <button className="pg-big" onClick={() => move(editingEntry, 1)} disabled={entriesOf(editingEntry.blockId).at(-1)?.id === editingEntry.id}>
                Later ➡
              </button>
            </div>
            <div className="pg-row">
              <button className="pg-big" onClick={() => api.updateShowEntry(editingEntry.id, { enabled: !editingEntry.enabled }).then(accept)}>
                {editingEntry.enabled ? "⏸ Skip it for now" : "▶ Play it again"}
              </button>
              {editingEntry.playlistId && (
                <button className="pg-big" onClick={() => navigate(`/playlist/${editingEntry.playlistId}`)}>
                  ✏️ Open playlist
                </button>
              )}
            </div>
            <button className="pg-big pg-danger" onClick={() => remove(editingEntry)}>
              🗑 Remove
            </button>
          </div>
        </Sheet>
      )}

      {addingBlock && (
        <Sheet title={blocks.length === 1 ? "Add to the day" : `Add to ${partOf(addingBlock.start).toLowerCase()} at ${addingBlock.start}`} onClose={() => setAdding(null)}>
          <h3 className="pg-pick-label">Playlists</h3>
          <ul className="pg-pick">
            {playlists.map((p) => {
              const clips = clipsOf(p.id);
              return (
                <li key={p.id}>
                  <button className="pg-tile" onClick={() => add(addingBlock.id, { playlistId: p.id }, p.name)}>
                    <span className="pg-thumb" data-stack>
                      <Deck thumbs={thumbsOf(p.id)} />
                    </span>
                    <strong>{p.name}</strong>
                    <small>{clips.length} {clips.length === 1 ? "thing" : "things"}</small>
                  </button>
                </li>
              );
            })}
          </ul>
          <h3 className="pg-pick-label">Drawings and apps</h3>
          <ul className="pg-pick">
            {items.map((it) => (
              <li key={it.key}>
                <button className="pg-tile" onClick={() => add(addingBlock.id, { source: it.source }, it.name)}>
                  <span className="pg-thumb">
                    <img src={it.thumb} alt="" />
                  </span>
                  <strong>{it.name}</strong>
                  <small>{it.label}</small>
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      )}
      {toast.node}
    </div>
  );
}
