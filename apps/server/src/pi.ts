// How the Pi is doing, for the Pi page: what it reads now, the health check's samples for a day, and the
// services' own log lines for that day, a page at a time. Everything comes from the Pi itself (/proc, /sys,
// vcgencmd) and its journal, which papershow-health.timer writes to every 15 minutes (deploy/pi/health.sh).
// Off a Pi (pnpm dev on a Mac) there's no journal, so the page gets stand-in readings, marked as a sample.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, statfs } from "node:fs/promises";
import { dirname } from "node:path";

/** One health check: the line health.sh logs, taken apart. */
export type Sample = {
  at: number;
  tempC: number;
  /** Wi-Fi signal in dBm; null when Wi-Fi is off (on a cable). */
  wifiDbm: number | null;
  load: number;
  /** Memory available, in GB. */
  freeGb: number;
  /** Throttling and under-voltage, as health.sh words them. */
  notes: string[];
  asleep: boolean;
  /** Hot or throttled: health.sh logged it as a warning. */
  warn: boolean;
};

export type Service = "server" | "panel" | "update" | "name";
/** How a line reads at a glance, as paper:logs colours it (deploy/pi/logs.py). */
export type Tone = "bad" | "warn" | "good" | "plain";

export type Line = {
  /** Microseconds since the epoch, as the journal keeps them: the page's cursor for older lines. */
  at: number;
  service: Service;
  /** systemd's own line about the service (started, stopped, failed), not the service's. */
  system: boolean;
  message: string;
  tone: Tone;
};

export type Now = {
  tempC: number | null;
  /** What vcgencmd get_throttled says, in words; empty when all's well. */
  throttle: string[];
  wifiDbm: number | null;
  load: number | null;
  memFreeGb: number | null;
  memTotalGb: number | null;
  diskFreeGb: number | null;
  diskTotalGb: number | null;
  /** Seconds since the Pi booted. */
  uptimeS: number | null;
  /** Seconds since the server started. */
  serverS: number;
  /** The panel client's service: "active", "failed", … and since when (ms). */
  panel: { state: string; since: number | null } | null;
  /** The nightly update's last run: when, and whether it worked. */
  update: { at: number | null; ok: boolean } | null;
  version: string | null;
};

export type PiReport = {
  /** Stand-in readings: this server isn't on a Pi with a journal. */
  sample: boolean;
  /** The day shown, in the Pi's time zone, and today there. */
  day: string;
  today: string;
  /** The first day the journal still has, so the page doesn't offer days it forgot. */
  firstDay: string | null;
  /** False when the journal lives in memory only, so every restart forgets the days before. */
  keepsLogs: boolean;
  now: Now;
  health: Sample[];
  lines: Line[];
  /** There are older lines on this day than these. */
  more: boolean;
};

const DAY = /^\d{4}-\d\d-\d\d$/;
const pad = (n: number) => String(n).padStart(2, "0");
/** A day in this machine's time zone, which is the Pi's. */
const dayOf = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const shiftDays = (day: string, by: number) => {
  const [y, m, d] = day.split("-").map(Number);
  return dayOf(new Date(y, m - 1, d + by).getTime());
};
const nextDay = (day: string) => shiftDays(day, 1);

/** A command's output, or null when it isn't there or fails: every reading is optional. */
function run(cmd: string, args: string[], timeout = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, SYSTEMD_COLORS: "0" } }, (err, out) =>
      resolve(err && !out ? null : String(out)),
    );
  });
}

const read = (path: string) => readFile(path, "utf8").catch(() => null);

type Entry = Record<string, unknown>;
const entries = (out: string | null): Entry[] =>
  (out ?? "")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Entry];
      } catch {
        return [];
      }
    });

/** MESSAGE as text: the journal hands back bytes that weren't valid UTF-8 as a list of numbers. */
const messageOf = (e: Entry) => {
  const m = e.MESSAGE;
  const text = Array.isArray(m) ? Buffer.from(m as number[]).toString() : String(m ?? "");
  // Escapes from the install's colours; the panel's own timestamp, since the journal's is enough.
  return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d+ /, "");
};

// ── Health samples ─────────────────────────────────────────────────────────

const HEALTH = /^([\d.]+)°C · wifi (?:(-?\d+) dBm|off) · load ([\d.]+) · ([\d.]+) GB free(.*)$/;

export function parseHealth(message: string, at: number, priority: number): Sample | null {
  const m = message.match(HEALTH);
  if (!m) return null;
  const rest = m[5].split(" · ").map((s) => s.trim()).filter(Boolean);
  return {
    at,
    tempC: Number(m[1]),
    wifiDbm: m[2] ? Number(m[2]) : null,
    load: Number(m[3]),
    freeGb: Number(m[4]),
    notes: rest.filter((s) => s !== "asleep").flatMap((s) => s.split(", ")),
    asleep: rest.includes("asleep"),
    warn: priority <= 4,
  };
}

async function healthFor(day: string): Promise<Sample[]> {
  const out = await run("journalctl", [
    "_SYSTEMD_UNIT=papershow-health.service",
    "--since", `${day} 00:00:00`,
    "--until", `${nextDay(day)} 00:00:00`,
    "-o", "json", "--output-fields=MESSAGE,PRIORITY", "--no-pager",
  ]);
  return entries(out).flatMap((e) => {
    const s = parseHealth(messageOf(e), Number(e.__REALTIME_TIMESTAMP) / 1000, Number(e.PRIORITY ?? 6));
    return s ? [s] : [];
  });
}

// ── Log lines ──────────────────────────────────────────────────────────────

const UNITS: Record<string, Service> = {
  "papershow.service": "server",
  "papershow-panel.service": "panel",
  "papershow-update.service": "update",
  "papershow-name.service": "name",
};
// The same words paper:logs colours (deploy/pi/logs.py), so a line reads the same in both.
const BAD = /error|fail|traceback|exception|unreachable|refused|rejected|denied|EADDRINUSE|fatal/i;
const WARN = /warn|retrying|stand-in|unexpected|timed? ?out|skipp/i;
const GOOD = /^(drew|cleaned|server on|also on|following|up to date)|ready to use|updated!|installed!/i;
// systemd's bookkeeping after every run, which says nothing about how it went.
const NOISE = /^(Deactivated successfully|Consumed .* CPU time|.*: Consumed )/;

const toneOf = (message: string, priority: number): Tone =>
  priority <= 3 || BAD.test(message) ? "bad" : priority === 4 || WARN.test(message) ? "warn" : GOOD.test(message) ? "good" : "plain";

/** One read of the journal: plenty for a page, even of a day the clock app drew every minute of. */
const BATCH = 3000;

export type LineOpts = {
  /** The days to read, first and last, both included. */
  from: string;
  to: string;
  before?: number;
  service?: Service;
  problems?: boolean;
  /** Words to look for, in any case. */
  q?: string;
  limit: number;
};

/** A search as the journal's --grep takes it: the words as they are, case ignored, no pattern characters. */
const escapeGrep = (q: string) => q.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

async function linesFor(opts: LineOpts) {
  const until = opts.before ? `@${Math.ceil(opts.before / 1e6)}` : `${nextDay(opts.to)} 00:00:00`;
  const units = opts.service
    ? Object.keys(UNITS).filter((u) => UNITS[u] === opts.service)
    : Object.keys(UNITS);
  const out = await run("journalctl", [
    ...units.flatMap((u) => ["-u", u]),
    "--since", `${opts.from} 00:00:00`,
    "--until", until,
    ...(opts.q ? ["--grep", escapeGrep(opts.q), "--case-sensitive=false"] : []),
    "-r", "-n", String(BATCH),
    "-o", "json", "--output-fields=MESSAGE,PRIORITY,_SYSTEMD_UNIT,UNIT,_PID", "--no-pager",
  ], 15_000);
  const raw = entries(out);
  const lines: Line[] = [];
  for (const e of raw) {
    const at = Number(e.__REALTIME_TIMESTAMP);
    if (opts.before && at >= opts.before) continue;
    const own = UNITS[String(e._SYSTEMD_UNIT ?? "")];
    const service = own ?? UNITS[String(e.UNIT ?? "")];
    if (!service) continue;
    const message = messageOf(e);
    if (!message.trim() || (!own && NOISE.test(message))) continue;
    const tone = toneOf(message, Number(e.PRIORITY ?? 6));
    if (opts.problems && tone !== "bad" && tone !== "warn") continue;
    lines.push({ at, service, system: !own, message, tone });
  }
  return { lines: lines.slice(0, opts.limit), more: lines.length > opts.limit || raw.length === BATCH };
}

// ── Now ────────────────────────────────────────────────────────────────────

/** vcgencmd get_throttled's flags, in the words health.sh uses: the low bits are now, the same << 16 since boot. */
export function throttleNotes(flags: number): string[] {
  const notes: string[] = [];
  if (flags & 0x1) notes.push("under-voltage now");
  if (flags & 0x4) notes.push("throttled now");
  if (flags & 0x10000 && !(flags & 0x1)) notes.push("under-voltage since boot");
  if (flags & 0x40000 && !(flags & 0x4)) notes.push("throttled since boot");
  return notes;
}

let versionAt = 0;
let version: string | null = null;
/** paper:status's version (v0.4.0, or v0.4.0+3 after it), kept for ten minutes: it only changes with an update. */
async function versionNow() {
  if (Date.now() - versionAt > 10 * 60_000) {
    const script = new URL("../../../deploy/pi/paper.sh", import.meta.url).pathname;
    version = (await run("bash", [script, "version"]))?.trim() ?? null;
    versionAt = Date.now();
  }
  return version;
}

/** `systemctl show`'s Key=Value lines, as an object. */
async function unitProps(unit: string, props: string[]) {
  const out = await run("systemctl", ["show", unit, ...props.flatMap((p) => ["-p", p])]);
  if (!out) return null;
  return Object.fromEntries(out.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}
const when = (s: string | undefined) => (s && s !== "n/a" && !Number.isNaN(Date.parse(s)) ? Date.parse(s) : null);

async function readNow(): Promise<Now> {
  const [temp, throttled, wireless, loadavg, meminfo, uptime, disk, panel, update, v] = await Promise.all([
    read("/sys/class/thermal/thermal_zone0/temp"),
    run("vcgencmd", ["get_throttled"]),
    read("/proc/net/wireless"),
    read("/proc/loadavg"),
    read("/proc/meminfo"),
    read("/proc/uptime"),
    statfs(dirname(process.env.DB ?? "/")).catch(() => null),
    unitProps("papershow-panel", ["ActiveState", "ActiveEnterTimestamp"]),
    unitProps("papershow-update", ["ExecMainExitTimestamp", "Result"]),
    versionNow(),
  ]);
  const mem = (key: string) => {
    const m = meminfo?.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
    return m ? Math.round((Number(m[1]) / 1048576) * 10) / 10 : null;
  };
  const signal = wireless?.split("\n")[2]?.trim().split(/\s+/)[3];
  const gb = (n: number) => Math.round((n / 1e9) * 10) / 10;
  return {
    tempC: temp ? Math.round(Number(temp) / 100) / 10 : null,
    throttle: throttled ? throttleNotes(Number(throttled.split("=")[1])) : [],
    wifiDbm: signal ? Number(signal.replace(/\.$/, "")) : null,
    load: loadavg ? Number(loadavg.split(" ")[0]) : null,
    memFreeGb: mem("MemAvailable"),
    memTotalGb: mem("MemTotal"),
    diskFreeGb: disk ? gb(disk.bavail * disk.bsize) : null,
    diskTotalGb: disk ? gb(disk.blocks * disk.bsize) : null,
    uptimeS: uptime ? Math.round(Number(uptime.split(" ")[0])) : null,
    serverS: Math.round(process.uptime()),
    panel: panel?.ActiveState ? { state: panel.ActiveState, since: when(panel.ActiveEnterTimestamp) } : null,
    update: update?.Result ? { at: when(update.ExecMainExitTimestamp), ok: update.Result === "success" } : null,
    version: v,
  };
}

let firstAt = 0;
let firstDay: string | null = null;
/** The oldest day in the journal, from its list of boots. Kept for ten minutes. */
async function journalStart() {
  if (Date.now() - firstAt > 10 * 60_000) {
    const out = await run("journalctl", ["--list-boots", "-o", "json", "--no-pager"]);
    try {
      const boots = JSON.parse(out ?? "") as { first_entry: number }[];
      const first = Math.min(...boots.map((b) => b.first_entry));
      firstDay = Number.isFinite(first) ? dayOf(first / 1000) : null;
    } catch {
      firstDay = null;
    }
    firstAt = Date.now();
  }
  return firstDay;
}

let hasJournal: boolean | null = null;

/** The Pi page's report for `day` (today by default). `before` pages back through that day's lines. */
export async function piReport(opts: {
  day?: string;
  from?: string;
  to?: string;
  before?: number;
  service?: Service;
  problems?: boolean;
  q?: string;
  limit?: number;
}): Promise<PiReport> {
  const today = dayOf(Date.now());
  const pick = (d: string | undefined, fallback: string) => (d && DAY.test(d) && d <= today ? d : fallback);
  const day = pick(opts.day, today);
  // The logs' own range, the chart's day unless given; turned round if it came backwards.
  let [from, to] = [pick(opts.from, day), pick(opts.to, day)];
  if (from > to) [from, to] = [to, from];
  const lineOpts: LineOpts = {
    from,
    to,
    before: opts.before,
    service: opts.service,
    problems: opts.problems,
    q: opts.q?.trim().slice(0, 100) || undefined,
    limit: Math.min(Math.max(opts.limit ?? 150, 1), 500),
  };
  hasJournal ??= (await run("journalctl", ["--version"])) !== null;
  if (!hasJournal) return standIn(day, today, lineOpts);
  const [now, health, page, first] = await Promise.all([
    readNow(),
    opts.before ? Promise.resolve([]) : healthFor(day),
    linesFor(lineOpts),
    journalStart(),
  ]);
  return { sample: false, day, today, firstDay: first, keepsLogs: existsSync("/var/log/journal"), now, health, ...page };
}

// ── Stand-in, off the Pi ───────────────────────────────────────────────────

/** A seeded random: the same day gives the same numbers. */
function seeded(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  let seed = y * 400 + m * 31 + d;
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647;
}
const startOf = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
};

/** A plausible day on a bare Pi 5: warm at rest, warmer on the hour when the apps render. */
function healthSamples(day: string): Sample[] {
  const rand = seeded(day);
  const start = startOf(day);
  const end = Math.min(start + 86_400_000, Date.now());
  const health: Sample[] = [];
  for (let t = start; t < end; t += 15 * 60_000) {
    const hour = new Date(t).getHours();
    const asleep = hour < 7 || hour >= 23;
    if (asleep && new Date(t).getMinutes() !== 0) continue;
    const onHour = !asleep && new Date(t).getMinutes() === 0;
    const tempC = Math.round(((asleep ? 52 : 57) + (onHour ? 9 : 0) + rand() * 4 + Math.sin(((hour - 9) / 24) * Math.PI * 2) * 2) * 10) / 10;
    const load = Math.round((onHour ? 0.2 + rand() * 0.2 : rand() * 0.05) * 100) / 100;
    health.push({ at: t, tempC, wifiDbm: -30 - Math.round(rand() * 2), load, freeGb: 7.1, notes: [], asleep, warn: tempC >= 75 });
  }
  return health;
}

const SAID: [Service, string, Tone][] = [
  ["panel", "drew 4b1c… (partial)", "good"],
  ["server", "news: feed → 503, showing the last headlines", "warn"],
  ["panel", "drew 9e02… (full)", "good"],
  ["server", "server on http://localhost:5194", "good"],
  ["panel", "server unreachable, retrying in 30 s", "bad"],
  ["update", "Already up to date: v0.4.0", "good"],
];

/** A day's stand-in lines, newest first, a line every seven minutes. */
function sampleLines(day: string): Line[] {
  const rand = seeded(day);
  const start = startOf(day);
  const end = Math.min(start + 86_400_000, Date.now());
  const lines: Line[] = [];
  for (let t = end - 60_000; t > start; t -= 7 * 60_000) {
    const [service, message, tone] = SAID[Math.floor(rand() * SAID.length)];
    lines.push({ at: t * 1000, service, system: false, message, tone });
  }
  return lines;
}

/** Readings for working on the page off the Pi, marked as a sample. */
function standIn(day: string, today: string, opts: LineOpts): PiReport {
  const health = healthSamples(day);
  const firstDay = dayOf(Date.now() - 6 * 86_400_000);
  const days: string[] = [];
  for (let d = opts.to; d >= opts.from && d >= firstDay; d = shiftDays(d, -1)) days.push(d);
  const q = opts.q?.toLowerCase();
  const lines = days
    .flatMap(sampleLines)
    .filter(
      (l) =>
        (!opts.before || l.at < opts.before) &&
        (!opts.service || l.service === opts.service) &&
        (!opts.problems || l.tone === "bad" || l.tone === "warn") &&
        (!q || l.message.toLowerCase().includes(q)),
    );
  return {
    sample: true,
    day,
    today,
    firstDay,
    keepsLogs: true,
    now: {
      tempC: health.at(-1)?.tempC ?? 58,
      throttle: [],
      wifiDbm: -31,
      load: 0.04,
      memFreeGb: 7.1,
      memTotalGb: 7.9,
      diskFreeGb: 41.2,
      diskTotalGb: 58,
      uptimeS: 3 * 86_400 + 4 * 3600,
      serverS: Math.round(process.uptime()),
      panel: { state: "active", since: Date.now() - 3 * 86_400_000 },
      update: { at: new Date(new Date().setHours(3, 30, 0, 0)).getTime(), ok: true },
      version: "v0.4.0 (sample)",
    },
    health: opts.before ? [] : health,
    lines: lines.slice(0, opts.limit),
    more: lines.length > opts.limit,
  };
}
