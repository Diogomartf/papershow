// The Pi page: how the Pi is doing now, its temperature through a day, and the services' log lines, any day the
// journal still has. Today's keeps itself up to date; the health check runs every 15 minutes.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LightSwitch } from "./LightSwitch";
import { LiveLink } from "./LiveLink";
import { MeMenu } from "./MeMenu";
import { Nav } from "./Nav";
import { useNow } from "./live";
import { getPi, type PiLine, type PiReport, type PiSample, type PiService } from "./house";

/** The Pi 5 slows itself down here; health.sh warns from 75°C. */
const THROTTLE_C = 80;
const PAGE = 150;

const SERVICES: { key: PiService | null; label: string }[] = [
  { key: null, label: "Everything" },
  { key: "server", label: "Server" },
  { key: "panel", label: "Panel" },
  { key: "update", label: "Update" },
];

const hm = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const hms = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

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
  const [paged, setPaged] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    document.title = "Pi · Papershow";
  }, []);

  // The day, the logs' days and the search in the address, so Back and a shared link land on them. Today has none.
  useEffect(() => {
    if (!report) return;
    const p = new URLSearchParams();
    if (report.day !== report.today) p.set("day", report.day);
    if (range) {
      p.set("from", range.from);
      p.set("to", range.to);
    }
    if (q) p.set("q", q);
    const url = p.size ? `/pi?${p}` : "/pi";
    if (location.pathname + location.search !== url) history.replaceState(history.state, "", url);
  }, [report, range, q]);

  const filters = useMemo(
    () => ({ service: service ?? undefined, problems: problems ? (1 as const) : undefined, q: q || undefined, from: range?.from, to: range?.to }),
    [service, problems, q, range],
  );

  // Only the newest request's answer counts: a slow one from before the last keystroke mustn't land on top of it.
  const asked = useRef(0);
  const load = useCallback(() => {
    const n = ++asked.current;
    return getPi({ day: day ?? undefined, ...filters, limit: PAGE }).then(
        (r) => {
          if (n !== asked.current) return;
          setReport(r);
          setLines(r.lines);
          setMore(r.more);
          setPaged(false);
          setFailed(false);
        },
        () => n === asked.current && setFailed(true),
      );
  }, [day, filters]);

  useEffect(() => {
    load();
  }, [load]);

  // Today's keeps coming, unless older lines are open: they'd be pulled out from under you.
  const live = !!report && report.day === report.today && (!range || range.to === report.today) && !paged;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => document.visibilityState === "visible" && load(), 30_000);
    return () => clearInterval(t);
  }, [live, load]);

  const older = async () => {
    if (!report) return;
    const n = asked.current;
    const r = await getPi({ day: report.day, ...filters, limit: PAGE, before: lines.at(-1)?.at });
    if (n !== asked.current) return;
    setLines((xs) => [...xs, ...r.lines]);
    setMore(r.more);
    setPaged(true);
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

        <section className="people-section">
          <div className="section-head">
            <h2>Temperature</h2>
            <div className="pi-day">
              <button className="ghost" onClick={() => go(shiftDay(shown, -1))} disabled={!shown || (!!first && shown <= first)} aria-label="The day before">
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
                onClick={() => go(shiftDay(shown, 1))}
                disabled={!report || shown >= report.today}
                aria-label="The day after"
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
          {report && <TempChart day={report.day} samples={report.day === shown ? report.health : []} today={report.today} />}
        </section>

        <section className="people-section">
          <h2>Logs</h2>
          <div className="pi-search-row">
            <input
              className="pi-search"
              type="search"
              placeholder="Search the logs"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              aria-label="Search the logs"
              spellCheck={false}
            />
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
                <button key={s.label} role="radio" aria-checked={service === s.key} onClick={() => setService(s.key)}>
                  {s.label}
                </button>
              ))}
            </div>
            <button className="pi-problems" aria-pressed={problems} onClick={() => setProblems((p) => !p)}>
              Problems only
            </button>
          </div>
          {report && !lines.length && (
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
                  {manyDays && <span className="pi-line-day">{new Date(l.at / 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" })} </span>}
                  {hms(l.at / 1000)}
                </time>
                <span className="pi-service">{l.service}</span>
                <span className="pi-message">{q ? <Marked text={l.message} q={q} /> : l.message}</span>
              </li>
            ))}
          </ol>
          {more && (
            <button className="ghost log-more" onClick={older}>
              Older
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

function NowTiles({ report }: { report: PiReport }) {
  const { now, health } = report;
  const today = report.day === report.today;
  const temps = health.map((s) => s.tempC);
  const avg = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null;
  const tiles: { label: string; value: string; note?: string; bad?: boolean }[] = [
    {
      label: "Now",
      value: now.tempC !== null ? `${now.tempC.toFixed(1)}°C` : "–",
      note: now.throttle.length ? now.throttle.join(", ") : now.tempC !== null ? `slows down at ${THROTTLE_C}°C` : undefined,
      bad: now.throttle.length > 0 || (now.tempC ?? 0) >= 75,
    },
    {
      label: today ? "Average today" : "Average that day",
      value: avg !== null ? `${avg.toFixed(1)}°C` : "–",
      note: temps.length ? `${Math.min(...temps).toFixed(1)}–${Math.max(...temps).toFixed(1)}°C, ${temps.length} checks` : "no checks",
    },
    { label: "Wi-Fi", value: now.wifiDbm !== null ? `${now.wifiDbm} dBm` : "off", note: now.wifiDbm !== null ? signal(now.wifiDbm) : "on a cable?", bad: (now.wifiDbm ?? 0) < -75 },
    {
      label: "Memory free",
      value: now.memFreeGb !== null ? `${now.memFreeGb} GB` : "–",
      note: now.memTotalGb !== null ? `of ${now.memTotalGb} GB · load ${now.load ?? "–"}` : undefined,
    },
    {
      label: "Disk free",
      value: now.diskFreeGb !== null ? `${now.diskFreeGb} GB` : "–",
      note: now.diskTotalGb !== null ? `of ${now.diskTotalGb} GB` : undefined,
      bad: now.diskFreeGb !== null && now.diskFreeGb < 1,
    },
    {
      label: "Up for",
      value: now.uptimeS !== null ? span(now.uptimeS) : "–",
      note: `server ${span(now.serverS)}`,
    },
    {
      label: "Panel",
      value: now.panel?.state === "active" ? "Running" : (now.panel?.state ?? "–"),
      note: now.panel?.since ? `since ${new Date(now.panel.since).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : undefined,
      bad: !!now.panel && now.panel.state !== "active",
    },
    {
      label: "Version",
      value: now.version?.split(" ")[0] ?? "–",
      note: now.update ? (now.update.ok ? `checked ${now.update.at ? hm(now.update.at) : "–"}` : "last update failed") : undefined,
      bad: !!now.update && !now.update.ok,
    },
  ];
  return (
    <section className="people-section">
      <h2>The Pi now</h2>
      <ul className="pi-tiles">
        {tiles.map((t) => (
          <li key={t.label} data-bad={t.bad || undefined}>
            <span className="pi-tile-label">{t.label}</span>
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

/** A day's temperature, midnight to midnight, against the line where the Pi slows down. Hover or touch for a check. */
function TempChart({ day, samples, today }: { day: string; samples: PiSample[]; today: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(720);
  const [hover, setHover] = useState<number | null>(null);
  const now = useNow(0, 60_000);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [y, m, d] = day.split("-").map(Number);
  const start = new Date(y, m - 1, d).getTime();
  const end = new Date(y, m - 1, d + 1).getTime();
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
  const hours = [0, 6, 12, 18, 24];
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
        {hours.map((hr) => (
          <text key={hr} className="pi-axis" x={x(start + hr * 3_600_000)} y={H - 8} textAnchor={hr === 0 ? "start" : hr === 24 ? "end" : "middle"}>
            {`${String(hr % 24).padStart(2, "0")}:00`}
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
        <div className="pi-tip" style={{ left: Math.min(Math.max(x(h.at), 90), w - 90), top: Math.max(yy(h.tempC) - 12, 0) }}>
          <strong>{h.tempC.toFixed(1)}°C</strong> at {hm(h.at)}
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
