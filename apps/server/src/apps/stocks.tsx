import { ditheredImage, isOriginal } from "../render.ts";
import { Kicker, fitLine, textWidth } from "./fit.tsx";
import { Badge, Trend } from "./marks.tsx";
import { defineApp, money, sheet, wobble } from "./types.ts";

// Stand-in movers until MASSIVE_API_KEY is set.
const MOVERS = {
  gainers: [
    { ticker: "TTD", name: "The Trade Desk, Inc.", close: 44.47, change: 1.2966 },
    { ticker: "PEP", name: "PepsiCo, Inc.", close: 141.76, change: 0.9024 },
    { ticker: "COKE", name: "Coca-Cola Consolidated, Inc.", close: 113.22, change: 0.7506 },
  ],
  losers: [
    { ticker: "ACI", name: "Albertsons Companies, Inc.", close: 17.9, change: -1.1457 },
    { ticker: "CMG", name: "Chipotle Mexican Grill, Inc.", close: 39.32, change: -1.1052 },
    { ticker: "K", name: "Kellanova Inc.", close: 77.38, change: -1.0486 },
  ],
};

type Mover = { ticker: string; name: string; close: number; change: number };

type Style = "standard" | "fill";

/** One scale for the whole list. Fill grows it until the rows, or a price, would leave the panel. */
function stockMetrics(rows: { price: string; change: string }[], fill: boolean) {
  const n = Math.max(rows.length, 1);
  const layout = (scale: number) => {
    const mark = Math.round(104 * scale);
    const name = Math.round(40 * scale);
    const ticker = Math.round(30 * scale);
    const price = Math.round(50 * scale);
    const change = Math.round(34 * scale);
    const gap = Math.round(30 * scale);
    const pad = fill ? 32 : 44;
    const priceW = Math.max(0, ...rows.map((r) => textWidth(r.price, price)));
    const changeW = Math.max(0, ...rows.map((r) => textWidth(r.change, change))) + Math.round(32 * scale);
    const nameW = 800 - pad * 2 - mark - Math.round(44 * scale) - Math.max(priceW, changeW);
    const height = n * mark + (n - 1) * gap;
    return { mark, name, ticker, price, change, gap, pad, nameW, height };
  };
  if (!fill) return layout(1);
  for (let scale = 1.4; scale >= 0.85; scale = Math.round((scale - 0.05) * 100) / 100) {
    const laid = layout(scale);
    if (laid.height <= 416 && laid.nameW >= 120) return laid;
  }
  return layout(0.85);
}

const quoted = (m: Mover) => ({ price: money(m.close), change: `${Math.abs(m.change).toFixed(2)}%` });

// Company logos from logo.dev, by ticker. They don't change: each is fetched once, then dithered once per size.
const logos = new Map<string, Promise<string | null>>();

/** A ticker's logo as a 1-bit data URL, or null to keep the drawn badge (no LOGO_DEV_TOKEN, or logo.dev has none). */
function logoOf(ticker: string, mark: number): Promise<string | null> {
  const token = process.env.LOGO_DEV_TOKEN;
  if (!token) return Promise.resolve(null);
  const key = `${ticker}@${mark}${isOriginal() ? ":original" : ""}`;
  let logo = logos.get(key);
  if (!logo) {
    // fallback=404: no made-up monogram; our own badge is the fallback.
    const url = `https://img.logo.dev/ticker/${encodeURIComponent(ticker)}?token=${token}&size=256&format=png&fallback=404`;
    logo = fetch(url, { signal: AbortSignal.timeout(10_000) }).then(
      async (res) => (res.ok ? ditheredImage(new Uint8Array(await res.arrayBuffer()), mark, mark, { radius: Math.round(mark * 0.22) }) : null),
      () => (logos.delete(key), null),
    );
    logos.set(key, logo);
  }
  return logo;
}

const withLogos = (movers: Mover[], fill: boolean) => {
  const { mark } = stockMetrics(movers.map(quoted), fill);
  return Promise.all(movers.map(async (m) => ({ ...m, logo: await logoOf(m.ticker, mark) })));
};

const MASSIVE = "https://api.massive.com";
const key = () => process.env.MASSIVE_API_KEY;

async function massive<T>(path: string): Promise<T> {
  const res = await fetch(`${MASSIVE}${path}${path.includes("?") ? "&" : "?"}apiKey=${key()}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`massive ${path.split("?")[0]} → ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.json()) as T;
}

// Company names don't change: look each ticker up once.
const names = new Map<string, Promise<string>>();
function nameOf(ticker: string) {
  let name = names.get(ticker);
  if (!name) {
    name = massive<{ results?: { name?: string } }>(`/v3/reference/tickers/${encodeURIComponent(ticker)}`).then(
      // "Veea Inc. Common Stock" → "Veea Inc."
      (r) => r.results?.name?.replace(/\s+(Class [A-Z]\s+)?(Common Stock|Ordinary Shares|Common Shares|American Depositary Shares)$/i, "") ?? ticker,
      () => (names.delete(ticker), ticker),
    );
    names.set(ticker, name);
  }
  return name;
}

type Snapshot = {
  ticker: string;
  todaysChangePerc: number;
  day?: { c?: number };
  min?: { c?: number };
  lastTrade?: { p?: number };
  prevDay?: { c?: number };
};

/** The day's top three gainers or losers across US stocks (live movers need Massive's Starter plan or above). */
async function liveMovers(direction: "gainers" | "losers"): Promise<Mover[]> {
  const { tickers = [] } = await massive<{ tickers?: Snapshot[] }>(`/v2/snapshot/locale/us/markets/stocks/${direction}`);
  return Promise.all(
    tickers.slice(0, 3).map(async (t) => ({
      ticker: t.ticker,
      name: await nameOf(t.ticker),
      // Before the open `day` is still empty; fall back to the latest trade, then yesterday's close.
      close: t.lastTrade?.p || t.min?.c || t.day?.c || t.prevDay?.c || 0,
      change: t.todaysChangePerc,
    })),
  );
}

type Bar = { T: string; c: number; v: number };

// Closing prices for every US stock on a day. Past days never change, so each is fetched once.
const days = new Map<string, Promise<Bar[]>>();
function closes(date: string) {
  let bars = days.get(date);
  if (!bars) {
    bars = massive<{ results?: Bar[] }>(`/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true`).then((r) => r.results ?? []);
    days.set(date, bars);
    bars.catch(() => days.delete(date));
  }
  return bars;
}

/** The last two trading days with closing prices, newest first, looking back from yesterday. */
async function lastTwoSessions(now: Date) {
  const found: Bar[][] = [];
  for (let back = 1; back <= 10 && found.length < 2; back++) {
    const day = new Date(now.getTime() - back * 86_400_000);
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue; // markets are shut; the free plan allows 5 calls a minute
    const bars = await closes(day.toISOString().slice(0, 10));
    if (bars.length) found.push(bars);
  }
  if (found.length < 2) throw new Error("massive: no recent closing prices");
  return found as [Bar[], Bar[]];
}

/**
 * Movers from the last session's closes against the one before: what Massive's free plan allows.
 * Only stocks over $5 that traded at least a million shares, so penny stocks don't fill the list.
 */
async function sessionMovers(direction: "gainers" | "losers", now: Date): Promise<Mover[]> {
  const [latest, before] = await lastTwoSessions(now);
  const prev = new Map(before.map((b) => [b.T, b.c]));
  const moves = latest
    .filter((b) => b.c >= 5 && b.v >= 1_000_000 && prev.get(b.T))
    .map((b) => ({ ticker: b.T, close: b.c, change: (b.c / prev.get(b.T)! - 1) * 100 }))
    .sort((a, b) => (direction === "gainers" ? b.change - a.change : a.change - b.change))
    .slice(0, 3);
  return Promise.all(moves.map(async (m) => ({ ...m, name: await nameOf(m.ticker) })));
}

// Set once Massive says the plan doesn't include live movers; from then on use closing prices.
let liveAllowed = true;

async function movers(direction: "gainers" | "losers", now: Date): Promise<Mover[]> {
  if (liveAllowed) {
    try {
      const live = await liveMovers(direction);
      if (live.length) return live;
    } catch (err) {
      if (!/→ 403/.test((err as Error).message)) throw err;
      liveAllowed = false;
    }
  }
  return sessionMovers(direction, now);
}

// The last movers that loaded per list, so a failed call keeps the old ones up instead of failing.
const last = new Map<string, Mover[]>();

export default defineApp({
  kind: "stocks",
  category: "markets",
  source: "Massive, logos from logo.dev",
  name: "Stocks",
  description: "Today's biggest movers in the US stock market, from Massive.",
  defaults: { list: "gainers", style: "standard" as Style },
  fields: [
    {
      key: "list",
      label: "Show",
      type: "select",
      options: [
        { value: "gainers", label: "Top gainers" },
        { value: "losers", label: "Top losers" },
      ],
    },
    {
      key: "style",
      label: "Style",
      type: "select",
      options: [
        { value: "standard", label: "Standard" },
        { value: "fill", label: "Fill" },
      ],
      hint: "Fill: the list as large as it can be, and still on the panel, with Gainers or Losers in the corner.",
    },
  ],
  periodMs: 15 * 60_000,
  get mock() {
    return !key();
  },
  data: async (config, now) => {
    const list = config.list === "losers" ? "losers" : "gainers";
    if (key()) {
      try {
        const found = await movers(list, now);
        if (!found.length) throw new Error("massive: no movers yet today");
        last.set(list, found);
        return withLogos(found, config.style === "fill");
      } catch (err) {
        const old = last.get(list);
        if (old) return withLogos(old, config.style === "fill");
        throw err;
      }
    }
    const t = now.getTime() / (15 * 60_000);
    return withLogos(
      MOVERS[list].map((s) => {
        const drift = 0.006 * wobble(s.ticker, t);
        return { ...s, close: s.close * (1 + drift), change: s.change + drift * 100 };
      }),
      config.style === "fill",
    );
  },
  view: ({ config, data }) => {
    const fill = config.style === "fill";
    const laid = stockMetrics(data.map(quoted), fill);
    return (
      <div style={{ ...sheet, position: "relative", flexDirection: "column", justifyContent: "center", padding: fill ? `40px ${laid.pad}px 24px` : `0 ${laid.pad}px`, gap: laid.gap }}>
        {fill ? <Kicker text={config.list === "losers" ? "Losers" : "Gainers"} /> : null}
        {data.map((s) => (
          <div key={s.ticker} style={{ display: "flex", alignItems: "center", width: "100%" }}>
            {s.logo ? <img src={s.logo} width={laid.mark} height={laid.mark} /> : <Badge text={s.ticker} size={laid.mark} />}
            <div style={{ display: "flex", flexDirection: "column", marginLeft: 24, flex: 1 }}>
              {/* 0.8: the measure runs wide on a short name, and this uses the gap before the price. */}
              <span style={{ fontSize: laid.name, fontWeight: 500, letterSpacing: -0.8 }}>
                {fitLine(s.name, Math.max(laid.nameW, 40), laid.name, laid.name, "sans", 0.8).text}
              </span>
              <span style={{ fontSize: laid.ticker, fontWeight: 400, marginTop: 4 }}>{s.ticker}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", flexShrink: 0, marginLeft: 20 }}>
              <span style={{ fontSize: laid.price, fontWeight: 500, letterSpacing: -1 }}>{money(s.close)}</span>
              <div style={{ display: "flex", alignItems: "center", marginTop: 4 }}>
                <Trend up={s.change >= 0} size={Math.round(laid.change * 0.7)} />
                <span style={{ fontSize: laid.change, fontWeight: 500, marginLeft: 8 }}>{`${Math.abs(s.change).toFixed(2)}%`}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  },
});
