// Text from a model, for the AI apps. Groq's API is OpenAI-compatible; the key lives in .env at the repo root.

/** The model apps use unless their settings pick another. */
export const defaultModel = () => process.env.GROQ_MODEL || "openai/gpt-oss-20b";

// Chat models on Groq, refreshed from its API; this short list stands in until the first load (or without a key).
let chatModels = ["openai/gpt-oss-20b", "openai/gpt-oss-120b"];

/** Options for a model picker, the default first. */
export function modelOptions() {
  const ids = [defaultModel(), ...chatModels.filter((m) => m !== defaultModel())];
  return ids.map((value) => ({ value, label: value.replace(/^[^/]+\//, "") }));
}

// Not chat models: speech, safety classifiers, agent systems.
const NOT_CHAT = /whisper|tts|guard|safeguard|playai|orpheus|compound|distil/i;

/** Fetch the current model list now and every few hours after. */
export function watchModels() {
  const load = async () => {
    if (!aiReady()) return;
    try {
      const res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        signal: AbortSignal.timeout(10_000),
      });
      check(res);
      if (!res.ok) throw new Error(`groq models → ${res.status}`);
      const { data } = (await res.json()) as { data: { id: string; active?: boolean }[] };
      const ids = data.filter((m) => m.active !== false && !NOT_CHAT.test(m.id)).map((m) => m.id).sort();
      if (ids.length) chatModels = ids;
    } catch (err) {
      console.warn("groq models:", (err as Error).message);
    }
  };
  void load();
  setInterval(load, 6 * 60 * 60_000).unref();
}

// A key Groq turned down. Changing .env means a restart, so it isn't tried again.
let rejected: string | undefined;

/** True once GROQ_API_KEY is set and Groq hasn't rejected it; until then the AI apps show stand-in text. */
export const aiReady = () => !!process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== rejected;

function check(res: Response) {
  if (res.status === 401) {
    rejected = process.env.GROQ_API_KEY;
    console.warn("groq: GROQ_API_KEY was rejected; the AI apps show stand-in text until it's fixed and the server restarts");
  }
}

// Answers per prompt and moment, so previews and the live panel share one call per period.
const answers = new Map<string, Promise<string>>();

/** The model's reply to `prompt`. `at` is the app's period start: the same prompt in the same period is asked once. */
export function complete(prompt: string, at: Date, model = defaultModel()): Promise<string> {
  const key = `${model}\n${at.getTime()}\n${prompt}`;
  let answer = answers.get(key);
  if (!answer) {
    answer = ask(prompt, model);
    answers.set(key, answer);
    answer.catch(() => answers.delete(key));
    if (answers.size > 100) answers.delete(answers.keys().next().value!);
  }
  return answer;
}

async function ask(prompt: string, model: string): Promise<string> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "Your reply is shown as-is on a small black-and-white screen. Plain text only: no markdown, no quotes around it." },
        { role: "user", content: prompt },
      ],
      reasoning_effort: "low",
      max_completion_tokens: 1024,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  check(res);
  if (!res.ok) throw new Error(`groq → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = json.choices?.[0]?.message?.content?.trim().replace(/^"(.*)"$/s, "$1");
  if (!text) throw new Error("groq: empty reply");
  return text;
}
