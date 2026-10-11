import { clockParts, defineApp, sheet } from "./types.ts";

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty"];

const words = (n: number) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : ""));

/** 21:22 → "twenty-one twenty-two", 9:05 → "nine oh five", 7:00 → "seven o'clock" */
export function timeInWords(hour: number, minute: number) {
  const h = words(hour);
  if (minute === 0) return `${h} o'clock`;
  return `${h} ${minute < 10 ? `oh ${ONES[minute]}` : words(minute)}`;
}

// Stand-ins for the model's couplets until the real call is wired up.
const COUPLETS = [
  (t: string) => `At ${t} the city flickers a neon glow, midnight breathes a silver pulse, a rhythm in quiet flow.`,
  (t: string) => `It's ${t}, the kettle starts to sing, the window holds the light of everything.`,
  (t: string) => `${cap(t)} drifts in on a paper breeze, the clock leans back and takes its ease.`,
  (t: string) => `At ${t} the shadows stretch and yawn, the minute hums, and then it's gone.`,
  (t: string) => `${cap(t)}, a pause between two beats, the street below rewinds its sheets.`,
  (t: string) => `It's ${t}, the plants lean to the light, the hours fold their maps up tight.`,
  (t: string) => `At ${t} the coffee cools to gold, a quiet story, softly told.`,
  (t: string) => `${cap(t)} and the room stands still, the dust motes dance on the windowsill.`,
];
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export default defineApp({
  kind: "aiclock",
  name: "AI Clock",
  description: "A two-line poem about the time, new every minute.",
  defaults: { timeZone: "Europe/Lisbon" },
  fields: [{ key: "timeZone", label: "Time zone", type: "text", placeholder: "Europe/Lisbon", hint: "Any IANA zone" }],
  periodMs: 60_000,
  mock: true,
  data: (config, now) => {
    const t = clockParts(now, config.timeZone);
    const hour = Number(t.hour);
    const minute = Number(t.minute);
    return { poem: COUPLETS[(hour * 60 + minute) % COUPLETS.length](timeInWords(hour, minute)) };
  },
  view: ({ data }) => {
    const size = data.poem.length <= 80 ? 66 : data.poem.length <= 120 ? 58 : 50;
    return (
      <div style={{ ...sheet, alignItems: "center", padding: "0 64px" }}>
        <div style={{ display: "flex", width: "100%", fontSize: size, fontWeight: 500, lineHeight: 1.22, letterSpacing: -1 }}>
          {data.poem}
        </div>
      </div>
    );
  },
});
