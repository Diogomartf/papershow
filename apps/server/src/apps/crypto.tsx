import { TokenMark } from "./marks.tsx";
import { defineApp, money, sheet } from "./types.ts";

// Tokens you can pick; ids follow CoinGecko's.
const KNOWN: Record<string, { name: string; symbol: string }> = {
  bitcoin: { name: "Bitcoin", symbol: "BTC" },
  ethereum: { name: "Ethereum", symbol: "ETH" },
  solana: { name: "Solana", symbol: "SOL" },
  "pudgy-penguins": { name: "Pengu", symbol: "PENGU" },
  chainlink: { name: "Chainlink", symbol: "LINK" },
  zcash: { name: "Zcash", symbol: "ZEC" },
  hyperliquid: { name: "Hyperliquid", symbol: "HYPE" },
  uniswap: { name: "Uniswap", symbol: "UNI" },
  "jupiter-exchange-solana": { name: "Jupiter", symbol: "JUP" },
  aave: { name: "Aave", symbol: "AAVE" },
};

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
  name: "Crypto",
  description: "Prices for a few tokens, with their marks, from CoinGecko.",
  defaults: { tokens: ["bitcoin", "ethereum", "solana"] as string[], currency: "usd" },
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
    return config.tokens.slice(0, 4).map((id) => ({
      id,
      symbol: KNOWN[id]?.symbol ?? id.slice(0, 4).toUpperCase(),
      price: all[id]?.[config.currency as "usd" | "eur"],
    }));
  },
  view: ({ config, data }) => {
    const four = data.length > 3;
    const mark = four ? 84 : 110;
    return (
      <div style={{ ...sheet, flexDirection: "column", justifyContent: "center", padding: "0 64px", gap: four ? 22 : 34 }}>
        {data.map((token) => (
          <div key={token.id} style={{ display: "flex", alignItems: "center" }}>
            <TokenMark id={token.id} symbol={token.symbol} size={mark} />
            <span style={{ marginLeft: 56, fontSize: four ? 70 : 88, fontWeight: 400, letterSpacing: -2 }}>
              {token.price === undefined ? "—" : money(token.price, config.currency.toUpperCase())}
            </span>
          </div>
        ))}
      </div>
    );
  },
});
