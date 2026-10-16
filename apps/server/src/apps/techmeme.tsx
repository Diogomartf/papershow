import { FillFrame, fillBox, fitRows } from "./fit.tsx";
import { decode, defineApp, linesInto, sheet, wrap } from "./types.ts";

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
const BODY_H = { poster: 360, clean: 372, classic: 360, title: 372, fill: 0 };

const downFrom = (cap: number, floor = 22) => {
  const out: number[] = [];
  for (let s = cap; s >= floor; s -= 2) out.push(s);
  return out;
};

/** Lines already broken to the measure, so a long headline can't wrap again and off the panel. */
function Set({ lines, size, weight, lineHeight, tracking = 0 }: { lines: string[]; size: number; weight: number; lineHeight: number; tracking?: number }) {
  if (!lines.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", ...serif, fontWeight: weight, letterSpacing: tracking }}>
      {lines.map((line, i) => (
        <div key={i} style={{ fontSize: size, lineHeight, flexShrink: 0 }}>{line}</div>
      ))}
    </div>
  );
}
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
        { value: "title", label: "Title" },
        { value: "fill", label: "Fill" },
      ],
      hint: "Poster reads from across the room. Clean: the same, under a smaller name with no date. Classic: more, smaller, with where each story is from. Title: only the headlines, as big as they fit. Fill: the headlines as large as the panel allows, the name in the corner.",
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
    const lead = data[0];
    if (config.style === "fill") {
      const headlines = data.map((s) => s.headline);
      const box = fillBox("Techmeme");
      // As many as still read large. One that won't fit at 32px is set on its own, and cut if it must be.
      const pick = config.layout === "list"
        ? [3, 2, 1].map((n) => headlines.slice(0, n)).find((rows) => rows.length > 0 && !fitRows(rows, box, { max: 96, min: 32, font: "serif" }).clipped)
        : undefined;
      const chosen = pick ?? headlines.slice(0, 1);
      return <FillFrame kicker="Techmeme" text={chosen.join("\n")} font="serif" keepLines={chosen.length > 1} />;
    }
    const date = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    const classic = config.style === "classic";
    const title = config.style === "title";
    const clean = config.style === "clean" || title;
    const bodyH = BODY_H[config.style];
    const n = lead.headline.length;
    // Poster and Clean read from across the room (2–3 m). Top story: the headline as big as fits in about two thirds of the
    // page, then as much of the excerpt as fits below. Top stories: as many as fit, as big as they fit.
    // Title: the headline alone fills the page. A headline or excerpt that still won't fit is cut.
    const headLh = title ? 1.08 : classic ? 1.15 : 1.1;
    const cap = title ? 104 : classic ? (n <= 90 ? 44 : n <= 140 ? 38 : 32) : 72;
    const headMax = title ? bodyH - 18 : classic ? bodyH * 0.62 : bodyH * 0.66;
    const head = linesInto(lead.headline, WIDTH, headMax, downFrom(cap), headLh);
    const used = head.lines.length * head.size * headLh + 18;
    const EXCERPT = 28;
    const excerptLh = classic ? 1.4 : 1.3;
    const excerptSize = classic ? 21 : EXCERPT;
    const room = title ? 0 : Math.max(0, Math.floor((bodyH - used - (classic ? 26 : 0)) / (excerptSize * excerptLh)));
    const excerpt = room > 0 ? linesInto(lead.excerpt.replace(/\s*(\.\.\.|…)$/, "…"), WIDTH, room * excerptSize * excerptLh, [excerptSize], excerptLh).lines : [];
    const citeH = classic ? 22 : 0;
    const fits = (list: Story[], s: number) => list.reduce((h, t) => h + wrap(t.headline, s, WIDTH).length * s * 1.15 + citeH + 20, 0) <= bodyH;
    const top = classic ? data.slice(0, 3) : [3, 2, 1].map((k) => data.slice(0, k)).find((list) => fits(list, 28)) ?? data.slice(0, 1);
    const listSize = (classic ? [24] : [48, 44, 40, 36, 32, 28, 24]).find((s) => fits(top, s)) ?? 22;
    const listLh = classic ? 1.2 : 1.15;
    const share = Math.max(listSize * listLh, Math.floor((bodyH - top.length * citeH - (top.length - 1) * 20) / top.length));
    const heads = top.map((s) => linesInto(s.headline, WIDTH, share, [classic ? (s.headline.length > 120 ? 22 : 24) : listSize], listLh));
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
                <Set lines={heads[i].lines} size={heads[i].size} weight={700} lineHeight={listLh} tracking={classic ? 0 : -0.5} />
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center", marginTop: 16 }}>
            {classic ? <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: 0.5, marginBottom: 10 }}>{lead.cite}</span> : null}
            <Set lines={head.lines} size={head.size} weight={700} lineHeight={headLh} tracking={title ? -1 : -0.5} />
            {excerpt.length ? (
              <div style={{ marginTop: classic ? 16 : 18 }}>
                <Set lines={excerpt} size={excerptSize} weight={400} lineHeight={excerptLh} />
              </div>
            ) : null}
          </div>
        )}
      </div>
    );
  },
});
