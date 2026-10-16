import { aiReady, complete, defaultModel, modelOptions } from "../ai.ts";
import { FillFrame, FillPair, Fitted, FittedPair, FittedRows, fitLine } from "./fit.tsx";
import { defineApp, sheet, type Field } from "./types.ts";

/**
 * How a reply is laid out:
 * text  — one block, sized to fit; short lines keep their own rows (a haiku)
 * lead  — the first line large, the rest smaller below (a word and its meaning)
 * quote — the first line as a large quote, the second as its author
 */
type Layout = "text" | "lead" | "quote";

/** Standard keeps the title and the quote's author. Clean is only the reply. Fill is Clean with the title in the corner. */
type Style = "standard" | "clean" | "fill";

type Preset = {
  kind: string;
  name: string;
  description: string;
  title: string;
  prompt: string;
  layout: Layout;
  refresh: Refresh;
  /** Fill, for a preset whose text should open as large as the panel allows. */
  style?: Style;
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
        style: (p.style ?? "standard") as Style,
        refresh: p.refresh as Refresh,
        model: defaultModel(),
      };
    },
    // A getter: the model list comes from Groq and changes over time.
    get fields() {
      return [
        { key: "title", label: "Title", type: "text", placeholder: p.title || "Did you know", hint: "Small line above the text. In Fill it sits in the top-right corner. Leave empty for none" },
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
            { value: "fill", label: "Fill" },
          ],
          hint: "Clean: only the reply, as big as it fits. Fill: the same, with the title small in the top-right corner. The type grows until the panel is full, and stops before it runs off.",
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
    view: ({ config, data }) => {
      if (config.style === "fill") return <Filled text={data.text} layout={config.layout} kicker={config.title} />;
      const titled = !!config.title && config.style !== "clean";
      return (
        <div style={{ ...sheet, flexDirection: "column", justifyContent: "center", padding: config.style === "clean" ? CLEAN_PAD : "0 64px" }}>
          {titled ? <Title text={config.title} /> : null}
          {config.style === "clean" ? (
            <CleanReply text={data.text} layout={config.layout} />
          ) : (
            <Reply text={data.text} layout={config.layout} height={titled ? 380 : 440} />
          )}
        </div>
      );
    },
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

const quoteOf = (rows: string[]) => ({
  quote: rows.slice(0, -1).join(" ").replace(/^["“]|["”]$/g, ""),
  author: rows.at(-1)!.replace(/^[-—–\s]+/, ""),
});

/** The title, shrunk or cut so a long one stays on one line. */
function Title({ text }: { text: string }) {
  const fit = fitLine(text, 672, 22, 14);
  return (
    <div style={{ fontSize: fit.size, fontWeight: 600, letterSpacing: 3, textTransform: "uppercase", marginBottom: 28, flexShrink: 0 }}>
      {fit.text}
    </div>
  );
}

/** Standard: the title sits above, and the reply is only as big as the room under it. */
function Reply({ text, layout, height }: { text: string; layout: Layout; height: number }) {
  const rows = lines(text);
  const width = 672;
  if (layout === "lead" && rows.length > 1) {
    const [head, ...rest] = rows;
    return <FittedPair head={head} body={rest.join(" ")} width={width} height={height} />;
  }
  if (layout === "quote" && rows.length > 1) {
    const { quote, author } = quoteOf(rows);
    const by = fitLine(author, width, 26, 16);
    return (
      <div style={{ display: "flex", flexDirection: "column", width: "100%" }}>
        <Fitted text={`“${quote}”`} width={width} height={height - 52} max={60} weight={600} font="serif" />
        <div style={{ fontSize: by.size, fontWeight: 500, marginTop: 24, flexShrink: 0 }}>{`— ${by.text}`}</div>
      </div>
    );
  }
  // Short lines (a haiku) keep a row each. A long reply shrinks, and is cut if it still can't fit.
  if (rows.length > 1) return <FittedRows rows={rows} width={width} height={height} max={64} weight={500} />;
  return <Fitted text={rows.join(" ")} width={width} height={height} max={80} weight={500} />;
}

/** Fill puts the title in the corner and gives the reply the whole panel. A quote's corner is its author. */
function Filled({ text, layout, kicker }: { text: string; layout: Layout; kicker?: string }) {
  const rows = lines(text);
  if (layout === "lead" && rows.length > 1) {
    const [head, ...rest] = rows;
    return <FillPair kicker={kicker} head={head} body={rest.join(" ")} />;
  }
  if (layout === "quote" && rows.length > 1) {
    const { quote, author } = quoteOf(rows);
    return <FillFrame kicker={author || kicker} text={`“${quote}”`} font="serif" />;
  }
  if (rows.length > 1) return <FillFrame kicker={kicker} text={rows.join("\n")} keepLines />;
  return <FillFrame kicker={kicker} text={rows.join(" ")} />;
}

// Clean's box: the whole sheet less a 32 px margin.
export const CLEAN_PAD = 32;
const W = 800 - 2 * CLEAN_PAD;
const H = 480 - 2 * CLEAN_PAD;

/** Only the reply, as big as it fits: the word and its meaning, the quote without its author, or the text. */
export function CleanReply({ text, layout }: { text: string; layout: Layout }) {
  const rows = lines(text);
  if (layout === "lead" && rows.length > 1) {
    const [head, ...rest] = rows;
    return <FittedPair head={head} body={rest.join(" ")} width={W} height={H} />;
  }
  if (layout === "quote" && rows.length > 1) {
    return <Fitted text={`“${quoteOf(rows).quote}”`} width={W} height={H} max={140} weight={600} font="serif" />;
  }
  if (rows.length > 1) return <FittedRows rows={rows} width={W} height={H} max={140} weight={500} />;
  return <Fitted text={rows.join(" ")} width={W} height={H} max={140} weight={500} />;
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
  title: "Did you know",
  prompt:
    "Tell me one surprising, true fact about science, history or nature, in a single short sentence under 90 characters. " + ONE_LINE,
  layout: "text",
  refresh: "hour",
  style: "fill",
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
