import { aiReady, complete, defaultModel, modelOptions } from "../ai.ts";
import { CleanReply, CLEAN_PAD } from "./ai.tsx";
import { FillFrame, FittedRows } from "./fit.tsx";
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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long a poem stays up. "15m", "hour" and "1h" from earlier settings still read; a unit in the number wins. */
function every(n: string, unit: string) {
  const m = n.trim().match(/^(\d+)?\s*(m|min|h|hours?)?$/i);
  const count = Math.max(1, Number(m?.[1] ?? 1) || 1);
  return /^h/i.test(m?.[2] ?? "") || (!m?.[2] && unit === "hours") ? { ms: Math.min(count, 24) * HOUR, span: DAY } : { ms: Math.min(count, 60) * MINUTE, span: HOUR };
}

/** "08:30" → 510, "59" or ":59" → 59: minutes after the hour (or midnight, for hours). */
function startAt(text: string) {
  const m = text.trim().match(/^(?:(\d{1,2})?:)?(\d{1,2})$/);
  if (!m) return 0;
  return (Number(m[1] ?? 0) % 24) * 60 + (Number(m[2]) % 60);
}

/** The time zone's offset from UTC at `now`, in ms. */
function offset(now: number, timeZone: string) {
  const zone = isZone(timeZone) ? timeZone : undefined;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(now)
      .map((x) => [x.type, Number(x.value)]),
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(now / 1000) * 1000;
}

/**
 * The poem's slot: every N minutes from a minute of each hour, or every N hours from a time of each day, on the
 * clock's time zone. Each hour (or day) starts over at that minute (or time), so 7 minutes from :00 runs :00 … :56,
 * then :00 again, and the last slot is the short one.
 */
function slot(config: { every: string; unit: string; start: string; timeZone: string }, now: number) {
  const { ms, span } = every(config.every, config.unit);
  const shift = offset(now, config.timeZone);
  const wall = now + shift;
  const at = startAt(config.start) * MINUTE;
  // Minutes start over each hour, so only the minute of the start counts.
  let anchor = Math.floor(wall / span) * span + (span === HOUR ? at % HOUR : at);
  if (anchor > wall) anchor -= span;
  const start = anchor + Math.floor((wall - anchor) / ms) * ms;
  return { start: start - shift, end: Math.min(start + ms, anchor + span) - shift };
}

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
    return {
      timeZone: "Europe/Lisbon",
      prompt: PROMPT,
      every: "1",
      unit: "minutes" as "minutes" | "hours",
      start: "00",
      size: "standard" as "standard" | "large" | "fill",
      model: defaultModel(),
    };
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
      { key: "every", label: "New poem every", type: "text", placeholder: "1", hint: "A number: up to 60 minutes, or 24 hours" },
      {
        key: "unit",
        label: "Unit",
        type: "select",
        options: [
          { value: "minutes", label: "Minutes" },
          { value: "hours", label: "Hours" },
        ],
      },
      {
        key: "start",
        label: "Starting at",
        type: "text",
        placeholder: "00",
        hint: "Minutes: the minute of each hour to start on, like 00, 12 or 59. Hours: the time of day, like 08:30.",
      },
      {
        key: "size",
        label: "Size",
        type: "select",
        options: [
          { value: "standard", label: "Standard" },
          { value: "large", label: "Large" },
          { value: "fill", label: "Fill" },
        ],
        hint: "Large: the poem as big as it fits, and the default prompt asks for a shorter one. Fill: the same, with the time small in the corner.",
      },
      { key: "model", label: "Model", type: "select", options: modelOptions() },
    ] satisfies Field[];
  },
  periodMs: 60_000,
  slotFor: slot,
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
  view: ({ config, data, now }) => {
    const poem = data.poem.split("\n").map((l) => l.trim()).filter(Boolean);
    if (config.size === "fill") {
      const t = clockParts(now, config.timeZone);
      return <FillFrame kicker={`${t.hour}:${t.minute}`} text={poem.join("\n")} keepLines={poem.length > 1} />;
    }
    if (config.size === "large")
      return (
        <div style={{ ...sheet, flexDirection: "column", justifyContent: "center", padding: CLEAN_PAD }}>
          <CleanReply text={data.poem} layout="text" />
        </div>
      );
    return (
      <div style={{ ...sheet, flexDirection: "column", justifyContent: "center", padding: "0 64px" }}>
        <FittedRows rows={poem.length ? poem : [data.poem]} width={672} height={420} max={66} weight={500} />
      </div>
    );
  },
});
