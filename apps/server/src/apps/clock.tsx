import { clockParts, defineApp, sheet } from "./types.ts";

export default defineApp({
  kind: "clock",
  name: "Clock",
  description: "The time, large enough to read across the room.",
  defaults: { timeZone: "Europe/Lisbon", hour12: false, showDate: true },
  fields: [
    { key: "timeZone", label: "Time zone", type: "text", placeholder: "Europe/Lisbon", hint: "Any IANA zone" },
    { key: "hour12", label: "12-hour", type: "toggle" },
    { key: "showDate", label: "Show date", type: "toggle" },
  ],
  periodMs: 60_000,
  clipS: 60,
  mock: false,
  data: () => null,
  view: ({ config, now }) => {
    const t = clockParts(now, config.timeZone, config.hour12);
    return (
      <div style={{ ...sheet, flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <div style={{ display: "flex", alignItems: "flex-start" }}>
          <span style={{ fontSize: 236, fontWeight: 300, letterSpacing: -10, lineHeight: 1 }}>
            {`${config.hour12 ? String(Number(t.hour)) : t.hour}:${t.minute}`}
          </span>
          {config.hour12 && t.period ? (
            <span style={{ fontSize: 40, fontWeight: 500, marginTop: 30, marginLeft: 14 }}>{t.period}</span>
          ) : null}
        </div>
        {config.showDate ? <div style={{ fontSize: 38, fontWeight: 500, marginTop: 26 }}>{t.date}</div> : null}
      </div>
    );
  },
});
