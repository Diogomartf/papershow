import { clip, decode, defineApp, sheet, wrap } from "./types.ts";

type Story = { cite: string; headline: string; excerpt: string };

/** Stories from the "Top News" column of techmeme.com, in page order. Its RSS feed is newest-first instead. */
async function topNews(): Promise<Story[]> {
  const res = await fetch("https://www.techmeme.com/", { headers: { "User-Agent": "Mozilla/5.0 (Papershow)" }, signal: AbortSignal.timeout(10_000) });
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

/** The height of the text under the masthead, in panel pixels (Clean's is slimmer); the text is 728 px wide. */
const BODY_H = { poster: 360, clean: 372, classic: 360 };
const WIDTH = 728;

export default defineApp({
  kind: "techmeme",
  category: "news",
  source: "techmeme.com",
  name: "Techmeme",
  description: "What tech is talking about: the top story, or the first few.",
  defaults: { layout: "lead" as "lead" | "list", style: "poster" as keyof typeof BODY_H },
  fields: [
    {
      key: "layout",
      label: "Show",
      type: "select",
      options: [
        { value: "lead", label: "Top story" },
        { value: "list", label: "Top stories" },
      ],
    },
    {
      key: "style",
      label: "Style",
      type: "select",
      options: [
        { value: "poster", label: "Poster" },
        { value: "clean", label: "Clean" },
        { value: "classic", label: "Classic" },
      ],
      hint: "Poster reads from across the room. Clean: the same, under a smaller name with no date. Classic: more, smaller, with where each story is from.",
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
    const classic = config.style === "classic";
    const clean = config.style === "clean";
    const bodyH = BODY_H[config.style];
    const n = lead.headline.length;
    // Poster and Clean read from across the room (2–3 m). Top story: the headline as big as fits in about two thirds of the
    // page, then as much of the excerpt as fits below. Top 3: as many as fit at 32 px or more, as big as they fit.
    const size = [72, 64, 58, 52, 48, 44, 40].find((s) => wrap(lead.headline, s, WIDTH).length * s * 1.1 <= bodyH * 0.66) ?? 40;
    const EXCERPT = 28;
    const room = Math.floor((bodyH - wrap(lead.headline, size, WIDTH).length * size * 1.1 - 18) / (EXCERPT * 1.3));
    const excerpt = clip(lead.excerpt.replace(/\s*(\.\.\.|…)$/, "…"), room, EXCERPT, WIDTH);
    const fits = (list: Story[], s: number) => list.reduce((h, t) => h + wrap(t.headline, s, WIDTH).length * s * 1.15 + 32, 0) <= bodyH;
    const top = classic ? data.slice(0, 3) : [3, 2, 1].map((n) => data.slice(0, n)).find((list) => fits(list, 32)) ?? data.slice(0, 1);
    const listSize = [48, 44, 40, 36, 32].find((s) => fits(top, s)) ?? 32;
    return (
      <div style={{ ...sheet, flexDirection: "column", padding: "22px 36px 26px" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <span style={{ ...serif, fontSize: clean ? 26 : 34, fontWeight: 700, letterSpacing: -0.5 }}>Techmeme</span>
          {clean ? null : <span style={{ fontSize: 14, fontWeight: 500 }}>{date}</span>}
        </div>
        <div style={{ height: 2, flexShrink: 0, background: "#000", marginTop: 8 }} />
        {config.layout === "list" ? (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center", gap: 14, marginTop: 16 }}>
            {top.map((s, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", ...(i ? { borderTop: `${classic ? 1 : 2}px solid #000`, paddingTop: 14 } : {}) }}>
                {classic ? <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: 0.5, marginBottom: 5 }}>{s.cite}</span> : null}
                <span
                  style={{
                    ...serif,
                    fontSize: classic ? (s.headline.length > 120 ? 22 : 24) : listSize,
                    fontWeight: 700,
                    lineHeight: classic ? 1.2 : 1.15,
                    letterSpacing: classic ? 0 : -0.5,
                  }}
                >
                  {s.headline}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center", marginTop: 16 }}>
            {classic ? <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: 0.5, marginBottom: 10 }}>{lead.cite}</span> : null}
            <span
              style={{
                ...serif,
                fontSize: classic ? (n <= 90 ? 44 : n <= 140 ? 38 : 32) : size,
                fontWeight: 700,
                lineHeight: classic ? 1.15 : 1.1,
                letterSpacing: -0.5,
              }}
            >
              {lead.headline}
            </span>
            {classic && lead.excerpt ? <span style={{ ...serif, fontSize: 21, lineHeight: 1.4, marginTop: 16 }}>{lead.excerpt}</span> : null}
            {!classic && excerpt ? <span style={{ ...serif, fontSize: EXCERPT, lineHeight: 1.3, marginTop: 18 }}>{excerpt}</span> : null}
          </div>
        )}
      </div>
    );
  },
});
