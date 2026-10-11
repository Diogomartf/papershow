import { Badge, Trend } from "./marks.tsx";
import { defineApp, money, sheet, wobble } from "./types.ts";

// Mock movers until Stocks Panorama is wired up (same shape as its gainers/losers).
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

export default defineApp({
  kind: "stocks",
  name: "Stocks",
  description: "Today's biggest movers in your list.",
  defaults: { list: "gainers" },
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
  ],
  periodMs: 15 * 60_000,
  mock: true,
  data: (config, now) => {
    const t = now.getTime() / (15 * 60_000);
    return MOVERS[config.list === "losers" ? "losers" : "gainers"].map((s) => {
      const drift = 0.006 * wobble(s.ticker, t);
      return { ...s, close: s.close * (1 + drift), change: s.change + drift * 100 };
    });
  },
  view: ({ data }) => (
    <div style={{ ...sheet, flexDirection: "column", justifyContent: "center", padding: "0 44px", gap: 30 }}>
      {data.map((s) => (
        <div key={s.ticker} style={{ display: "flex", alignItems: "center", width: "100%" }}>
          <Badge text={s.ticker} size={104} />
          <div style={{ display: "flex", flexDirection: "column", marginLeft: 24, flex: 1, minWidth: 0, overflow: "hidden" }}>
            <span style={{ fontSize: 40, fontWeight: 500, letterSpacing: -0.8, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
              {s.name}
            </span>
            <span style={{ fontSize: 30, fontWeight: 400, marginTop: 4 }}>{s.ticker}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", flexShrink: 0, marginLeft: 20 }}>
            <span style={{ fontSize: 50, fontWeight: 500, letterSpacing: -1 }}>{money(s.close)}</span>
            <div style={{ display: "flex", alignItems: "center", marginTop: 4 }}>
              <Trend up={s.change >= 0} size={24} />
              <span style={{ fontSize: 34, fontWeight: 500, marginLeft: 8 }}>{`${Math.abs(s.change).toFixed(2)}%`}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  ),
});
