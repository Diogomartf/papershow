import { TokenMark } from "./marks.tsx";
import { defineApp, money, sheet, wobble } from "./types.ts";

// Mock prices until CoinGecko is wired up; ids follow CoinGecko's.
const KNOWN: Record<string, { symbol: string; usd: number }> = {
  bitcoin: { symbol: "BTC", usd: 83785 },
  ethereum: { symbol: "ETH", usd: 2538.94 },
  solana: { symbol: "SOL", usd: 111.91 },
  dogecoin: { symbol: "DOGE", usd: 0.1712 },
  cardano: { symbol: "ADA", usd: 0.6421 },
  ripple: { symbol: "XRP", usd: 2.13 },
  chainlink: { symbol: "LINK", usd: 13.87 },
  polkadot: { symbol: "DOT", usd: 4.12 },
};

const EUR_PER_USD = 0.92;

export default defineApp({
  kind: "crypto",
  name: "Crypto",
  description: "Prices for a few tokens, with their marks.",
  defaults: { tokens: ["bitcoin", "ethereum", "solana"] as string[], currency: "usd" },
  fields: [
    { key: "tokens", label: "Tokens", type: "list", placeholder: "bitcoin, ethereum, solana", hint: "CoinGecko ids, up to 4" },
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
  mock: true,
  dither: "threshold",
  data: (config, now) => {
    const t = now.getTime() / (5 * 60_000);
    return config.tokens.slice(0, 4).map((id) => {
      const known = KNOWN[id];
      const usd = (known?.usd ?? 1) * (1 + 0.03 * wobble(id, t));
      return {
        id,
        symbol: known?.symbol ?? id.slice(0, 4).toUpperCase(),
        price: config.currency === "eur" ? usd * EUR_PER_USD : usd,
      };
    });
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
              {money(token.price, config.currency.toUpperCase())}
            </span>
          </div>
        ))}
      </div>
    );
  },
});
