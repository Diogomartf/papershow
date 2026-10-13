import { aiReady, complete, defaultModel, modelOptions } from "../ai.ts";
import { CleanReply, CLEAN_PAD } from "./ai.tsx";
import { clockParts, defineApp, isZone, sheet, type Field } from "./types.ts";

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

// Stand-ins for the model's couplets: without GROQ_API_KEY, or when a call fails.
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

/** How often a new poem is written; each one is about the time its turn starts. */
const EVERY = { "1m": 60_000, "5m": 5 * 60_000, "15m": 15 * 60_000, "30m": 30 * 60_000, hour: 60 * 60_000 } as const;
type Every = keyof typeof EVERY;

/** "Europe/Lisbon" → "Lisbon", "America/New_York" → "New York": the place, for the prompt. */
const place = (zone: string) => (isZone(zone) ? zone : Intl.DateTimeFormat().resolvedOptions().timeZone).split("/").at(-1)!.replaceAll("_", " ");

const PROMPT =
  "Write a two-line rhyming poem about the time {time}. Say the time in words near the start. " +
  "Keep it under 120 characters, calm and a little whimsical. Reply with the poem only.";
// Large: type size is bound by how many lines the poem takes, so the default asks for a short one.
const SHORT = PROMPT.replace("under 120 characters", "under 60 characters, one short line each");

export default defineApp({
  kind: "aiclock",
  category: "clock",
  source: "Groq",
  name: "AI Clock",
  description: "A two-line poem about the time, new every minute or as often as you pick.",
  get defaults() {
    return { timeZone: "Europe/Lisbon", prompt: PROMPT, every: "1m" as Every, size: "standard" as "standard" | "large", model: defaultModel() };
  },
  // A getter: the model list comes from Groq and changes over time.
  get fields() {
    return [
      { key: "timeZone", label: "Time zone", type: "text", placeholder: "Europe/Lisbon", hint: "Any IANA zone" },
      {
        key: "prompt",
        label: "Prompt",
        type: "textarea",
        placeholder: PROMPT,
        hint: "{time} becomes the time in words, like “nine oh five”; {timezone} the place, like “Lisbon”; {date} the day, like “Monday, 13 October”",
      },
      {
        key: "every",
        label: "New poem",
        type: "select",
        options: [
          { value: "1m", label: "Every minute" },
          { value: "5m", label: "Every 5 min" },
          { value: "15m", label: "Every 15 min" },
          { value: "30m", label: "Every 30 min" },
          { value: "hour", label: "Every hour" },
        ],
      },
      {
        key: "size",
        label: "Size",
        type: "select",
        options: [
          { value: "standard", label: "Standard" },
          { value: "large", label: "Large" },
        ],
        hint: "Large: the poem as big as it fits, and the default prompt asks for a shorter one.",
      },
      { key: "model", label: "Model", type: "select", options: modelOptions() },
    ] satisfies Field[];
  },
  periodMs: 60_000,
  periodFor: (config) => EVERY[config.every] ?? 60_000,
  clipS: 60,
  get mock() {
    return !aiReady();
  },
  data: async (config, now) => {
    const t = clockParts(now, config.timeZone);
    const hour = Number(t.hour);
    const minute = Number(t.minute);
    const words = timeInWords(hour, minute);
    const stand = { poem: COUPLETS[(hour * 60 + minute) % COUPLETS.length](words) };
    if (!aiReady()) return stand;
    try {
      const ask = !config.prompt || config.prompt === PROMPT ? (config.size === "large" ? SHORT : PROMPT) : config.prompt;
      const prompt = ask
        .replaceAll("{time}", words)
        .replaceAll("{timezone}", place(config.timeZone))
        .replaceAll("{date}", t.date);
      return { poem: await complete(prompt, now, config.model) };
    } catch (err) {
      console.warn("aiclock:", (err as Error).message);
      return stand;
    }
  },
  view: ({ config, data }) => {
    if (config.size === "large")
      return (
        <div style={{ ...sheet, flexDirection: "column", justifyContent: "center", padding: CLEAN_PAD }}>
          <CleanReply text={data.poem} layout="text" />
        </div>
      );
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
