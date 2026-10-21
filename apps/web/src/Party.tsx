import { useEffect, useRef, useState } from "react";
import { EinkImage } from "./EinkImage";
import { LightSwitch } from "./LightSwitch";
import { LiveLink } from "./LiveLink";
import { MeMenu } from "./MeMenu";
import { Nav, navigate } from "./Nav";
import { cantOpen, photoScene, renderScene } from "./render";
import { Deck, Sheet } from "./Sheet";
import * as api from "./slides";
import { type PartyClip, type PartyStory as Story, type PartySummary, type Turn } from "./slides";
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

/** How long a party goes on: an end time is worked out when it starts. The server keeps it to the next morning. */
const LENGTHS = [
  { key: "2h", label: "2 hours" },
  { key: "4h", label: "4 hours" },
  { key: "morning", label: "Until morning" },
] as const;
type Length = (typeof LENGTHS)[number]["key"];

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
  const [length, setLength] = useState<Length>("morning");
  const sleep = state?.sleep;
  const morning = nextAt(sleep?.enabled ? sleep.end : "08:00", now);
  const until = length === "2h" ? now + 2 * 3_600_000 : length === "4h" ? now + 4 * 3_600_000 : morning;

  const start = () =>
    api.startParty(from, until).then(
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
      <h3 className="pg-pick-label">Until</h3>
      <div className="pg-lengths pg-party-lengths" role="radiogroup" aria-label="Until">
        {LENGTHS.map((l) => (
          <button key={l.key} role="radio" aria-checked={length === l.key} onClick={() => setLength(l.key)}>
            {l.label}
            {l.key === "morning" && <small className="tabular">{hhmm(morning)}</small>}
          </button>
        ))}
      </div>
      <div className="pg-actions">
        <button className="pg-big pg-go" onClick={start}>
          🎉 Start the party
        </button>
        <p className="pg-quiet">
          Everyone draws and adds photos on the Party page, and each goes on next. What's made there stays with the party, not in the house's
          library. It ends by {hhmm(morning)} at the latest, then the program carries on and the party's story goes in the log.
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
  const [adding, setAdding] = useState<{ done: number; total: number } | null>(null);
  const photos = useRef<HTMLInputElement>(null);
  const [past, setPast] = useState<PartySummary[] | null>(null);

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
    if (added) toast.show(`${added === 1 ? "Your photo is" : `${added} photos are`} in the party 🎉`);
  };

  const fromHouse = (source: Source, name: string) =>
    api.addToParty(source).then((s) => {
      accept(s);
      setPicking(false);
      toast.show(`${name} is on next 🎉`);
    }, failed);

  const again = (clipId: string, name: string) =>
    api.playAgain(clipId).then((s) => {
      accept(s);
      toast.show(`${name} is on next 🔁`);
    }, failed);

  const remove = (c: PartyClip) =>
    api.removeFromParty(c.id).then((s) => {
      accept(s);
      toast.show(`Took ${c.name} out of the party`);
    }, failed);

  const end = () =>
    api.endParty().then((s) => {
      accept(s);
      toast.show("Back to the program. The party's story is in the log 🎉");
    }, failed);

  // One time round the party's loop, from what's on now.
  const turns: Turn[] = (state?.sequence ?? []).filter((t) => t.blockId === "party");
  const clipOf = (t: Turn) => party?.clips.find((c) => c.id === t.clipId);
  const onNow = turns.find((t) => t.at <= now && now < t.endsAt);
  const showing = state?.showing;
  const live = showing && !showing.blank ? `/live.png?e=${encodeURIComponent(showing.etag)}` : null;
  const nowClip = onNow && clipOf(onNow);

  return (
    <div className="app">
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

      <main className="pl-overview pg party">
        {party ? (
          <>
            <section className="party-hero" aria-label="On the panel">
              <div className="pg-frame">{live ? <EinkImage src={live} /> : <span className="pg-frame-empty">🎈</span>}</div>
              <div className="party-hero-text">
                <span className="pg-badge" data-kind="party">
                  Party
                </span>
                <h1>{nowClip?.name ?? (turns.length ? "…" : "Nothing yet")}</h1>
                <p className="party-who">
                  {nowClip?.addedBy ? (
                    <>
                      <Face p={personOf(nowClip.addedBy)} /> {nowClip.own ? "Made" : "Added"} by {personOf(nowClip.addedBy)?.name ?? "someone"}
                    </>
                  ) : nowClip ? (
                    `From ${playlistName ?? "the start"}`
                  ) : (
                    "Draw something or add photos, and it goes on next."
                  )}
                </p>
                <p className="pg-quiet tabular">
                  Until {hhmm(party.endsAt)} · {countdown(party.endsAt - now)} left
                </p>
                {household && (
                  <div className="pg-row">
                    <button
                      className="pg-big pg-soft"
                      onClick={() => api.startParty(null, party.endsAt + 3_600_000).then(accept, failed)}
                      title="The party goes on until the morning at the latest"
                    >
                      An hour more
                    </button>
                    <button className="pg-big" onClick={end}>
                      ↩ End the party
                    </button>
                  </div>
                )}
              </div>
            </section>

            <section className="party-add" aria-label="Add to the party">
              <button className="pg-big pg-go" onClick={() => navigate("/draw?party")}>
                ✏️ Draw something
              </button>
              <button className="pg-big pg-go" onClick={() => photos.current?.click()} disabled={!!adding}>
                {adding ? `Adding ${adding.done + 1} of ${adding.total}…` : "📷 Add photos"}
              </button>
              {household && (
                <button className="pg-big pg-soft" data-cuelume-open onClick={() => setPicking(true)}>
                  🏠 From the house
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

            <section className="party-loop" aria-label="Coming up">
              <h2>Coming up</h2>
              {turns.length ? (
                <ol>
                  {turns.map((t) => {
                    const c = clipOf(t);
                    const by = personOf(c?.addedBy ?? null);
                    const mayRemove = c && (household || c.addedBy === me.id);
                    return (
                      <li key={`${t.key}-${t.at}`} data-on={t === onNow}>
                        <img src={api.frameAt(t.source, t.at)} alt="" loading="lazy" />
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
                        <span className="tabular party-at">{t === onNow ? "Now" : hhmm(t.at)}</span>
                        {mayRemove && (
                          <button className="party-remove danger" onClick={() => remove(c)} aria-label={`Take ${c.name} out`} title="Take it out of the party">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
                            </svg>
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="pg-quiet">Nothing in the party yet. The first drawing or photo goes straight on.</p>
              )}
            </section>

            {/* What's been on, newest first, to pick again. The turn on air is in Coming up. */}
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
                          {p.gone ? <span className="party-cover-empty">…</span> : <img src={thumbOf(p.source, p.at)} alt="" loading="lazy" />}
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
                <p className="pg-quiet">Start one and the panel is the party's until it ends: everyone draws and adds photos, and each goes on next.</p>
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
                <li key={p.id}>
                  <a
                    href={`/parties/${p.id}`}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                      e.preventDefault();
                      navigate(`/parties/${p.id}`);
                    }}
                  >
                    {p.cover ? <img src={`/api/images/${p.cover}/mono.png`} alt="" loading="lazy" /> : <span className="party-cover-empty">🎉</span>}
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

  return (
    <div className="app">
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
      <main className="pl-overview pg party">
        <button className="pg-link" onClick={() => navigate("/party")}>
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
                        {p.gone ? <span className="party-cover-empty">…</span> : <img src={thumbOf(p.source, p.at)} alt="" loading="lazy" />}
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
                    {c.gone ? <span className="party-cover-empty">…</span> : <img src={thumbOf(c.source, c.addedAt)} alt="" loading="lazy" />}
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
    </div>
  );
}
