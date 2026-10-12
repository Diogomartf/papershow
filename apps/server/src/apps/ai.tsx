import { aiReady, complete, defaultModel, modelOptions } from "../ai.ts";
import { defineApp, sheet, type Field } from "./types.ts";

/**
 * How a reply is laid out:
 * text  — one block, sized to fit
 * lines — each line on its own row, centred (a haiku)
 * lead  — the first line large, the rest smaller below (a word and its meaning)
 * quote — the first line as a large quote, the second as its author
 */
type Layout = "text" | "lines" | "lead" | "quote";

type Preset = {
  kind: string;
  name: string;
  description: string;
  title: string;
  prompt: string;
  layout: Layout;
  refresh: Refresh;
  /** Shown without GROQ_API_KEY, so the layout can still be seen. */
  sample: string;
};

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const REFRESH = { "15m": 15 * 60_000, hour: HOUR, day: DAY } as const;
type Refresh = keyof typeof REFRESH;

// The last answer per app kind, model and prompt, so a failed call keeps the old text up instead of failing.
const last = new Map<string, string>();

/** An app that shows a model's reply to a prompt. Every preset keeps its prompt editable. */
function promptApp(p: Preset) {
  return defineApp({
    kind: p.kind,
    name: p.name,
    category: "ai",
    source: "Groq",
    description: p.description,
    get defaults() {
      return { title: p.title, prompt: p.prompt, layout: p.layout as Layout, refresh: p.refresh as Refresh, model: defaultModel() };
    },
    // A getter: the model list comes from Groq and changes over time.
    get fields() {
      return [
        { key: "title", label: "Title", type: "text", placeholder: p.title || "Did you know", hint: "Small line above the text; leave empty for none" },
        { key: "prompt", label: "Prompt", type: "textarea", placeholder: p.prompt, hint: "{date} and {time} become today's date and the time" },
        {
          key: "layout",
          label: "Layout",
          type: "select",
          options: [
            { value: "text", label: "Text" },
            { value: "lines", label: "Lines" },
            { value: "lead", label: "Word + meaning" },
            { value: "quote", label: "Quote" },
          ],
          hint: "Lines: one row per line. Word + meaning and Quote: line 1 large, the rest below.",
        },
        {
          key: "refresh",
          label: "New text",
          type: "select",
          options: [
            { value: "15m", label: "Every 15 min" },
            { value: "hour", label: "Every hour" },
            { value: "day", label: "Every day" },
          ],
        },
        { key: "model", label: "Model", type: "select", options: modelOptions() },
      ] satisfies Field[];
    },
    periodMs: REFRESH[p.refresh],
    periodFor: (config) => REFRESH[config.refresh] ?? REFRESH[p.refresh],
    get mock() {
      return !aiReady();
    },
    data: async (config, now) => {
      const prompt = withNow(config.prompt || p.prompt, now);
      if (!aiReady()) return { text: p.sample };
      const key = `${p.kind}\n${config.model}\n${prompt}`;
      try {
        const text = await complete(prompt, now, config.model);
        last.set(key, text);
        return { text };
      } catch (err) {
        const old = last.get(key);
        if (old) return { text: old };
        throw err;
      }
    },
    view: ({ config, data }) => (
      <div style={{ ...sheet, flexDirection: "column", justifyContent: "center", padding: "0 64px" }}>
        {config.title ? (
          <div
            style={{
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: 3,
              textTransform: "uppercase",
              marginBottom: 28,
              alignSelf: config.layout === "lines" ? "center" : "flex-start",
            }}
          >
            {config.title}
          </div>
        ) : null}
        <Reply text={data.text} layout={config.layout} />
      </div>
    ),
  });
}

/** `{date}` and `{time}` in a prompt become the moment it's asked for, in the server's time zone. */
const withNow = (prompt: string, now: Date) =>
  prompt
    .replaceAll("{date}", now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }))
    .replaceAll("{time}", now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }));

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** Fits the text: shorter replies get bigger type. */
const fit = (n: number, sizes: [number, number, number, number]) =>
  n <= 60 ? sizes[0] : n <= 110 ? sizes[1] : n <= 170 ? sizes[2] : sizes[3];

function Reply({ text, layout }: { text: string; layout: Layout }) {
  const rows = lines(text);
  if (layout === "lines") {
    // Each line keeps to one row: size by the longest (Inter averages about half an em per character).
    const size = Math.min(56, Math.floor(672 / (Math.max(...rows.map((r) => r.length)) * 0.52)));
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: size * 0.35 }}>
        {rows.map((r, i) => (
          <span key={i} style={{ fontSize: size, fontWeight: 400, letterSpacing: -0.5, textAlign: "center" }}>{r}</span>
        ))}
      </div>
    );
  }
  if (layout === "lead" && rows.length > 1) {
    const [head, ...rest] = rows;
    return (
      <div style={{ display: "flex", flexDirection: "column" }}>
        <span style={{ fontSize: head.length <= 14 ? 104 : head.length <= 22 ? 80 : 60, fontWeight: 600, letterSpacing: -3, lineHeight: 1 }}>
          {head}
        </span>
        <span style={{ fontSize: fit(rest.join(" ").length, [40, 34, 30, 26]), fontWeight: 400, lineHeight: 1.3, marginTop: 24 }}>
          {rest.join(" ")}
        </span>
      </div>
    );
  }
  if (layout === "quote" && rows.length > 1) {
    const quote = rows.slice(0, -1).join(" ").replace(/^["“]|["”]$/g, "");
    const author = rows.at(-1)!.replace(/^[-—–\s]+/, "");
    return (
      <div style={{ display: "flex", flexDirection: "column" }}>
        <span style={{ fontFamily: "Source Serif", fontSize: fit(quote.length, [60, 50, 42, 34]), fontWeight: 600, lineHeight: 1.2 }}>
          {`“${quote}”`}
        </span>
        <span style={{ fontSize: 26, fontWeight: 500, marginTop: 24 }}>{`— ${author}`}</span>
      </div>
    );
  }
  const flat = rows.join(" ");
  return (
    <div style={{ display: "flex", fontSize: fit(flat.length, [68, 56, 46, 38]), fontWeight: 500, lineHeight: 1.2, letterSpacing: -1 }}>
      {flat}
    </div>
  );
}

const ONE_LINE = "Reply with that only: no preamble, no quotes, no markdown.";

/** Write any prompt. */
export default promptApp({
  kind: "ai",
  name: "Custom AI",
  description: "Anything you can ask for in a prompt, from a model on Groq. New every hour.",
  title: "Did you know",
  prompt: "Give me one surprising fact about nature, in a single sentence under 140 characters. " + ONE_LINE,
  layout: "text",
  refresh: "hour",
  sample: "Octopuses have three hearts, and two of them stop beating when they swim.",
});

export const wordOfTheDay = promptApp({
  kind: "ai-word",
  name: "Word of the day",
  description: "An uncommon English word and what it means. New every day.",
  title: "Word of the day",
  prompt:
    "Pick one uncommon but useful English word. Line 1: the word, lowercase. Line 2: its meaning in under 90 characters. " + ONE_LINE,
  layout: "lead",
  refresh: "day",
  sample: "petrichor\nThe earthy smell that rises when rain falls on dry ground.",
});

export const funFact = promptApp({
  kind: "ai-fact",
  name: "Fun fact",
  description: "A surprising fact about science, history or nature. New every hour.",
  title: "Did you know",
  prompt:
    "Tell me one surprising, true fact about science, history or nature, in a single sentence under 140 characters. " + ONE_LINE,
  layout: "text",
  refresh: "hour",
  sample: "Honey never spoils: pots of it found in ancient Egyptian tombs were still good to eat.",
});

export const haiku = promptApp({
  kind: "ai-haiku",
  name: "Haiku",
  description: "A three-line haiku about the season and the time of day. New every hour.",
  title: "",
  prompt: "It is {time} on {date}. Write a haiku about this season and this time of day. Three lines, one per line, 5-7-5 syllables. " + ONE_LINE,
  layout: "lines",
  refresh: "hour",
  sample: "Autumn light at noon\nleaves drift past the paper screen\nslowly, then all gone",
});

export const quoteOfTheDay = promptApp({
  kind: "ai-quote",
  name: "Quote of the day",
  description: "A real quote worth reading twice, with who said it. New every day.",
  title: "",
  prompt:
    "Give me one real, well-attributed quote under 120 characters that is thoughtful but not a cliché. Line 1: the quote. Line 2: who said it. " +
    ONE_LINE,
  layout: "quote",
  refresh: "day",
  sample: "The best way out is always through.\nRobert Frost",
});
