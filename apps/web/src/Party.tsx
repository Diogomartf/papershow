import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { FadeImage } from "./EinkImage";
import { LightSwitch } from "./LightSwitch";
import { LiveLink } from "./LiveLink";
import { MeMenu } from "./MeMenu";
import { Nav, navigate } from "./Nav";
import { cantOpen, photoScene, renderScene } from "./render";
import { Deck, Sheet } from "./Sheet";
import { Grip } from "./Grip";
import { useSortable } from "./sortable";
import * as api from "./slides";
import { type PartyClip, type PartyStory as Story, type PartySummary, type PartyTheme, type Turn } from "./slides";
import { useItems, type Source } from "./sources";
import { Oops, reason, tint, useMe, visiting, type Person } from "./house";
import { useLiveState, useNow } from "./live";
import { useUndoToast } from "./Undo";

const hhmm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const countdown = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};
const day = (t: number) => new Date(t).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
const things = (n: number) => `${n} ${n === 1 ? "thing" : "things"}`;

/** When a party ends, as a time of night: the next one after it starts. The server keeps it to the next morning. */
const ENDS = [
  { at: "22:00", label: "22:00" },
  { at: "00:00", label: "Midnight" },
  { at: "01:00", label: "1:00" },
  { at: "03:00", label: "3:00" },
] as const;

const QUARTER = 15 * 60_000;

/**
 * When a party ends, on a slider in quarter hours from a little after now to the morning, with the time big above it.
 * `onDone` is for letting go, so a party that's on changes once rather than at every step.
 */
function EndSlider({ value, now, morning, onChange, onDone }: { value: number; now: number; morning: number; onChange: (t: number) => void; onDone?: () => void }) {
  const min = Math.min(Math.ceil(now / QUARTER) * QUARTER + QUARTER, morning);
  const at = Math.min(Math.max(value, min), morning);
  return (
    <div className="party-end">
      <p className="party-end-at tabular">
        <strong>{hhmm(at)}</strong> <small>{countdown(at - now)} from now</small>
      </p>
      <input
        type="range"
        aria-label="Ends at"
        aria-valuetext={hhmm(at)}
        min={min}
        max={morning}
        step={QUARTER}
        value={at}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onDone}
        onKeyUp={onDone}
      />
      <p className="party-end-ends tabular">
        <span>{hhmm(min)}</span>
        <span>{hhmm(morning)}</span>
      </p>
    </div>
  );
}

/** The next `hhmm` after `now`: today's, or tomorrow's once it has passed. */
const nextAt = (hhmm: string, now: number) => {
  const d = new Date(now);
  const [h, m] = hhmm.split(":").map(Number);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
};

/** A picture of what played: a drawing or photo as it is, an app as it looked then. */
const thumbOf = (source: Source, at: number) => (source.kind === "image" ? `/api/images/${source.id}/mono.png` : api.frameAt(source, at));

/** Something from the party looked at up close: what it showed, when, and who added it. */
type Looking = { source: Source; at: number; name: string; by: Person | undefined; when: string };

/** Keep a picture: a phone offers its share sheet (Save Image, to the camera roll); a computer downloads it. */
async function keep(src: string, name: string) {
  const blob = await (await fetch(src)).blob();
  const file = new File([blob], `${name.trim() || "party"}.${blob.type === "image/jpeg" ? "jpg" : "png"}`, { type: blob.type });
  if (matchMedia("(pointer: coarse)").matches && navigator.canShare?.({ files: [file] })) return navigator.share({ files: [file] });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * A drawing, photo or app from the party, big, with Save. A drawing or photo also comes in its colours (Ink), as
 * it was made; an app is the panel's frame as it was then. `children`: what else can be done with it.
 */
function Look({ look, onClose, onError, children }: { look: Looking; onClose: () => void; onError: (e: unknown) => void; children?: ReactNode }) {
  const [ink, setInk] = useState(false);
  const [saving, setSaving] = useState(false);
  const image = look.source.kind === "image";
  const src = image ? `/api/images/${look.source.id}/${ink ? "png" : "mono"}.png` : api.frameAt(look.source, look.at);
  const save = () => {
    setSaving(true);
    keep(src, look.name)
      // Closing the share sheet without picking anything isn't a failure.
      .catch((e) => e instanceof DOMException && e.name === "AbortError" ? undefined : onError(e))
      .finally(() => setSaving(false));
  };
  return (
    <Sheet title={look.name} onClose={onClose}>
      <div className="pg-sheet-hero party-look">
        <FadeImage src={src} alt={look.name} className={ink ? "is-ink" : undefined} />
        <small>
          {look.by ? (
            <>
              <Face p={look.by} /> {look.by.name} ·{" "}
            </>
          ) : null}
          <span className="tabular">{look.when}</span>
        </small>
      </div>
      <div className="party-look-actions">
        {image && (
          <div className="segmented" role="radiogroup" aria-label="Version">
            <button role="radio" aria-checked={!ink} onClick={() => setInk(false)}>E-ink</button>
            <button role="radio" aria-checked={ink} onClick={() => setInk(true)}>Ink</button>
          </div>
        )}
        {children}
        <button className="primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "⬇︎ Save"}
        </button>
      </div>
    </Sheet>
  );
}

/** A picture in a list that opens big when tapped. */
function Thumb({ src, onOpen }: { src: string; onOpen: () => void }) {
  return (
    <button className="party-thumb" onClick={onOpen} aria-label="Look at it up close">
      <FadeImage src={src} />
    </button>
  );
}

/**
 * The looks a party can have. Each restyles the Party page (colours, type, the progress bar: see index.css) and
 * says a few things its own way.
 */
const THEMES: { key: PartyTheme; name: string; emoji: string; line: string; on: string; next: string }[] = [
  { key: "fun", name: "Fun", emoji: "🎉", line: "Confetti and colour", on: "The party's on", next: "Next in" },
  { key: "classy", name: "Classy", emoji: "🥂", line: "Black tie, cream and gold", on: "This evening", next: "Next in" },
  { key: "cave", name: "Man cave", emoji: "🍺", line: "Dark wood and neon", on: "The cave's open", next: "Next round in" },
  { key: "severance", name: "Severance", emoji: "🗂️", line: "Calm, clean and fluorescent", on: "Session in progress", next: "Next file in" },
  { key: "girls", name: "Girls' night", emoji: "💖", line: "Pink, glitter and hearts", on: "Girls' night's on", next: "Next cutie in" },
];
const themeOf = (key: PartyTheme | undefined) => THEMES.find((t) => t.key === key) ?? THEMES[0];

/** Pick a party's look: a little card in each one's own colours. */
function ThemePicker({ value, onChange }: { value: PartyTheme; onChange: (t: PartyTheme) => void }) {
  return (
    <div className="party-themes" role="radiogroup" aria-label="Look">
      {THEMES.map((t) => (
        <button key={t.key} className="party-theme" data-party-look={t.key} role="radio" aria-checked={value === t.key} onClick={() => onChange(t.key)}>
          <span className="party-theme-swatch" aria-hidden>
            {t.emoji}
          </span>
          <strong>{t.name}</strong>
          <small>{t.line}</small>
        </button>
      ))}
    </div>
  );
}

/** Confetti takes the party's colours (index.css sets them for each look). */
const CONFETTI = ["--pt-c1", "--pt-c2", "--pt-c3", "--pt-c4", "--pt-c5", "--pt-c6"];
/** Steady "random": the same burst draws the same way every render. */
const scatter = (n: number) => (Math.sin(n * 12.9898) * 43758.5453) % 1;

/** A burst of confetti each time `burst` goes up: something's just gone into the party. */
function Confetti({ burst }: { burst: number }) {
  if (!burst) return null;
  return (
    <div className="party-confetti" key={burst} aria-hidden>
      {Array.from({ length: 42 }, (_, i) => {
        const r = (k: number) => Math.abs(scatter(burst * 97 + i * 7 + k));
        return (
          <i
            key={i}
            style={
              {
                "--c": `var(${CONFETTI[i % CONFETTI.length]})`,
                "--x": `${(r(1) - 0.5) * 90}vw`,
                "--up": `${-20 - r(2) * 30}vh`,
                "--y": `${30 + r(3) * 40}vh`,
                "--r": `${(r(4) - 0.5) * 1440}deg`,
                "--d": `${r(5) * 120}ms`,
                "--w": `${6 + r(6) * 6}px`,
              } as CSSProperties
            }
          />
        );
      })}
    </div>
  );
}

function Face({ p }: { p: Person | undefined }) {
  return (
    <span className="face-mini" style={tint(p?.color ?? "#ccc")} title={p?.name} aria-hidden>
      {p?.face ?? "👤"}
    </span>
  );
}

/** Start a party: what it starts from (a playlist, or nothing), and until when. */
export function StartParty({ onClose }: { onClose: () => void }) {
  const { state, accept, skew } = useLiveState();
  const now = useNow(skew, 30_000);
  const toast = useUndoToast();
  const playlists = state?.playlists ?? [];
  const clipsOf = (id: string) => (state?.slides ?? []).filter((s) => s.playlistId === id && s.enabled);
  const { itemOf } = useItems();
  // A playlist called Party is picked to start with: it's probably the one.
  const [from, setFrom] = useState<string | null>(() => playlists.find((p) => /party|festa/i.test(p.name))?.id ?? null);
  // The end as a time of night ("03:00"), so it stays put while the clock moves.
  const [ends, setEnds] = useState("03:00");
  const [theme, setTheme] = useState<PartyTheme>("fun");
  const sleep = state?.sleep;
  const morning = nextAt(sleep?.enabled ? sleep.end : "08:00", now);
  // Only the times still to come tonight: at 23:00, 22:00 would be tomorrow's, past the morning.
  const choices = ENDS.filter((e) => nextAt(e.at, now) < morning);
  const until = Math.min(nextAt(ends, now), morning);

  const start = () =>
    api.startParty(from, until, theme).then(
      (s) => {
        accept(s);
        onClose();
        navigate("/party");
      },
      (e) => toast.show(reason(e, "Couldn't start the party"), undefined, "error"),
    );

  return (
    <Sheet title="Start a party" onClose={onClose}>
      <h3 className="pg-pick-label">Start with</h3>
      <ul className="pg-pick" role="radiogroup" aria-label="Start with">
        <li>
          <button className="pg-tile" role="radio" aria-checked={from === null} onClick={() => setFrom(null)}>
            <span className="pg-thumb">
              <span>🎈</span>
            </span>
            <strong>Nothing</strong>
            <small>only what people add</small>
          </button>
        </li>
        {playlists.map((p) => (
          <li key={p.id}>
            <button className="pg-tile" role="radio" aria-checked={from === p.id} onClick={() => setFrom(p.id)}>
              <span className="pg-thumb" data-stack>
                <Deck thumbs={clipsOf(p.id).flatMap((c) => itemOf(c.source)?.thumb ?? [])} />
              </span>
              <strong>{p.name}</strong>
              <small>{things(clipsOf(p.id).length)}</small>
            </button>
          </li>
        ))}
      </ul>
      <h3 className="pg-pick-label">Look</h3>
      <ThemePicker value={theme} onChange={setTheme} />
      <h3 className="pg-pick-label">Until</h3>
      <div className="pg-lengths pg-party-lengths" role="radiogroup" aria-label="Until">
        {choices.map((e) => (
          <button key={e.at} role="radio" aria-checked={until === nextAt(e.at, now)} onClick={() => setEnds(e.at)}>
            {e.label}
          </button>
        ))}
        <button role="radio" aria-checked={until === morning} onClick={() => setEnds(hhmm(morning))}>
          Morning
          <small className="tabular">{hhmm(morning)}</small>
        </button>
      </div>
      <EndSlider value={until} now={now} morning={morning} onChange={(t) => setEnds(hhmm(t))} />
      <div className="pg-actions">
        <button className="pg-big pg-go" onClick={start}>
          🎉 Start the party
        </button>
        <p className="pg-quiet">
          Everyone draws and adds photos on the Party page, and each joins the queue. What's made there stays with the party, not in the house's
          library. It ends at {hhmm(until)}, {hhmm(morning)} at the latest, then the program carries on and the party's story goes in the log.
        </p>
      </div>
      {toast.node}
    </Sheet>
  );
}

/** /party — while a party's on: what's playing, what's coming up, and drawing or adding photos straight into it. */
export function Party() {
  const { state, accept, skew } = useLiveState();
  const now = useNow(skew, 1000);
  const { me } = useMe();
  const household = !visiting(me);
  const { items } = useItems();
  const toast = useUndoToast();
  const [starting, setStarting] = useState(false);
  const [picking, setPicking] = useState(false);
  const [settings, setSettings] = useState(false);
  // Where the end slider is while it's held; it's saved on letting go.
  const [endDraft, setEndDraft] = useState<number | null>(null);
  const [adding, setAdding] = useState<{ done: number; total: number } | null>(null);
  const photos = useRef<HTMLInputElement>(null);
  const [past, setPast] = useState<PartySummary[] | null>(null);
  const [looking, setLooking] = useState<(Looking & { clip?: PartyClip; againId?: string; nowId?: string }) | null>(null);
  // Confetti each time something goes in.
  const [burst, setBurst] = useState(0);
  const pop = () => setBurst((b) => b + 1);

  const party = state?.party ?? null;
  useEffect(() => {
    document.title = "Party · Papershow";
  }, []);
  // The parties that are over: fetched again when one ends.
  useEffect(() => {
    if (!party) api.listParties().then(setPast, () => setPast([]));
  }, [party]);

  const people = state?.people ?? [];
  const personOf = (id: string | null) => (id ? people.find((p) => p.id === id) ?? (id === me.id ? me : undefined) : undefined);
  const failed = (e: unknown) => toast.show(reason(e, "That didn't work"), undefined, "error");
  const playlistName = party?.playlistId ? state?.playlists.find((p) => p.id === party.playlistId)?.name : undefined;

  /** Photos from this device, straight into the party, one after another. */
  const addPhotos = async (files: File[]) => {
    const pics = files.filter((f) => f.type.startsWith("image/"));
    if (!pics.length || adding) return;
    setAdding({ done: 0, total: pics.length });
    let added = 0;
    for (const file of pics) {
      try {
        const s = await photoScene(file);
        accept(await api.putPartyImage(s, await renderScene(s), true));
        added++;
      } catch (err) {
        toast.show(reason(err, cantOpen(file)), undefined, "error");
        // Past the hour's allowance the rest would fail the same way.
        if (err instanceof Oops && err.status === 429) break;
      }
      setAdding((a) => a && { ...a, done: a.done + 1 });
    }
    setAdding(null);
    if (added) {
      pop();
      toast.show(`${added === 1 ? "Your photo is" : `${added} photos are`} in the party 🎉`);
    }
  };

  const fromHouse = (source: Source, name: string) =>
    api.addToParty(source).then((s) => {
      accept(s);
      setPicking(false);
      pop();
      toast.show(`${name} is in the queue 🎉`);
    }, failed);

  const again = (clipId: string, name: string) =>
    api.playAgain(clipId).then((s) => {
      accept(s);
      setLooking(null);
      pop();
      toast.show(`${name} is on next 🔁`);
    }, failed);

  const showNow = (clipId: string, name: string) =>
    api.showNowAtParty(clipId).then((s) => {
      accept(s);
      setLooking(null);
      pop();
      toast.show(`${name} is on the panel 📺`);
    }, failed);

  const remove = (c: PartyClip) =>
    api.removeFromParty(c.id).then((s) => {
      setLooking(null);
      accept(s);
      toast.show(`Took ${c.name} out of the party`);
    }, failed);

  // Ending it opens its story, so the party just had is the one you see.
  const end = () => {
    const id = party?.id;
    api.endParty().then((s) => {
      accept(s);
      if (id) navigate(`/parties/${id}`);
      else toast.show("Back to the program. The party's story is in the log 🎉");
    }, failed);
  };

  // One time round the party's loop, from what's on now.
  const turns: Turn[] = (state?.sequence ?? []).filter((t) => t.blockId === "party");
  const clipOf = (t: Turn) => party?.clips.find((c) => c.id === t.clipId);
  const onNow = turns.find((t) => t.at <= now && now < t.endsAt);
  const showing = state?.showing;
  const live = showing && !showing.blank ? `/live.png?e=${encodeURIComponent(showing.etag)}` : null;
  const nowClip = onNow && clipOf(onNow);

  // The household sorts what's coming up by dragging; what's on stays where it is.
  const { lifted, order, bind, float } = useSortable((_, ids) => api.orderParty(ids).then(accept, failed));
  const upNext = turns.filter((t) => t !== onNow && t.clipId);
  const upNextIds = upNext.map((t) => t.clipId!);
  const sortedTurns = [...(onNow ? [onNow] : []), ...order("party", upNextIds).flatMap((id) => upNext.find((t) => t.clipId === id) ?? [])];
  const liftedTurn = lifted && upNext.find((t) => t.clipId === lifted.id);
  /** A turn of Coming up, up close. */
  const lookAt = (t: Turn) => {
    const c = clipOf(t);
    const mayRemove = c && (household || c.addedBy === me.id);
    setLooking({ source: t.source, at: t.at, name: c?.name ?? "…", by: personOf(c?.addedBy ?? null), when: t === onNow ? "On now" : `On at ${hhmm(t.at)}`, clip: mayRemove ? c : undefined, nowId: household && t !== onNow ? t.clipId ?? undefined : undefined });
  };
  const nextTurn = sortedTurns.find((t) => t !== onNow);
  const look = themeOf(party?.theme);
  const turnPct = onNow ? Math.min(100, Math.max(0, ((now - onNow.at) / (onNow.endsAt - onNow.at)) * 100)) : 0;
  /** One turn of Coming up, as a row: in the list, and floating under the pointer while it's dragged. */
  const turnRow = (t: Turn) => {
    const c = clipOf(t);
    const sorts = household && t !== onNow;
    const by = personOf(c?.addedBy ?? null);
    const mayRemove = c && (household || c.addedBy === me.id);
    return (
      <>
        <Thumb src={thumbOf(t.source, t.at)} onOpen={() => lookAt(t)} />
        <div>
          <strong>{c?.name ?? "…"}</strong>
          <small>
            {by ? (
              <>
                <Face p={by} /> {by.name}
              </>
            ) : (
              `From ${playlistName ?? "the start"}`
            )}
          </small>
        </div>
        <span className="party-at-cell">
          <span className="tabular party-at">{t === onNow ? "Now" : hhmm(t.at)}</span>
          {/* Shows on hover, in the time's place; always there where there's no hover. */}
          {household && t !== onNow && t.clipId && (
            <button className="party-now-btn" onClick={() => showNow(t.clipId!, c?.name ?? "It")} title="Put it on the panel now">
              <span aria-hidden>▶</span> <span className="party-now-label">Show now</span>
            </button>
          )}
        </span>
        {sorts && <Grip />}
        {mayRemove ? (
          <button className="party-remove danger" onClick={() => remove(c)} aria-label={`Take ${c.name} out`} title="Take it out of the party">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
            </svg>
          </button>
        ) : (
          <span />
        )}
      </>
    );
  };

  return (
    <div className="app" data-party-look={party?.theme ?? "fun"}>
      <header className="bar">
        <div className="bar-left">
          <Nav current="party" />
        </div>
        <div />
        <div className="bar-right">
          <LightSwitch />
          <LiveLink />
          <MeMenu />
        </div>
      </header>

      <main className="pl-overview pg party-page">
        {party ? (
          <>
            <section className="party-hero" aria-label="On the panel">
              <div className="party-snaps">
                <div className="party-polaroid">
                  <div className="pg-frame">{live ? <FadeImage src={live} /> : <span className="pg-frame-empty">🎈</span>}</div>
                </div>
                {/* What's on after this one, tucked over the corner. */}
                {nextTurn && (
                  <button className="party-next" onClick={() => lookAt(nextTurn)} aria-label={`Up next at ${hhmm(nextTurn.at)}: ${clipOf(nextTurn)?.name ?? "…"}`}>
                    <FadeImage src={thumbOf(nextTurn.source, nextTurn.at)} />
                    <span>
                      Next <b className="tabular">{hhmm(nextTurn.at)}</b>
                    </span>
                  </button>
                )}
              </div>
              <div className="party-hero-text">
                {/* How long the party has left goes with the party, not with what's on. */}
                <div className="party-status">
                  <span className="party-on">{look.on}</span>
                  {household && (
                    <button className="party-gear" data-cuelume-open onClick={() => setSettings(true)} aria-label="Party settings" title="Party settings">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <circle cx="12" cy="12" r="3" />
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                      </svg>
                    </button>
                  )}
                  <p className="party-clock tabular">
                    <strong>{countdown(party.endsAt - now)} left</strong> · until {hhmm(party.endsAt)}
                  </p>
                </div>
                {/* What's on the panel, at the bottom of the card: its name, who it's from, and how far through its turn. */}
                <div className="party-hero-what">
                  <span className="party-kicker">On the panel</span>
                  <h1>{nowClip?.name ?? (turns.length ? "…" : "Nothing yet")}</h1>
                  <p className="party-who">
                    {nowClip?.addedBy ? (
                      <>
                        <Face p={personOf(nowClip.addedBy)} /> {nowClip.own ? "Made" : "Added"} by {personOf(nowClip.addedBy)?.name ?? "someone"}
                        <span className="tabular"> · {hhmm(nowClip.addedAt)}</span>
                      </>
                    ) : nowClip ? (
                      `From ${playlistName ?? "the start"}`
                    ) : (
                      "Draw something or add photos, and it goes straight on."
                    )}
                  </p>
                  {onNow && nextTurn && (
                    <div className="party-turn">
                      {/* Each look draws this its own way (index.css): a runner on the bar, a beer filling up, blocks. */}
                      <span className="party-turn-bar" aria-hidden>
                        <i style={{ width: `${turnPct}%` }} />
                      </span>
                      <span className="tabular">
                        {look.next} {countdown(onNow.endsAt - now).replace(/^0 min$/, "a moment")}
                        {party.theme === "severance" && <b className="party-turn-pct"> · {Math.floor(turnPct)}%</b>}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </section>

            <section className="party-add" aria-label="Add to the party">
              <button className="party-sticker" data-c="pink" onClick={() => navigate("/draw?party")}>
                <span aria-hidden>✏️</span> Draw something
              </button>
              <button className="party-sticker" data-c="yellow" onClick={() => photos.current?.click()} disabled={!!adding}>
                <span aria-hidden>📷</span> {adding ? `Adding ${adding.done + 1} of ${adding.total}…` : "Add photos"}
              </button>
              {household && (
                <button className="party-sticker" data-c="lilac" data-cuelume-open onClick={() => setPicking(true)}>
                  <span aria-hidden>🏠</span> From the house
                </button>
              )}
              <input
                ref={photos}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  addPhotos([...(e.target.files ?? [])]);
                  e.target.value = "";
                }}
              />
            </section>

            {/* What's on, on a line of its own; then what's coming, to sort; then what's been. */}
            {onNow ? (
              <section className="party-loop party-now" aria-label="On now">
                <h2>On now</h2>
                <ol>
                  <li data-on>{turnRow(onNow)}</li>
                </ol>
              </section>
            ) : (
              !turns.length && <p className="pg-quiet">Nothing in the party yet. The first drawing or photo goes straight on.</p>
            )}

            {upNext.length > 0 && (
              <section className="party-loop" aria-label="Coming up">
                <h2>Coming up</h2>
                {household && upNext.length > 1 && <p className="pg-quiet">Drag to change what plays next.</p>}
                <ol>
                  {sortedTurns
                    .filter((t) => t !== onNow)
                    .map((t) =>
                      lifted && lifted.id === t.clipId ? (
                        <li key={t.key} className="sort-ghost" style={{ height: lifted.height }} aria-hidden />
                      ) : (
                        <li key={t.key} data-sorts={household} {...(household ? bind("party", t.clipId!, upNextIds) : {})}>
                          {turnRow(t)}
                        </li>
                      ),
                    )}
                </ol>
              </section>
            )}

            {/* What's been on, newest first, to pick again. The turn on air is in On now. */}
            {party.played.filter((p) => p.at < (onNow?.at ?? now)).length > 0 && (
              <section className="party-loop party-earlier" aria-label="Earlier">
                <h2>Earlier</h2>
                <ol>
                  {party.played
                    .filter((p) => p.at < (onNow?.at ?? now))
                    .map((p) => {
                      const by = personOf(p.addedBy);
                      const still = !p.gone && party.clips.some((c) => c.id === p.clipId);
                      return (
                        <li key={p.at}>
                          {p.gone ? (
                            <span className="party-cover-empty">…</span>
                          ) : (
                            <Thumb
                              src={thumbOf(p.source, p.at)}
                              onOpen={() => setLooking({ source: p.source, at: p.at, name: p.name, by, when: `Was on at ${hhmm(p.at)}`, againId: still ? p.clipId : undefined })}
                            />
                          )}
                          <div>
                            <strong>{p.name}</strong>
                            <small>
                              {by ? (
                                <>
                                  <Face p={by} /> {by.name}
                                </>
                              ) : (
                                `From ${playlistName ?? "the start"}`
                              )}
                            </small>
                          </div>
                          <span className="tabular party-at">{hhmm(p.at)}</span>
                          {still ? (
                            <button className="party-again" onClick={() => again(p.clipId, p.name)} title="Play it again, next">
                              🔁 Again
                            </button>
                          ) : (
                            <span />
                          )}
                        </li>
                      );
                    })}
                </ol>
              </section>
            )}
          </>
        ) : (
          <section className="party-off">
            <span className="pg-party-mark" aria-hidden>
              🎈
            </span>
            {household ? (
              <>
                <h1>No party right now</h1>
                <p className="pg-quiet">Start one and the panel is the party's until it ends: everyone draws and adds photos, and each joins the queue.</p>
                <button className="pg-big pg-go" data-cuelume-open onClick={() => setStarting(true)}>
                  Start a party
                </button>
              </>
            ) : (
              <>
                <h1>The party's over</h1>
                <p className="pg-quiet">Thanks for coming! Here's how it went.</p>
              </>
            )}
          </section>
        )}

        {!party && !!past?.length && (
          <section className="party-past" aria-label="Past parties">
            <h2>Parties</h2>
            <ul>
              {past.map((p) => (
                <li key={p.id} data-party-look={p.theme}>
                  <a
                    href={`/parties/${p.id}`}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                      e.preventDefault();
                      navigate(`/parties/${p.id}`);
                    }}
                  >
                    <span className="party-past-snap">
                      {p.cover ? <img src={`/api/images/${p.cover}/mono.png`} alt="" loading="lazy" /> : <span className="party-cover-empty">{themeOf(p.theme).emoji}</span>}
                    </span>
                    <span className="party-past-look">
                      {themeOf(p.theme).emoji} {themeOf(p.theme).name}
                    </span>
                    <strong>{day(p.startedAt)}</strong>
                    <small className="tabular">
                      {hhmm(p.startedAt)}–{hhmm(p.endedAt ?? p.endsAt)} · {things(p.things)}
                      {p.people.length ? ` from ${p.people.length} ${p.people.length === 1 ? "person" : "people"}` : ""}
                    </small>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>

      {starting && <StartParty onClose={() => setStarting(false)} />}
      {picking && (
        <Sheet title="From the house" onClose={() => setPicking(false)}>
          <ul className="pg-pick">
            {items.map((it) => (
              <li key={it.key}>
                <button className="pg-tile" onClick={() => fromHouse(it.source, it.name)}>
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
      {settings && party && (
        <Sheet title="The party" onClose={() => setSettings(false)}>
          <p className="party-settings-when tabular">
            Started at {hhmm(party.startedAt)}
            {party.startedBy && ` by ${personOf(party.startedBy)?.name ?? "someone"}`}
            {playlistName && `, from ${playlistName}`}.
          </p>
          <h3 className="pg-pick-label">Ends at</h3>
          <EndSlider
            value={endDraft ?? party.endsAt}
            now={now}
            morning={nextAt(state?.sleep?.enabled ? state.sleep.end : "08:00", party.startedAt)}
            onChange={setEndDraft}
            onDone={() => {
              if (endDraft === null || endDraft === party.endsAt) return setEndDraft(null);
              api.startParty(null, endDraft).then(
                (s) => {
                  accept(s);
                  setEndDraft(null);
                },
                (e) => {
                  setEndDraft(null);
                  failed(e);
                },
              );
            }}
          />
          <div className="party-settings-actions">
            <button
              className="pg-big pg-go"
              onClick={() => {
                setSettings(false);
                end();
              }}
            >
              ↩ End the party
            </button>
          </div>
          <h3 className="pg-pick-label">Look</h3>
          <ThemePicker value={party.theme} onChange={(t) => api.setPartyTheme(t).then(accept, failed)} />
          <p className="pg-quiet">A party goes on until the next morning at the latest. Ending it puts its story in the log, and its guests go home.</p>
        </Sheet>
      )}
      {looking && (
        <Look look={looking} onClose={() => setLooking(null)} onError={failed}>
          {looking.clip && (
            <button className="ghost danger" onClick={() => remove(looking.clip!)}>
              Take it out
            </button>
          )}
          {looking.nowId && (
            <button className="ghost" onClick={() => showNow(looking.nowId!, looking.name)}>
              ▶ Show now
            </button>
          )}
          {looking.againId && (
            <button className="ghost" onClick={() => again(looking.againId!, looking.name)}>
              🔁 Again
            </button>
          )}
        </Look>
      )}
      {liftedTurn && lifted && (
        <div ref={float} className="sort-float party-loop" style={{ width: lifted.width, height: lifted.height }} aria-hidden>
          <li data-sorts>{turnRow(liftedTurn)}</li>
        </div>
      )}
      <Confetti burst={burst} />
      {toast.node}
    </div>
  );
}

/** /parties/:id — a party that's over, as its story: when, who came, and everything that played, in order. */
export function PartyStory({ id }: { id: string }) {
  const { state } = useLiveState();
  const { me } = useMe();
  const [story, setStory] = useState<Story | null | undefined>(undefined);
  useEffect(() => {
    api.getPartyStory(id).then(setStory, () => setStory(null));
  }, [id]);
  useEffect(() => {
    document.title = story ? `Party, ${day(story.startedAt)} · Papershow` : "Party · Papershow";
  }, [story]);
  const people = state?.people ?? [];
  const personOf = (pid: string | null) => (pid ? people.find((p) => p.id === pid) ?? (pid === me.id ? me : undefined) : undefined);
  const [looking, setLooking] = useState<Looking | null>(null);
  const toast = useUndoToast();

  return (
    <div className="app" data-party-look={story?.theme ?? "fun"}>
      <header className="bar">
        <div className="bar-left">
          <Nav current="party" />
        </div>
        <div />
        <div className="bar-right">
          <LightSwitch />
          <LiveLink />
          <MeMenu />
        </div>
      </header>
      <main className="pl-overview pg party-page">
        <button className="pg-link party-back" onClick={() => navigate("/party")}>
          ← Parties
        </button>
        {story === null && <p className="pg-quiet">That party isn't here any more.</p>}
        {story && (
          <>
            <section className="party-story-head">
              <span className="pg-party-mark" aria-hidden>
                🎉
              </span>
              <div>
                <h1>The party, {day(story.startedAt)}</h1>
                <p className="pg-quiet tabular">
                  {hhmm(story.startedAt)}–{hhmm(story.endedAt ?? story.endsAt)}
                  {story.startedBy && ` · started by ${personOf(story.startedBy)?.name ?? "someone"}`}
                  {story.playlist && `, from ${story.playlist}`}
                </p>
                <p className="party-stats">
                  <strong>{things(story.things)}</strong> added, <strong>{story.made}</strong> made there
                  {story.people.length > 0 && (
                    <span className="party-faces">
                      {story.people.map((pid) => (
                        <Face key={pid} p={personOf(pid)} />
                      ))}
                    </span>
                  )}
                </p>
              </div>
            </section>
            {story.played.length > 0 && (
              <section className="party-loop" aria-label="How it went">
                <h2>How it went</h2>
                <ol>
                  {story.played.map((p) => {
                    const by = personOf(p.addedBy);
                    return (
                      <li key={p.at}>
                        {p.gone ? (
                          <span className="party-cover-empty">…</span>
                        ) : (
                          <Thumb src={thumbOf(p.source, p.at)} onOpen={() => setLooking({ source: p.source, at: p.at, name: p.name, by, when: `Was on at ${hhmm(p.at)}` })} />
                        )}
                        <div>
                          <strong>{p.name}</strong>
                          <small>
                            {by ? (
                              <>
                                <Face p={by} /> {by.name}
                              </>
                            ) : (
                              `From ${story.playlist ?? "the start"}`
                            )}
                          </small>
                        </div>
                        <span className="tabular party-at">{hhmm(p.at)}</span>
                        <span />
                      </li>
                    );
                  })}
                </ol>
              </section>
            )}
            <h2 className="party-all">Everything in it</h2>
            <ol className="party-story">
              {story.clips.map((c) => {
                const by = personOf(c.addedBy);
                return (
                  <li key={c.id} data-gone={c.gone} data-own={c.own}>
                    {c.gone ? (
                      <span className="party-cover-empty">…</span>
                    ) : (
                      <Thumb
                        src={thumbOf(c.source, c.addedAt)}
                        onOpen={() => setLooking({ source: c.source, at: c.addedAt, name: c.name, by, when: by ? `Added at ${hhmm(c.addedAt)}` : `From ${story.playlist ?? "the start"}` })}
                      />
                    )}
                    <strong>{c.name}</strong>
                    <small className="tabular">
                      {by ? (
                        <>
                          <Face p={by} /> {by.name} · {hhmm(c.addedAt)}
                        </>
                      ) : (
                        `From ${story.playlist ?? "the start"}`
                      )}
                    </small>
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </main>
      {looking && <Look look={looking} onClose={() => setLooking(null)} onError={(e) => toast.show(reason(e, "Couldn't save it"), undefined, "error")} />}
      {toast.node}
    </div>
  );
}
