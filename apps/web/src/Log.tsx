// The house log: who did what, newest first, a page at a time.
import { useCallback, useEffect, useState } from "react";
import { LightSwitch } from "./LightSwitch";
import { LiveLink } from "./LiveLink";
import { useLiveState, useNow } from "./live";
import { Nav } from "./Nav";
import { getLog, tint, type LogEntry } from "./house";
import { LogList } from "./People";

const PAGE = 50;

export function Log() {
  const { state, skew } = useLiveState();
  const now = useNow(skew, 30_000);
  const [person, setPerson] = useState<string | null>(null);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [more, setMore] = useState(false);

  useEffect(() => {
    document.title = "Log · Papershow";
  }, []);

  // Start over when the filter changes, and whenever someone does something new.
  const newest = state?.log[0]?.id;
  useEffect(() => {
    getLog({ person: person ?? undefined, limit: PAGE }).then((xs) => {
      setEntries(xs);
      setMore(xs.length === PAGE);
    });
  }, [person, newest]);

  const loadMore = useCallback(async () => {
    const xs = await getLog({ person: person ?? undefined, limit: PAGE, before: entries[entries.length - 1]?.id });
    setEntries((e) => [...e, ...xs]);
    setMore(xs.length === PAGE);
  }, [entries, person]);

  const everyone = state?.people ?? [];

  return (
    <div className="app people-page">
      <header className="bar">
        <div className="bar-left">
          <Nav current="log" />
        </div>
        <div />
        <div className="bar-right">
          <LightSwitch />
          <LiveLink />
        </div>
      </header>
      <main className="people-main">
        <section className="people-section">
          <h2>Log</h2>
          <div className="log-filter" role="radiogroup" aria-label="Whose">
            <button role="radio" aria-checked={person === null} onClick={() => setPerson(null)}>
              Everyone
            </button>
            {everyone
              .filter((p) => p.status !== "knocking")
              .map((p) => (
                <button key={p.id} role="radio" aria-checked={person === p.id} onClick={() => setPerson(p.id)}>
                  <span className="face-mini" style={tint(p.color)} aria-hidden>{p.face}</span> {p.name}
                </button>
              ))}
          </div>
          <LogList entries={entries} people={everyone} now={now} />
          {more && (
            <button className="ghost log-more" onClick={loadMore}>
              Older
            </button>
          )}
        </section>
      </main>
    </div>
  );
}
