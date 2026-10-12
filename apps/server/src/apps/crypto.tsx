import { TokenMark } from "./marks.tsx";
import { defineApp, money, sheet, wobble } from "./types.ts";

// Mock prices until CoinGecko is wired up; ids follow CoinGecko's.
const KNOWN: Record<string, { name: string; symbol: string; usd: number }> = {
  bitcoin: { name: "Bitcoin", symbol: "BTC", usd: 83785 },
  ethereum: { name: "Ethereum", symbol: "ETH", usd: 2538.94 },
  solana: { name: "Solana", symbol: "SOL", usd: 111.91 },
  "pudgy-penguins": { name: "Pengu", symbol: "PENGU", usd: 0.0281 },
  chainlink: { name: "Chainlink", symbol: "LINK", usd: 13.87 },
  zcash: { name: "Zcash", symbol: "ZEC", usd: 248.6 },
  hyperliquid: { name: "Hyperliquid", symbol: "HYPE", usd: 41.2 },
  uniswap: { name: "Uniswap", symbol: "UNI", usd: 7.94 },
  "jupiter-exchange-solana": { name: "Jupiter", symbol: "JUP", usd: 0.47 },
  aave: { name: "Aave", symbol: "AAVE", usd: 268.3 },
};

const EUR_PER_USD = 0.92;

export default defineApp({
  kind: "crypto",
  name: "Crypto",
  description: "Prices for a few tokens, with their marks.",
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
