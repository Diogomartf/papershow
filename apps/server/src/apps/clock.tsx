import { clockParts, defineApp, sheet } from "./types.ts";

// Large fills the panel; the others leave room around it.
const SCALE = { small: 0.55, medium: 0.78, large: 1 } as const;

export default defineApp({
  kind: "clock",
  name: "Clock",
  description: "The time, large enough to read across the room.",
  defaults: { timeZone: "Europe/Lisbon", hour12: false, showDate: true, size: "large" as keyof typeof SCALE },
  fields: [
    { key: "timeZone", label: "Time zone", type: "text", placeholder: "Europe/Lisbon", hint: "Any IANA zone" },
    { key: "hour12", label: "12-hour", type: "toggle" },
    { key: "showDate", label: "Show date", type: "toggle" },
    {
      key: "size",
      label: "Size",
      type: "select",
      options: [
        { value: "small", label: "Small" },
        { value: "medium", label: "Medium" },
        { value: "large", label: "Large" },
      ],
    },
  ],
  periodMs: 60_000,
  clipS: 60,
  mock: false,
  data: () => null,
  view: ({ config, now }) => {
    const t = clockParts(now, config.timeZone, config.hour12);
    const k = SCALE[config.size] ?? 1;
    return (
      <div style={{ ...sheet, flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <div style={{ display: "flex", alignItems: "flex-start" }}>
          <span style={{ fontSize: 236 * k, fontWeight: 300, letterSpacing: -10 * k, lineHeight: 1 }}>
            {`${config.hour12 ? String(Number(t.hour)) : t.hour}:${t.minute}`}
          </span>
          {config.hour12 && t.period ? (
            <span style={{ fontSize: 40 * k, fontWeight: 500, marginTop: 30 * k, marginLeft: 14 * k }}>{t.period}</span>
          ) : null}
        </div>
        {config.showDate ? <div style={{ fontSize: 38 * k, fontWeight: 500, marginTop: 26 * k }}>{t.date}</div> : null}
      </div>
    );
  },
});
