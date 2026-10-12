import { aiReady, complete, defaultModel, modelOptions } from "../ai.ts";
import { defineApp, sheet, type Field } from "./types.ts";

const PROMPT = "Give me one surprising fact about nature, in a single sentence under 140 characters. Reply with the fact only.";

// The last answer per prompt, so a failed call keeps the old text up instead of failing.
const last = new Map<string, string>();

export default defineApp({
  kind: "ai",
  name: "AI",
  description: "Anything you can ask for in a prompt: a fact, a word, a short poem. New every hour, from a model on Groq.",
  get defaults() {
    return { title: "Did you know", prompt: PROMPT, model: defaultModel() };
  },
  // A getter: the model list comes from Groq and changes over time.
  get fields() {
    return [
      { key: "title", label: "Title", type: "text", placeholder: "Did you know", hint: "Small line above the text; leave empty for none" },
      { key: "prompt", label: "Prompt", type: "textarea", placeholder: PROMPT },
      { key: "model", label: "Model", type: "select", options: modelOptions() },
    ] satisfies Field[];
  },
  periodMs: 60 * 60_000,
  get mock() {
    return !aiReady();
  },
  // Without a key the panel shows the prompt itself, so you can still see the layout.
  data: async (config, now) => {
    const prompt = config.prompt || PROMPT;
    if (!aiReady()) return { text: prompt };
    try {
      const text = await complete(prompt, now, config.model);
      last.set(`${config.model}\n${prompt}`, text);
      return { text };
    } catch (err) {
      const old = last.get(`${config.model}\n${prompt}`);
      if (old) return { text: old };
      throw err;
    }
  },
  view: ({ config, data }) => {
    const n = data.text.length;
    const size = n <= 60 ? 68 : n <= 110 ? 56 : n <= 170 ? 46 : 38;
    return (
      <div style={{ ...sheet, flexDirection: "column", justifyContent: "center", padding: "0 64px" }}>
        {config.title ? (
          <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: 3, textTransform: "uppercase", marginBottom: 28 }}>
            {config.title}
          </div>
        ) : null}
        <div style={{ display: "flex", fontSize: size, fontWeight: 500, lineHeight: 1.2, letterSpacing: -1 }}>{data.text}</div>
      </div>
    );
  },
});
