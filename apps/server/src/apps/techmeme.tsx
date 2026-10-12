import { decode, defineApp, sheet } from "./types.ts";

type Story = { cite: string; headline: string; excerpt: string };

/** Stories from the "Top News" column of techmeme.com, in page order. Its RSS feed is newest-first instead. */
async function topNews(): Promise<Story[]> {
  const res = await fetch("https://www.techmeme.com/", { headers: { "User-Agent": "Mozilla/5.0 (Papershow)" } });
  if (!res.ok) throw new Error(`techmeme → ${res.status}`);
  const html = await res.text();
  const start = html.indexOf('ID="topcol1"');
  if (start < 0) throw new Error("techmeme: no Top News column");
  const end = html.indexOf('ID="topcol', start + 12);
  const column = html.slice(start, end < 0 ? undefined : end);
  return column
    .split(/<DIV CLASS="clus">/i)
    .slice(1)
    .map((clus) => {
      const cite = decode(clus.match(/<CITE>([\s\S]*?)<\/CITE>/i)?.[1] ?? "").replace(/:$/, "");
      const headline = decode(clus.match(/<A CLASS="ourh"[^>]*>([\s\S]*?)<\/A>/i)?.[1] ?? "");
      const excerpt = decode(clus.match(/<\/STRONG>([\s\S]*?)<\/DIV>/i)?.[1] ?? "").replace(/^—\s*/, "");
      return { cite, headline, excerpt };
    })
    .filter((s) => s.headline);
}

// The last stories that loaded, so a network blip keeps the old page up instead of failing.
let last: Story[] | null = null;

const serif = { fontFamily: "Source Serif" };

export default defineApp({
  kind: "techmeme",
  category: "news",
  source: "techmeme.com",
  name: "Techmeme",
  description: "What tech is talking about: the top story, or the first few.",
  defaults: { layout: "lead" as "lead" | "list" },
  fields: [
    {
      key: "layout",
      label: "Show",
      type: "select",
      options: [
        { value: "lead", label: "Top story" },
        { value: "list", label: "Top 3" },
      ],
    },
  ],
  periodMs: 15 * 60_000,
  mock: false,
  data: async () => {
    try {
      const stories = await topNews();
      if (!stories.length) throw new Error("techmeme: no stories");
      last = stories;
      return stories;
    } catch (err) {
      if (last) return last;
      throw err;
    }
  },
  view: ({ config, data, now }) => {
    const date = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    const lead = data[0];
    const n = lead.headline.length;
    return (
      <div style={{ ...sheet, flexDirection: "column", padding: "22px 36px 26px" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <span style={{ ...serif, fontSize: 34, fontWeight: 700, letterSpacing: -0.5 }}>Techmeme</span>
          <span style={{ fontSize: 14, fontWeight: 500 }}>{date}</span>
        </div>
        <div style={{ height: 2, flexShrink: 0, background: "#000", marginTop: 8 }} />
        {config.layout === "list" ? (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center", gap: 16 }}>
            {data.slice(0, 3).map((s, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", ...(i ? { borderTop: "1px solid #000", paddingTop: 14 } : {}) }}>
                <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: 0.5 }}>{s.cite}</span>
                <span style={{ ...serif, fontSize: s.headline.length > 120 ? 22 : 24, fontWeight: 700, lineHeight: 1.2, marginTop: 5 }}>
                  {s.headline}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center" }}>
            <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: 0.5 }}>{lead.cite}</span>
            <span style={{ ...serif, fontSize: n <= 90 ? 44 : n <= 140 ? 38 : 32, fontWeight: 700, lineHeight: 1.15, letterSpacing: -0.5, marginTop: 10 }}>
              {lead.headline}
            </span>
            {lead.excerpt ? <span style={{ ...serif, fontSize: 21, lineHeight: 1.4, marginTop: 16 }}>{lead.excerpt}</span> : null}
          </div>
        )}
      </div>
    );
  },
});
