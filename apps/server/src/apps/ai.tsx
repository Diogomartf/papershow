import { aiReady, complete, defaultModel, modelOptions } from "../ai.ts";
import { defineApp, sheet, type Field } from "./types.ts";

/**
 * How a reply is laid out:
 * text  — one block, sized to fit; short lines keep their own rows (a haiku)
 * lead  — the first line large, the rest smaller below (a word and its meaning)
 * quote — the first line as a large quote, the second as its author
 */
type Layout = "text" | "lead" | "quote";

/** Standard keeps the title and the quote's author; clean shows only the reply, as big as it fits. */
type Style = "standard" | "clean";

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
      return {
        title: p.title,
        prompt: p.prompt,
        layout: p.layout as Layout,
        style: "standard" as Style,
        refresh: p.refresh as Refresh,
        model: defaultModel(),
      };
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
            { value: "lead", label: "Word + meaning" },
            { value: "quote", label: "Quote" },
          ],
          hint: "Word + meaning and Quote: line 1 large, the rest below.",
        },
        {
          key: "style",
          label: "Style",
          type: "select",
          options: [
            { value: "standard", label: "Standard" },
            { value: "clean", label: "Clean" },
          ],
          hint: "Clean: only the reply, as big as it fits. No title, no author.",
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
      <div style={{ ...sheet, flexDirection: "column", justifyContent: "center", padding: config.style === "clean" ? CLEAN_PAD : "0 64px" }}>
        {config.title && config.style !== "clean" ? (
          <div
            style={{
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: 3,
              textTransform: "uppercase",
              marginBottom: 28,
            }}
          >
            {config.title}
          </div>
        ) : null}
        {config.style === "clean" ? <CleanReply text={data.text} layout={config.layout} /> : <Reply text={data.text} layout={config.layout} />}
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
  // Fill the frame: the block's area grows with characters × size², so size goes as 1/√length.
  const size = Math.min(80, Math.floor(Math.sqrt(360_000 / Math.max(flat.length, 1))));
  // Short lines (a haiku) keep a row each, unless that makes them small. Size by the longest row
  // (Inter at weight 500 averages under half an em per character) and by how many rows fit the height.
  const rowSize = Math.min(64, Math.floor(672 / (Math.max(...rows.map((r) => r.length)) * 0.47)), Math.floor(400 / (rows.length * 1.3)));
  if (rows.length > 1 && rowSize >= 36)
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: rowSize * 0.3 }}>
        {rows.map((r, i) => (
          <span key={i} style={{ fontSize: rowSize, fontWeight: 500, letterSpacing: -1 }}>{r}</span>
        ))}
      </div>
    );
  return (
    <div style={{ display: "flex", fontSize: size, fontWeight: 500, lineHeight: 1.15, letterSpacing: size > 60 ? -2 : -1 }}>
      {flat}
    </div>
  );
}

// Clean's box: the whole sheet less a 32 px margin.
export const CLEAN_PAD = 32;
const W = 800 - 2 * CLEAN_PAD;
const H = 480 - 2 * CLEAN_PAD;

/** A character's rough width in ems, after Inter's: wide m and w, narrow i, l, t and punctuation. Source Serif runs close. */
const em = (c: string) => (/[mwMW]/.test(c) ? 0.85 : /[iljtfr.,;:'’!|]/.test(c) ? 0.32 : /[A-Z“”"]/.test(c) ? 0.7 : 0.6);

/** How many lines `text` takes at `size` px in `width` px. Lines break at spaces and after hyphens, as satori does. */
function lineCount(text: string, size: number, width: number) {
  const gap = 0.3 * size;
  let n = 0;
  let line = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    word.split(/(?<=-)/).forEach((part, i) => {
      const w = [...part].reduce((sum, c) => sum + em(c), 0) * size;
      const before = i ? 0 : gap;
      if (n && line + before + w <= width) line += before + w;
      else (n++, (line = w));
      if (w > width) n = Infinity;
    });
  }
  return n;
}

/** The biggest size, from `max` down, at which `text` fits a `w` × `h` box. */
const fill = (text: string, w: number, h: number, lineHeight: number, max: number) => {
  for (let s = max; s > 24; s -= 2) if (lineCount(text, s, w) * s * lineHeight <= h) return s;
  return 24;
};

/** Only the reply, as big as it fits: the word and its meaning, the quote without its author, or the text. */
export function CleanReply({ text, layout }: { text: string; layout: Layout }) {
  const rows = lines(text);
  if (layout === "lead" && rows.length > 1) {
    const [head, ...rest] = rows;
    const meaning = rest.join(" ");
    // The word on one line across the width; the meaning fills what's left below it.
    const headSize = Math.min(150, Math.floor(W / (head.length * 0.56)));
    const size = fill(meaning, W, H - headSize - 24, 1.25, 72);
    return (
      <div style={{ display: "flex", flexDirection: "column" }}>
        <span style={{ fontSize: headSize, fontWeight: 600, letterSpacing: -headSize / 30, lineHeight: 1 }}>{head}</span>
        <span style={{ fontSize: size, fontWeight: 400, lineHeight: 1.25, marginTop: 24 }}>{meaning}</span>
      </div>
    );
  }
  if (layout === "quote" && rows.length > 1) {
    const quote = rows.slice(0, -1).join(" ").replace(/^["“]|["”]$/g, "");
    const size = fill(`“${quote}”`, W, H, 1.2, 120);
    return (
      <span style={{ fontFamily: "Source Serif", fontSize: size, fontWeight: 600, lineHeight: 1.2 }}>{`“${quote}”`}</span>
    );
  }
  // Several lines (a haiku) stay apart, a gap between them; a long one may wrap so the type can grow.
  if (rows.length > 1) {
    let rowSize = 120;
    const height = (s: number) => rows.reduce((h, r) => h + lineCount(r, s, W) * s * 1.1, 0) + (rows.length - 1) * s * 0.35;
    while (rowSize > 24 && height(rowSize) > H) rowSize -= 2;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: rowSize * 0.35 }}>
        {rows.map((r, i) => (
          <span key={i} style={{ fontSize: rowSize, fontWeight: 500, lineHeight: 1.1, letterSpacing: -rowSize / 40 }}>{r}</span>
        ))}
      </div>
    );
  }
  const flat = rows.join(" ");
  const size = fill(flat, W, H, 1.1, 140);
  return (
    <div style={{ display: "flex", fontSize: size, fontWeight: 500, lineHeight: 1.1, letterSpacing: -size / 35 }}>{flat}</div>
  );
}

const ONE_LINE = "Reply with that only: no preamble, no quotes, no markdown.";

/** Write any prompt. */
export default promptApp({
  kind: "ai",
  name: "Custom AI",
  description: "Anything you can ask for in a prompt, from a model on Groq. New every hour.",
  title: "",
  prompt: "Give me one surprising fact about nature, in a single short sentence under 90 characters. " + ONE_LINE,
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
  title: "",
  prompt:
    "Tell me one surprising, true fact about science, history or nature, in a single short sentence under 90 characters. " + ONE_LINE,
  layout: "text",
  refresh: "hour",
  sample: "Honey never spoils: pots from Egyptian tombs were still good to eat.",
});

export const haiku = promptApp({
  kind: "ai-haiku",
  name: "Haiku",
  description: "A three-line haiku about the season and the time of day. New every hour.",
  title: "",
  prompt: "It is {time} on {date}. Write a haiku about this season and this time of day. Three lines, one per line, 5-7-5 syllables. " + ONE_LINE,
  layout: "text",
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
