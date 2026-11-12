// The Pi page: how the Pi is doing now, its temperature through a day, and the services' log lines, any day the
// journal still has. Today's keeps itself up to date; the health check runs every 15 minutes.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LightSwitch } from "./LightSwitch";
import { LiveLink } from "./LiveLink";
import { MeMenu } from "./MeMenu";
import { Nav } from "./Nav";
import { useNow } from "./live";
import { getPi, reason, restartPi, useMe, type PiLine, type PiReport, type PiSample, type PiService } from "./house";
import { cue } from "./sound";

/** The Pi 5 slows itself down here; health.sh warns from 75°C. */
const THROTTLE_C = 80;
const PAGE = 150;

const SERVICES: { key: PiService | null; label: string }[] = [
  { key: null, label: "Everything" },
  { key: "server", label: "Server" },
  { key: "panel", label: "Panel" },
  { key: "update", label: "Update" },
];

// Times as the Pi tells them, in its time zone: a Pi in Lisbon read from New York still says 18:00 at its 18:00.
const hm = (t: number, tz: string) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", timeZone: tz });
const hms = (t: number, tz: string) =>
  new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: tz });

/** "3 days", "5 h", "12 min": how long something has been up. */
function span(s: number) {
  if (s >= 2 * 86_400) return `${Math.floor(s / 86_400)} days`;
  if (s >= 3600) return `${Math.floor(s / 3600)} h`;
  return `${Math.max(1, Math.floor(s / 60))} min`;
}

const shiftDay = (day: string, by: number) => {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(y, m - 1, d + by);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};

function dayName(day: string, today: string) {
  if (day === today) return "Today";
  if (day === shiftDay(today, -1)) return "Yesterday";
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

/** Wi-Fi in words, from dBm: -30 is as good as it gets, under -75 drops out. */
const signal = (dbm: number) => (dbm >= -55 ? "excellent" : dbm >= -67 ? "good" : dbm >= -75 ? "fair" : "weak");

export function Pi() {
  const params = new URLSearchParams(location.search);
  const [day, setDay] = useState<string | null>(() => params.get("day"));
  // The chart: one day's checks, or the 30 days up to it, a day each.
  const [span, setSpan] = useState<Span>(() => (["week", "month", "year"] as const).find((x) => x === params.get("span")) ?? "day");
  // The logs' own days, first and last; null follows the chart's day.
  const [range, setRange] = useState<{ from: string; to: string } | null>(() => {
    const from = params.get("from");
    const to = params.get("to");
    return from && to ? { from, to } : null;
  });
  // What's typed, and what's searched: a moment after typing stops, not on every key.
  const [typed, setTyped] = useState(() => params.get("q") ?? "");
  const [q, setQ] = useState(typed.trim());
  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(t);
  }, [typed]);
  const [service, setService] = useState<PiService | null>(null);
  const [problems, setProblems] = useState(false);
  const [report, setReport] = useState<PiReport | null>(null);
  const [lines, setLines] = useState<PiLine[]>([]);
  const [more, setMore] = useState(false);
  // Where Older carries on from: the oldest entry the server read, which a filter may have skipped every one of.
  const [cursor, setCursor] = useState<number | null>(null);
  const [fetchingOlder, setFetchingOlder] = useState(false);
  const olderPending = useRef(false);
  const [paged, setPaged] = useState(false);
  const [failed, setFailed] = useState(false);
  const isAdmin = useMe().me.role === "admin";
  // After Restart the Pi: waiting for it to come back, then back for a moment.
  const [back, setBack] = useState<"waiting" | "back" | null>(null);

  useEffect(() => {
    document.title = "Pi · Papershow";
  }, []);

  // The day, the logs' days and the search in the address, so Back and a shared link land on them. Today has none.
  useEffect(() => {
    if (!report) return;
    const p = new URLSearchParams();
    if (report.day !== report.today) p.set("day", report.day);
    if (span !== "day") p.set("span", span);
    if (range) {
      p.set("from", range.from);
      p.set("to", range.to);
    }
    if (q) p.set("q", q);
    const url = p.size ? `/pi?${p}` : "/pi";
    if (location.pathname + location.search !== url) history.replaceState(history.state, "", url);
  }, [report, range, q, span]);

  const filters = useMemo(
    () => ({ service: service ?? undefined, problems: problems ? (1 as const) : undefined, q: q || undefined, from: range?.from, to: range?.to }),
    [service, problems, q, range],
  );

  // Only the newest request's answer counts: a slow one from before the last keystroke mustn't land on top of it.
  const asked = useRef(0);
  const load = useCallback(() => {
    const n = ++asked.current;
    return getPi({ day: day ?? undefined, span: span === "day" ? undefined : span, ...filters, limit: PAGE }).then(
        (r) => {
          if (n !== asked.current) return;
          setReport(r);
          setLines(r.lines);
          setMore(r.more);
          setCursor(r.cursor);
          setPaged(false);
          setFailed(false);
        },
        () => n === asked.current && setFailed(true),
      );
  }, [day, span, filters]);

  useEffect(() => {
    load();
  }, [load]);

  // While the Pi restarts, ask every 5 s. The first answer after it went away means it's back.
  const wentAway = useRef(false);
  useEffect(() => {
    if (back !== "waiting") return;
    wentAway.current = false;
    const t = setInterval(() => {
      getPi({ limit: 1 }).then(
        () => {
          if (!wentAway.current) return;
          setBack("back");
          cue("success");
          load();
          setTimeout(() => setBack((b) => (b === "back" ? null : b)), 6000);
        },
        () => (wentAway.current = true),
      );
    }, 5000);
    return () => clearInterval(t);
  }, [back, load]);

  // Today's keeps coming, unless older lines are open: they'd be pulled out from under you.
  const live = !!report && report.day === report.today && (!range || range.to === report.today) && !paged;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => document.visibilityState === "visible" && load(), 30_000);
    return () => clearInterval(t);
  }, [live, load]);

  // One at a time: a second click before the answer would ask from the same place and add the same lines twice.
  const older = async () => {
    if (!report || cursor === null || olderPending.current) return;
    olderPending.current = true;
    setFetchingOlder(true);
    const n = asked.current;
    try {
      const r = await getPi({ day: report.day, ...filters, limit: PAGE, before: cursor });
      if (n !== asked.current) return;
      setLines((xs) => [...xs, ...r.lines]);
      setMore(r.more);
      setCursor(r.cursor);
      setPaged(true);
    } catch {
      // Older stays, to try again.
    } finally {
      olderPending.current = false;
      setFetchingOlder(false);
    }
  };

  // A new day for the chart brings the logs back to that day.
  const go = (to: string) => (setDay(to), setRange(null));

  const shown = day ?? report?.day ?? "";
  const first = report?.firstDay ?? null;
  const today = report?.today ?? "";
  const from = range?.from ?? shown;
  const to = range?.to ?? shown;
  // Over several days, each line says which.
  const manyDays = from !== to;
  const week = { from: first && shiftDay(today, -6) < first ? first : shiftDay(today, -6), to: today };
  const RANGES = [
    { label: "That day", value: null },
    { label: "7 days", value: week },
    { label: "Everything", value: first ? { from: first, to: today } : null },
  ];
  const sameRange = (a: typeof range, b: typeof range) => (a === null ? b === null : !!b && a.from === b.from && a.to === b.to);
  const picked = RANGES.findIndex((r) => sameRange(range, r.value));
  const setDays = (f: string, t: string) => setRange(f === shown && t === shown ? null : f <= t ? { from: f, to: t } : { from: t, to: f });

  return (
    <div className="app people-page pi-page">
      <header className="bar">
        <div className="bar-left">
          <Nav current="pi" />
        </div>
        <div />
        <div className="bar-right">
          <LightSwitch />
          <LiveLink />
          <MeMenu />
        </div>
      </header>
      <main className="people-main">
        {failed && !report && <p className="muted people-empty">Couldn't reach the Pi's readings. Is the server up?</p>}
        {report?.sample && (
          <p className="pi-note">
            Sample readings: this server isn't running on a Pi, so there's no journal to read. On the Pi, this page shows its own.
          </p>
        )}
        {report && !report.keepsLogs && !report.sample && (
          <p className="pi-note">
            This Pi keeps its logs in memory, so a restart forgets the days before it. To keep them, run{" "}
            <code>sudo mkdir -p /var/log/journal && sudo systemctl restart systemd-journald</code> on the Pi.
          </p>
        )}

        {report && <NowTiles report={report} />}
        {report && isAdmin && !report.sample && <Restarts onPi={() => setBack("waiting")} />}
        {back && (
          <p className="pi-note" data-back={back} role="status">
            {back === "waiting" ? "The Pi is restarting. This page picks up again when it's back, in about a minute." : "The Pi is back. ✓"}
          </p>
        )}

        <section className="people-section">
          <div className="section-head">
            <h2>Temperature</h2>
            <div className="pi-day">
              <div className="log-filter pi-span" role="radiogroup" aria-label="How long">
                {(Object.keys(SPAN_LABELS) as Span[]).map((x) => (
                  <button key={x} role="radio" aria-checked={span === x} onClick={() => setSpan(x)}>
                    {SPAN_LABELS[x]}
                  </button>
                ))}
              </div>
              <button
                className="ghost"
                onClick={() => go(shiftDay(shown, -SPAN_DAYS[span]))}
                disabled={!shown || (!!first && shiftDay(shown, 1 - SPAN_DAYS[span]) <= first)}
                aria-label={span === "day" ? "The day before" : "Further back"}
              >
                ‹
              </button>
              <label className="pi-date">
                <span>{report ? dayName(shown, report.today) : "…"}</span>
                <input
                  type="date"
                  value={shown}
                  min={first ?? undefined}
                  max={report?.today}
                  onChange={(e) => e.target.value && go(e.target.value)}
                  aria-label="Day"
                />
              </label>
              <button
                className="ghost"
                onClick={() => go(shiftDay(shown, SPAN_DAYS[span]) > (report?.today ?? "") ? (report?.today ?? shown) : shiftDay(shown, SPAN_DAYS[span]))}
                disabled={!report || shown >= report.today}
                aria-label={span === "day" ? "The day after" : "Later"}
              >
                ›
              </button>
              {report && shown !== report.today && (
                <button className="ghost" onClick={() => go(report.today)}>
                  Today
                </button>
              )}
            </div>
          </div>
          {report &&
            (span !== "day" ? (
              report.days ? (
                <RangeChart report={report} span={span} onPick={(d, to) => (setSpan(to), go(d))} />
              ) : (
                <div className="pi-chart pi-chart-empty" />
              )
            ) : (
              <TempChart report={report} samples={report.day === shown ? report.health : []} />
            ))}
        </section>

        <section className="people-section">
          <h2>Logs</h2>
          <div className="pi-search-row">
            <label className="pi-search-box">
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                <circle cx="7" cy="7" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.75" />
                <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
              </svg>
              <input
              className="pi-search"
              type="search"
              placeholder="Search the logs"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              aria-label="Search the logs"
              spellCheck={false}
            />
            </label>
            <div className="pi-range">
              <div role="radiogroup" aria-label="Which days" className="log-filter">
                {RANGES.map((r, i) => (
                  <button
                    key={r.label}
                    role="radio"
                    // When the journal is a week long, 7 days is Everything too: only the first lights up.
                    aria-checked={i === picked}
                    disabled={r.label === "Everything" && !first}
                    onClick={() => setRange(r.value)}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <span className="pi-days">
                <input type="date" value={from} min={first ?? undefined} max={today} onChange={(e) => e.target.value && setDays(e.target.value, to)} aria-label="From" />
                <span aria-hidden>–</span>
                <input type="date" value={to} min={first ?? undefined} max={today} onChange={(e) => e.target.value && setDays(from, e.target.value)} aria-label="To" />
              </span>
            </div>
          </div>
          <div className="log-filter pi-filter">
            <div role="radiogroup" aria-label="Which service" className="log-filter">
              {SERVICES.map((s) => (
                <button key={s.label} role="radio" aria-checked={service === s.key} data-service={s.key ?? undefined} onClick={() => setService(s.key)}>
                  {s.key && <span className="pi-dot" aria-hidden />}
                  {s.label}
                </button>
              ))}
            </div>
            <button className="pi-problems" aria-pressed={problems} onClick={() => setProblems((p) => !p)}>
              Problems only
            </button>
          </div>
          {report && !lines.length && !more && (
            <p className="muted people-empty">
              {q
                ? `Nothing with “${q}” ${manyDays ? "on those days" : "that day"}.`
                : problems
                  ? `No problems ${manyDays ? "on those days" : "that day"}.`
                  : first && to < first
                    ? "The journal doesn't go back that far."
                    : `Nothing logged ${manyDays ? "on those days" : "that day"}.`}
            </p>
          )}
          <ol className="pi-lines">
            {lines.map((l) => (
              <li key={`${l.at}-${l.service}`} data-tone={l.tone} data-system={l.system || undefined}>
                <time dateTime={new Date(l.at / 1000).toISOString()}>
                  {manyDays && (
                    <span className="pi-line-day">
                      {new Date(l.at / 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: report?.tz })}{" "}
                    </span>
                  )}
                  {hms(l.at / 1000, report?.tz ?? "UTC")}
                </time>
                <span className="pi-service" data-service={l.service}>{l.service}</span>
                <span className="pi-message">{q ? <Marked text={l.message} q={q} /> : l.message}</span>
              </li>
            ))}
          </ol>
          {report && !lines.length && more && (
            <p className="muted people-empty">Nothing yet in the newest lines. There's more further back.</p>
          )}
          {more && (
            <button className="ghost log-more" onClick={older} disabled={fetchingOlder}>
              {fetchingOlder ? "Looking…" : lines.length ? "Older" : "Look further back"}
            </button>
          )}
        </section>
      </main>
    </div>
  );
}

/** The message with what was searched for marked, as many times as it's there. */
function Marked({ text, q }: { text: string; q: string }) {
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts = [];
  let at = 0;
  for (let i = lower.indexOf(needle); i !== -1 && needle; i = lower.indexOf(needle, at)) {
    if (i > at) parts.push(text.slice(at, i));
    parts.push(<mark key={i}>{text.slice(i, i + needle.length)}</mark>);
    at = i + needle.length;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

const RESTARTS = {
  panel: {
    label: "Restart the panel",
    question: "Restart the panel?",
    detail: "The panel client starts again and redraws. Papershow itself stays up.",
    yes: "Restart",
  },
  pi: {
    label: "Restart the Pi",
    question: "Restart the Pi?",
    detail: "Papershow and the panel go away for about a minute. This page picks up again when the Pi is back.",
    yes: "Restart the Pi",
  },
} as const;

/** ↻ for the panel, ⏻ for the Pi. */
function RestartIcon({ what }: { what: "panel" | "pi" }) {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {what === "panel" ? (
        <>
          <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.75" />
          <path d="M13.2 2.6v2.9h-2.9" />
        </>
      ) : (
        <>
          <path d="M8 2v5.5" />
          <path d="M4.6 4.2a5.2 5.2 0 1 0 6.8 0" />
        </>
      )}
    </svg>
  );
}

/** Admins: restart the panel client, or the whole Pi. Each asks once more, in the card, before it goes. */
function Restarts({ onPi }: { onPi: () => void }) {
  const [sure, setSure] = useState<"panel" | "pi" | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; bad: boolean } | null>(null);
  const go = async (what: "panel" | "pi") => {
    setBusy(true);
    setSaid(null);
    try {
      await restartPi(what);
      if (what === "pi") onPi();
      else {
        setSaid({ text: "The panel restarted. It redraws in a moment.", bad: false });
        cue("success");
      }
    } catch (err) {
      setSaid({ text: reason(err, "That didn't work"), bad: true });
      cue("error");
    } finally {
      setBusy(false);
      setSure(null);
    }
  };
  if (sure) {
    const r = RESTARTS[sure];
    return (
      <div className="pi-restarts" data-asking>
        <span className="pi-restart-icon" aria-hidden>
          <RestartIcon what={sure} />
        </span>
        <div className="pi-restart-text">
          <strong>{r.question}</strong>
          <span>{r.detail}</span>
        </div>
        <div className="pi-restart-actions">
          <button className="ghost" onClick={() => setSure(null)} disabled={busy}>
            Cancel
          </button>
          <button className="danger pi-restart-yes" onClick={() => go(sure)} disabled={busy}>
            {busy ? "Restarting…" : r.yes}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="pi-restarts">
      <div className="pi-restart-text">
        <strong>Restart</strong>
        {said ? <span data-bad={said.bad || undefined}>{said.text}</span> : <span>When the panel or the Pi is stuck.</span>}
      </div>
      <div className="pi-restart-actions">
        {(["panel", "pi"] as const).map((what) => (
          <button key={what} className="pi-restart-button" data-cuelume-open onClick={() => setSure(what)}>
            <RestartIcon what={what} />
            {RESTARTS[what].label}
          </button>
        ))}
      </div>
    </div>
  );
}

type Level = "bad" | "warn";
type Tile = { label: string; value: string; note?: string; level?: Level };

/** The worse of two levels, or none. */
const worse = (...ls: (Level | false | undefined)[]) => (ls.includes("bad") ? "bad" : ls.includes("warn") ? "warn" : undefined);

/**
 * The Pi now, a card a reading. A card that needs a look is amber; one where something's wrong is red, and says why.
 * The thresholds follow health.sh (75°C is a warning, 80°C the Pi slows down) and what keeps the panel up.
 */
function NowTiles({ report }: { report: PiReport }) {
  const { now, health } = report;
  const today = report.day === report.today;
  const temps = health.map((s) => s.tempC);
  const avg = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null;
  const hot = health.filter((s) => s.warn).length;
  const throttledNow = now.throttle.some((n) => n.endsWith("now"));
  const diskShare = now.diskFreeGb !== null && now.diskTotalGb ? now.diskFreeGb / now.diskTotalGb : null;
  const tiles: Tile[] = [
    {
      label: "Now",
      value: now.tempC !== null ? `${now.tempC.toFixed(1)}°C` : "–",
      note: now.throttle.length ? now.throttle.join(", ") : now.tempC !== null ? `slows down at ${THROTTLE_C}°C` : undefined,
      level: worse(
        (throttledNow || (now.tempC ?? 0) >= 75) && "bad",
        (now.throttle.length > 0 || (now.tempC ?? 0) >= 70) && "warn",
      ),
    },
    {
      label: today ? "Average today" : "Average that day",
      value: avg !== null ? `${avg.toFixed(1)}°C` : "–",
      note: hot
        ? `${hot} hot or throttled ${hot === 1 ? "check" : "checks"}`
        : temps.length
          ? `${Math.min(...temps).toFixed(1)}–${Math.max(...temps).toFixed(1)}°C, ${temps.length} checks`
          : "no checks",
      level: worse((avg ?? 0) >= 75 && "bad", ((avg ?? 0) >= 70 || hot > 0) && "warn"),
    },
    {
      label: "Wi-Fi",
      value: now.wifiDbm !== null ? `${now.wifiDbm} dBm` : "off",
      note: now.wifiDbm !== null ? signal(now.wifiDbm) : "on a cable?",
      level: now.wifiDbm === null ? undefined : worse(now.wifiDbm < -75 && "bad", now.wifiDbm < -67 && "warn"),
    },
    {
      label: "Memory free",
      value: now.memFreeGb !== null ? `${now.memFreeGb} GB` : "–",
      note: now.memTotalGb !== null ? `of ${now.memTotalGb} GB · load ${now.load ?? "–"}` : undefined,
      level: now.memFreeGb === null ? undefined : worse(now.memFreeGb < 0.5 && "bad", (now.memFreeGb < 1 || (now.load ?? 0) >= 4) && "warn"),
    },
    {
      label: "Disk free",
      value: now.diskFreeGb !== null ? `${now.diskFreeGb} GB` : "–",
      note: now.diskTotalGb !== null ? `of ${now.diskTotalGb} GB` : undefined,
      level: now.diskFreeGb === null ? undefined : worse((now.diskFreeGb < 1 || (diskShare ?? 1) < 0.05) && "bad", (diskShare ?? 1) < 0.1 && "warn"),
    },
    {
      label: "Up for",
      value: now.uptimeS !== null ? span(now.uptimeS) : "–",
      note: `server ${span(now.serverS)}`,
    },
    {
      label: "Panel",
      value: !now.panel ? "–" : now.panel.state === "active" ? "Running" : now.panel.state === "failed" ? "Stopped" : now.panel.state,
      note: now.panel?.since
        ? `since ${new Date(now.panel.since).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: report.tz })}`
        : now.panel && now.panel.state !== "active"
          ? "paper:logs panel says why"
          : undefined,
      level: now.panel && now.panel.state !== "active" ? (now.panel.state === "activating" ? "warn" : "bad") : undefined,
    },
    {
      label: "Version",
      value: now.version?.split(" ")[0] ?? "–",
      note: now.update
        ? now.update.ok
          ? now.update.at
            ? `checked ${new Date(now.update.at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: report.tz })}`
            : "not checked yet"
          : "last update failed"
        : undefined,
      level: now.update && !now.update.ok ? "bad" : undefined,
    },
  ];
  const flagged = tiles.filter((t) => t.level);
  const level = worse(...flagged.map((t) => t.level));
  return (
    <section className="people-section">
      <div className="section-head">
        <h2>The Pi now</h2>
        <span className="pi-verdict" data-level={level} role="status">
          <span aria-hidden>{level ? "!" : "✓"}</span>
          {level
            ? `${flagged.length === 1 ? "1 thing needs" : `${flagged.length} things need`} a look: ${flagged.map((t) => t.label).join(", ")}`
            : "All good"}
        </span>
      </div>
      <ul className="pi-tiles">
        {tiles.map((t) => (
          <li key={t.label} data-level={t.level}>
            <span className="pi-tile-label">
              {t.label}
              {t.level && <span className="pi-tile-flag">{t.level === "bad" ? "Problem" : "Check"}</span>}
            </span>
            <strong>{t.value}</strong>
            {t.note && <span className="pi-tile-note">{t.note}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

const H = 220;
const PAD = { top: 14, right: 12, bottom: 26, left: 40 };

/**
 * Where the tooltip goes: centred over the point, but never past the chart's sides, and below the point when
 * there's no room above it.
 */
function tipAt(px: number, py: number, size: { w: number; h: number }, w: number) {
  const EDGE = 8;
  const left = Math.min(Math.max(px - size.w / 2, EDGE), Math.max(w - size.w - EDGE, EDGE));
  const above = py - 14 - size.h;
  return { left, top: above >= EDGE ? above : py + 14 };
}

type Span = "day" | "week" | "month" | "year";
/** How many days each span shows, up to the chosen day; a year is 52 whole weeks. */
const SPAN_DAYS: Record<Span, number> = { day: 1, week: 7, month: 30, year: 364 };
const SPAN_LABELS: Record<Span, string> = { day: "Day", week: "7 days", month: "30 days", year: "1 year" };

type DayTemp = NonNullable<PiReport["days"]>[number];
/** A bar on the chart: a day, or a week of them in the year. */
type Bucket = { first: string; last: string; t: DayTemp | null };

/** The days' summaries as one: the coolest and hottest of them, and the average over all their checks. */
function merge(days: DayTemp[]): DayTemp | null {
  if (!days.length) return null;
  const checks = days.reduce((a, d) => a + d.checks, 0);
  return {
    day: days[0].day,
    at: days[0].at,
    avg: Math.round((days.reduce((a, d) => a + d.avg * d.checks, 0) / checks) * 10) / 10,
    min: Math.min(...days.map((d) => d.min)),
    max: Math.max(...days.map((d) => d.max)),
    checks,
    hot: days.reduce((a, d) => a + d.hot, 0),
  };
}

/**
 * The year's labels: a month's name on the week it starts in, at least `gap` weeks after the last one shown, so a
 * phone shows every other month instead of names on top of each other. A month that falls inside a week takes it.
 */
function monthMarks(buckets: Bucket[], gap: number) {
  const marks: { i: number; text: string }[] = [];
  buckets.forEach((b, i) => {
    const starts = b.first.slice(5, 7) !== b.last.slice(5, 7) || b.first.slice(8) === "01";
    if (starts && (!marks.length || i - marks.at(-1)!.i >= gap)) marks.push({ i, text: short(b.last, { month: "short" }) });
  });
  return marks;
}

const short = (d: string, opts: Intl.DateTimeFormatOptions) => {
  const [y, m, dd] = d.split("-").map(Number);
  return new Date(y, m - 1, dd).toLocaleDateString(undefined, opts);
};

/**
 * Days or weeks of temperature: each bar runs from the coolest check to the hottest, the line joins the averages.
 * 7 and 30 days show a bar a day, a year a bar a week. Hover or touch for one; click to open it (a day, or a week).
 */
function RangeChart({ report, span, onPick }: { report: PiReport; span: Exclude<Span, "day">; onPick: (day: string, span: Span) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(720);
  const [hover, setHover] = useState<number | null>(null);
  const tip = useRef<HTMLDivElement>(null);
  const [tipSize, setTipSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = tip.current;
    if (el && (el.offsetWidth !== tipSize.w || el.offsetHeight !== tipSize.h)) setTipSize({ w: el.offsetWidth, h: el.offsetHeight });
  }, [hover, w, tipSize]);

  const days = report.days ?? [];
  const byDay = new Map(days.map((d) => [d.day, d]));
  // Every day (or week) in the span has a slot, checks or not, so a gap shows as a gap.
  const per = span === "year" ? 7 : 1;
  const count = SPAN_DAYS[span] / per;
  const buckets: Bucket[] = Array.from({ length: count }, (_, i) => {
    const last = shiftDay(report.day, (i - count + 1) * per);
    const first = shiftDay(last, 1 - per);
    const inside = Array.from({ length: per }, (_, k) => byDay.get(shiftDay(first, k))).filter((d): d is DayTemp => !!d);
    return { first, last, t: merge(inside) };
  });
  const lo = Math.min(40, ...days.map((d) => Math.floor(d.min / 10) * 10));
  const hi = Math.max(THROTTLE_C + 5, ...days.map((d) => Math.ceil(d.max / 5) * 5));
  const iw = Math.max(w - PAD.left - PAD.right, 10);
  const ih = H - PAD.top - PAD.bottom;
  const slot = iw / count;
  const x = (i: number) => PAD.left + slot * (i + 0.5);
  const yy = (c: number) => PAD.top + (1 - (c - lo) / (hi - lo)) * ih;
  const ticks = [];
  for (let c = lo; c <= hi; c += 10) ticks.push(c);

  // Averages, joined; a slot without checks breaks the line.
  let path = "";
  buckets.forEach((b, i) => {
    if (b.t) path += `${path && buckets[i - 1]?.t ? "L" : "M"}${x(i).toFixed(1)},${yy(b.t.avg).toFixed(1)}`;
  });

  // Labels along the bottom: each weekday for 7 days, every week for 30, the months for a year.
  const marks =
    span === "week"
      ? buckets.map((b, i) => ({ i, text: short(b.last, { weekday: "short" }) }))
      : span === "month"
        ? [0, 7, 14, 21, 29].map((i) => ({ i, text: short(buckets[i].last, { day: "numeric", month: "short" }) }))
        : monthMarks(buckets, w < 500 ? 8 : 3);
  const what = (b: Bucket) =>
    per === 1
      ? short(b.last, { weekday: "short", day: "numeric", month: "short" })
      : `${short(b.first, { day: "numeric", month: "short" })} – ${short(b.last, { day: "numeric", month: "short" })}`;

  const pick = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const i = Math.floor((clientX - r.left - PAD.left) / slot);
    setHover(i >= 0 && i < count && buckets[i].t ? i : null);
  };
  const h = hover !== null ? buckets[hover] : null;
  if (!days.length)
    return (
      <div className="pi-chart pi-chart-empty" ref={box}>
        <p className="muted">No health checks in those days.</p>
      </div>
    );
  const all = merge(days)!;
  const bar = Math.max(Math.min(slot * 0.6, 14), 2);
  return (
    <div
      className="pi-chart pi-month"
      ref={box}
      onPointerMove={(e) => pick(e.clientX)}
      onPointerDown={(e) => pick(e.clientX)}
      onPointerLeave={() => setHover(null)}
      onClick={() => h && onPick(h.last, per === 1 ? "day" : "week")}
    >
      <svg width={w} height={H} role="img" aria-label={`Temperature over ${SPAN_LABELS[span]}: average ${all.avg.toFixed(1)}°C, hottest ${all.max}°C.`}>
        {ticks.map((c) => (
          <g key={c}>
            <line className="pi-grid" x1={PAD.left} x2={w - PAD.right} y1={yy(c)} y2={yy(c)} />
            <text className="pi-axis" x={PAD.left - 8} y={yy(c)} dy="0.32em" textAnchor="end">{`${c}°`}</text>
          </g>
        ))}
        {marks.map((m) => (
          <text key={m.i} className="pi-axis" x={x(m.i)} y={H - 8} textAnchor={m.i === 0 && span !== "week" ? "start" : m.i === count - 1 && span !== "week" ? "end" : "middle"}>
            {m.text}
          </text>
        ))}
        <line className="pi-limit" x1={PAD.left} x2={w - PAD.right} y1={yy(THROTTLE_C)} y2={yy(THROTTLE_C)} />
        <text className="pi-limit-label" x={w - PAD.right} y={yy(THROTTLE_C) - 6} textAnchor="end">
          Slows down at {THROTTLE_C}°C
        </text>
        <line className="pi-avg" x1={PAD.left} x2={w - PAD.right} y1={yy(all.avg)} y2={yy(all.avg)} />
        {hover !== null && <rect className="pi-day-hover" x={x(hover) - slot / 2} y={PAD.top} width={slot} height={ih} rx={4} />}
        {buckets.map(
          (b, i) =>
            b.t && (
              <rect
                key={b.last}
                className="pi-range-bar"
                data-hot={b.t.hot > 0 || undefined}
                x={x(i) - bar / 2}
                y={yy(b.t.max)}
                width={bar}
                height={Math.max(yy(b.t.min) - yy(b.t.max), 2)}
                rx={Math.min(bar / 2, 4)}
              />
            ),
        )}
        <path className="pi-line" d={path} />
        {count <= 60 &&
          buckets.map((b, i) => b.t && <circle key={b.last} className={hover === i ? "pi-dot" : "pi-avg-dot"} cx={x(i)} cy={yy(b.t.avg)} r={hover === i ? 5 : 2.5} />)}
        {count > 60 && h?.t && <circle className="pi-dot" cx={x(hover!)} cy={yy(h.t.avg)} r={5} />}
      </svg>
      <span className="pi-avg-label" style={{ top: yy(all.avg) - 9, left: PAD.left + 6 }}>
        avg {all.avg.toFixed(1)}°
      </span>
      {h?.t && (
        <div className="pi-tip" ref={tip} style={tipAt(x(hover!), yy(h.t.max), tipSize, w)}>
          <strong>{h.t.avg.toFixed(1)}°C</strong> on average, {what(h)}
          <span>
            {h.t.min.toFixed(1)}–{h.t.max.toFixed(1)}°C · {h.t.checks} checks
          </span>
          {h.t.hot > 0 && <span className="pi-tip-bad">{h.t.hot} hot or throttled</span>}
          <span>Click to open the {per === 1 ? "day" : "week"}</span>
        </div>
      )}
    </div>
  );
}

/** A day's temperature, midnight to midnight, against the line where the Pi slows down. Hover or touch for a check. */
function TempChart({ report, samples }: { report: PiReport; samples: PiSample[] }) {
  const { day, today, tz, dayStart: start, dayEnd: end } = report;
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(720);
  const [hover, setHover] = useState<number | null>(null);
  const now = useNow(0, 60_000);
  // The tooltip's own size, measured before it's painted, so it can stay inside the chart.
  const tip = useRef<HTMLDivElement>(null);
  const [tipSize, setTipSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = tip.current;
    if (el && (el.offsetWidth !== tipSize.w || el.offsetHeight !== tipSize.h)) setTipSize({ w: el.offsetWidth, h: el.offsetHeight });
  }, [hover, w, tipSize]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const temps = samples.map((s) => s.tempC);
  const lo = Math.min(40, ...temps.map((t) => Math.floor(t / 10) * 10));
  const hi = Math.max(THROTTLE_C + 5, ...temps.map((t) => Math.ceil(t / 5) * 5));
  const iw = Math.max(w - PAD.left - PAD.right, 10);
  const ih = H - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + ((t - start) / (end - start)) * iw;
  const yy = (c: number) => PAD.top + (1 - (c - lo) / (hi - lo)) * ih;

  // A gap longer than an hour and a half (the Pi off, or asleep with nothing logged) breaks the line.
  const path = samples
    .map((s, i) => `${i === 0 || s.at - samples[i - 1].at > 90 * 60_000 ? "M" : "L"}${x(s.at).toFixed(1)},${yy(s.tempC).toFixed(1)}`)
    .join("");

  const ticks = [];
  for (let c = lo; c <= hi; c += 10) ticks.push(c);
  // Every six hours from the Pi's midnight; the last mark is the next midnight, wherever a clock change put it.
  const marks = [0, 6, 12, 18].map((h) => start + h * 3_600_000).concat(end);
  const nowX = day === today ? x(now) : null;

  const pick = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r || !samples.length) return;
    const t = start + ((clientX - r.left - PAD.left) / iw) * (end - start);
    let best = 0;
    samples.forEach((s, i) => Math.abs(s.at - t) < Math.abs(samples[best].at - t) && (best = i));
    setHover(best);
  };
  const h = hover !== null ? samples[hover] : null;

  if (!samples.length)
    return (
      <div className="pi-chart pi-chart-empty" ref={box}>
        <p className="muted">No health checks that day.</p>
      </div>
    );

  const avg = temps.reduce((a, b) => a + b, 0) / temps.length;
  return (
    <div
      className="pi-chart"
      ref={box}
      onPointerMove={(e) => pick(e.clientX)}
      onPointerDown={(e) => pick(e.clientX)}
      onPointerLeave={() => setHover(null)}
    >
      <svg width={w} height={H} role="img" aria-label={`Temperature through the day: average ${avg.toFixed(1)}°C, lowest ${Math.min(...temps)}°C, highest ${Math.max(...temps)}°C.`}>
        {ticks.map((c) => (
          <g key={c}>
            <line className="pi-grid" x1={PAD.left} x2={w - PAD.right} y1={yy(c)} y2={yy(c)} />
            <text className="pi-axis" x={PAD.left - 8} y={yy(c)} dy="0.32em" textAnchor="end">{`${c}°`}</text>
          </g>
        ))}
        {marks.map((t, i) => (
          <text key={t} className="pi-axis" x={x(t)} y={H - 8} textAnchor={i === 0 ? "start" : i === marks.length - 1 ? "end" : "middle"}>
            {hm(t, tz)}
          </text>
        ))}
        <line className="pi-limit" x1={PAD.left} x2={w - PAD.right} y1={yy(THROTTLE_C)} y2={yy(THROTTLE_C)} />
        <text className="pi-limit-label" x={w - PAD.right} y={yy(THROTTLE_C) - 6} textAnchor="end">
          Slows down at {THROTTLE_C}°C
        </text>
        <line className="pi-avg" x1={PAD.left} x2={w - PAD.right} y1={yy(avg)} y2={yy(avg)} />
        {nowX !== null && <line className="pi-now" x1={nowX} x2={nowX} y1={PAD.top} y2={PAD.top + ih} />}
        <path className="pi-line" d={path} />
        {samples.map((s) => s.warn && <circle key={s.at} className="pi-warn" cx={x(s.at)} cy={yy(s.tempC)} r={4.5} />)}
        {h && (
          <g>
            <line className="pi-cross" x1={x(h.at)} x2={x(h.at)} y1={PAD.top} y2={PAD.top + ih} />
            <circle className="pi-dot" cx={x(h.at)} cy={yy(h.tempC)} r={5} />
          </g>
        )}
      </svg>
      <span className="pi-avg-label" style={{ top: yy(avg) - 9, left: PAD.left + 6 }}>
        avg {avg.toFixed(1)}°
      </span>
      {h && (
        <div className="pi-tip" ref={tip} style={tipAt(x(h.at), yy(h.tempC), tipSize, w)}>
          <strong>{h.tempC.toFixed(1)}°C</strong> at {hm(h.at, tz)}
          <span>
            Wi-Fi {h.wifiDbm !== null ? `${h.wifiDbm} dBm` : "off"} · load {h.load} · {h.freeGb} GB free
            {h.asleep ? " · asleep" : ""}
          </span>
          {h.notes.length > 0 && <span className="pi-tip-bad">{h.notes.join(", ")}</span>}
        </div>
      )}
    </div>
  );
}
