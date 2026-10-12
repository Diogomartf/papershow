import { defineApp, sheet } from "./types.ts";

const PROMPT = "Give me one surprising fact about nature, in a single sentence under 140 characters. Reply with the fact only.";

export default defineApp({
  kind: "ai",
  name: "AI",
  description: "Anything you can ask for in a prompt: a fact, a word, a short poem. New every hour.",
  defaults: { title: "Did you know", prompt: PROMPT },
  fields: [
    { key: "title", label: "Title", type: "text", placeholder: "Did you know", hint: "Small line above the text; leave empty for none" },
    { key: "prompt", label: "Prompt", type: "textarea", placeholder: PROMPT },
  ],
  periodMs: 60 * 60_000,
  mock: true,
  // Until a model is wired up, the panel shows the prompt itself so you can see the layout.
  data: (config) => ({ text: config.prompt || PROMPT }),
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
