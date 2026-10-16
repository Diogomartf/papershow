import { ditheredImage, isOriginal } from "../render.ts";
import { Kicker, textWidth } from "./fit.tsx";
import { TokenMark } from "./marks.tsx";
import { defineApp, money, sheet } from "./types.ts";

// Tokens you can pick; ids follow CoinGecko's. `logo` is the token's path in Trust Wallet Assets:
// <chain>/info for a chain's own coin, <chain>/assets/<address> for a token on it.
const KNOWN: Record<string, { name: string; symbol: string; logo: string }> = {
  bitcoin: { name: "Bitcoin", symbol: "BTC", logo: "bitcoin/info" },
  ethereum: { name: "Ethereum", symbol: "ETH", logo: "ethereum/info" },
  solana: { name: "Solana", symbol: "SOL", logo: "solana/info" },
  "pudgy-penguins": { name: "Pengu", symbol: "PENGU", logo: "solana/assets/2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv" },
  chainlink: { name: "Chainlink", symbol: "LINK", logo: "ethereum/assets/0x514910771AF9Ca656af840dff83E8264EcF986CA" },
  zcash: { name: "Zcash", symbol: "ZEC", logo: "zcash/info" },
  hyperliquid: { name: "Hyperliquid", symbol: "HYPE", logo: "hyperevm/info" },
  uniswap: { name: "Uniswap", symbol: "UNI", logo: "ethereum/assets/0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984" },
  "jupiter-exchange-solana": { name: "Jupiter", symbol: "JUP", logo: "solana/assets/JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" },
  aave: { name: "Aave", symbol: "AAVE", logo: "ethereum/assets/0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9" },
};

// Logos never change: each is fetched once, then dithered once per size it's drawn at.
const logoFiles = new Map<string, Promise<Uint8Array>>();
const logoMarks = new Map<string, Promise<string | null>>();

/** A token's logo as a 1-bit data URL, or null to fall back to a drawn mark. */
function logo(id: string, size: number): Promise<string | null> {
  const path = KNOWN[id]?.logo;
  if (!path) return Promise.resolve(null);
  let file = logoFiles.get(path);
  if (!file) {
    file = fetch(`https://assets-cdn.trustwallet.com/blockchains/${path}/logo.png`, { signal: AbortSignal.timeout(10_000) }).then(async (res) => {
      if (!res.ok) throw new Error(`trust wallet logo ${path} → ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    });
    logoFiles.set(path, file);
    file.catch(() => logoFiles.delete(path));
  }
  const key = `${path}@${size}${isOriginal() ? ":original" : ""}`;
  let mark = logoMarks.get(key);
  if (!mark) {
    mark = file.then((png) => ditheredImage(png, size, size, { round: true }));
    logoMarks.set(key, mark);
    mark.catch(() => logoMarks.delete(key));
  }
  return mark.catch(() => null);
}

type Style = "standard" | "fill";

/**
 * One size for every price. Standard keeps the old marks and shrinks a price that would run off.
 * Fill grows the marks and the type together until the next step would leave the panel.
 */
function cryptoMetrics(labels: string[], fill: boolean) {
  const count = Math.max(labels.length, 1);
  if (!fill) {
    const mark = count > 3 ? 84 : 110;
    const room = 800 - 128 - mark - 56;
    let size = count > 3 ? 70 : 88;
    for (const label of labels) while (size > 28 && textWidth(label, size) > room) size -= 2;
    return { size, mark, gap: count > 3 ? 22 : 34 };
  }
  for (let size = 150; size >= 32; size -= 2) {
    const mark = Math.round(size * 1.15);
    const gap = Math.round(size * 0.32);
    const room = 800 - 64 - mark - 36;
    const height = count * Math.max(mark, size) + (count - 1) * gap;
    if (height <= 416 && labels.every((label) => textWidth(label, size) <= room)) return { size, mark, gap };
  }
  return { size: 32, mark: 37, gap: 10 };
}

type Prices = Record<string, { usd?: number; eur?: number }>;

const COINGECKO_API_URL = `https://api.coingecko.com/api/v3/simple/price?ids=${Object.keys(KNOWN).join(",")}&vs_currencies=usd,eur`;

// One call for every token and both currencies, shared by all crypto apps for a minute: the free API is rate-limited.
let cached: { at: number; prices: Promise<Prices> } | null = null;
// The last prices that loaded, so a failed call keeps the old numbers up instead of failing.
let last: Prices | null = null;

function prices(): Promise<Prices> {
  if (cached && Date.now() - cached.at < 60_000) return cached.prices;
  const entry = {
    at: Date.now(),
    prices: fetch(COINGECKO_API_URL, { signal: AbortSignal.timeout(10_000) }).then(async (res) => {
      if (!res.ok) throw new Error(`coingecko → ${res.status}`);
      return (last = (await res.json()) as Prices);
    }),
  };
  cached = entry;
  entry.prices.catch(() => cached === entry && (cached = null));
  return entry.prices;
}

export default defineApp({
  kind: "crypto",
  category: "markets",
  source: "CoinGecko prices, Trust Wallet logos",
  name: "Crypto",
  description: "Prices for a few tokens, with their marks, from CoinGecko.",
  defaults: { tokens: ["bitcoin", "ethereum", "solana"] as string[], currency: "usd", style: "standard" as Style },
  fields: [
    {
      key: "tokens",
      label: "Tokens",
      type: "picks",
      options: Object.entries(KNOWN).map(([value, t]) => ({ value, label: t.name })),
      max: 4,
      hint: "Up to 4, in the order you pick them",
    },
    {
      key: "currency",
      label: "Currency",
      type: "select",
      options: [
        { value: "usd", label: "US dollar" },
        { value: "eur", label: "Euro" },
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
      hint: "Fill: the prices as large as they can be, and still on the panel, with the currency in the corner.",
    },
  ],
  periodMs: 5 * 60_000,
  mock: false,
  dither: "threshold",
  data: async (config) => {
    let all: Prices;
    try {
      all = await prices();
    } catch (err) {
      if (!last) throw err;
      all = last;
    }
    const ids = config.tokens.slice(0, 4);
    const currency = config.currency.toUpperCase();
    const labels = ids.map((id) => {
      const price = all[id]?.[config.currency as "usd" | "eur"];
      return price === undefined ? "—" : money(price, currency);
    });
    const { mark } = cryptoMetrics(labels, config.style === "fill");
    return Promise.all(
      ids.map(async (id) => ({
        id,
        symbol: KNOWN[id]?.symbol ?? id.slice(0, 4).toUpperCase(),
        price: all[id]?.[config.currency as "usd" | "eur"],
        logo: await logo(id, mark),
      })),
    );
  },
  view: ({ config, data }) => {
    const fill = config.style === "fill";
    const currency = config.currency.toUpperCase();
    const labels = data.map((token) => (token.price === undefined ? "—" : money(token.price, currency)));
    const { size, mark, gap } = cryptoMetrics(labels, fill);
    return (
      <div style={{ ...sheet, position: "relative", flexDirection: "column", justifyContent: "center", padding: fill ? "40px 32px 24px" : "0 64px", gap }}>
        {fill ? <Kicker text={currency} /> : null}
        {data.map((token, i) => (
          <div key={token.id} style={{ display: "flex", alignItems: "center" }}>
            {token.logo ? (
              <img src={token.logo} width={mark} height={mark} />
            ) : (
              <TokenMark id={token.id} symbol={token.symbol} size={mark} />
            )}
            <span style={{ marginLeft: fill ? 36 : 56, fontSize: size, fontWeight: 400, letterSpacing: -2 }}>
              {labels[i]}
            </span>
          </div>
        ))}
      </div>
    );
  },
});
