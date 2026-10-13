import type { JSX } from "#jsx/jsx-runtime";
import { ditheredImage } from "../render.ts";
import { clip, decode, defineApp, sheet, wrap } from "./types.ts";

/**
 * How the page is set. Poster reads from across the room (2–3 m). Clean is Poster under a smaller masthead,
 * with no date line. Classic is the denser page: the whole summary and the byline, in smaller type.
 */
type Style = "poster" | "clean" | "classic";

const STYLES = [
  { value: "poster", label: "Poster" },
  { value: "clean", label: "Clean" },
  { value: "classic", label: "Classic" },
];

/** The photo's side, in panel pixels: dithered at exactly this size. */
const PHOTO: Record<Style, number> = { poster: 280, clean: 300, classic: 330 };

/** The height of the text under the masthead, in panel pixels: Clean's slimmer masthead leaves more. */
const BODY_H: Record<Style, number> = { poster: 330, clean: 372, classic: 330 };

type Story = { title: string; summary: string; byline: string; credit: string; image: string | null };

type Paper = {
  kind: string;
  name: string;
  description: string;
  /** Where the stories come from, shown in the app's settings. */
  source: string;
  /** Section ids, their labels, and the RSS feed for each. */
  sections: { value: string; label: string; feed: string }[];
  /** The paper's name as set on its front page, scaled down for Clean. */
  masthead: (scale: number) => JSX.Element;
  /** A smaller copy of a feed's photo, when the paper's image server can make one. */
  photoUrl?: (src: string) => string;
};

const tag = (xml: string, name: string) => decode(xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? "");
const tags = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "g"))].map((m) => decode(m[1]));

/** "A", "A and B", "A, B and C" */
const names = (list: string[]) => (list.length < 2 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`);

/** The first story in a section's feed, with its photo dithered for the panel. */
async function leadStory(paper: Paper, feed: string, photo: number | null): Promise<Story> {
  const res = await fetch(feed, { headers: { "User-Agent": "Mozilla/5.0 (Papershow)" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${paper.kind} rss → ${res.status}`);
  const item = (await res.text()).match(/<item>([\s\S]*?)<\/item>/)?.[1];
  if (!item) throw new Error(`${paper.kind} rss: no stories`);
  const src = item.match(/<media:content[^>]*url="([^"]+)"/)?.[1];
  let image: string | null = null;
  if (photo && src) {
    const url = decode(src);
    const img = await fetch(paper.photoUrl?.(url) ?? url, { signal: AbortSignal.timeout(10_000) });
    if (img.ok)
      image = ditheredImage(new Uint8Array(await img.arrayBuffer()), photo, photo, { type: img.headers.get("content-type") ?? "image/jpeg" });
  }
  return { title: tag(item, "title"), summary: tag(item, "description"), byline: names(tags(item, "dc:creator")), credit: tag(item, "media:credit"), image };
}

/** A newspaper's lead story laid out like its printed front page: masthead, date line, headline, summary, photo. */
function newspaper(paper: Paper) {
  // The last story that loaded per section, so a network blip keeps the old front page up instead of failing.
  const last = new Map<string, Story>();
  const first = paper.sections[0].value;
  return defineApp({
    kind: paper.kind,
    name: paper.name,
    category: "news",
    source: paper.source,
    description: paper.description,
    defaults: { section: first, photo: true, style: "poster" as Style },
    fields: [
      { key: "section", label: "Section", type: "select", options: paper.sections.map(({ value, label }) => ({ value, label })) },
      { key: "photo", label: "Photo", type: "toggle" },
      {
        key: "style",
        label: "Style",
        type: "select",
        options: STYLES,
        hint: "Poster reads from across the room. Clean: the same, under a smaller masthead with no date. Classic: the whole summary and the byline, smaller.",
      },
    ],
    periodMs: 15 * 60_000,
    mock: false,
    // The photo arrives already dithered, so the rest (headline, rules) can threshold cleanly.
    dither: "threshold",
    data: async (config) => {
      const section = paper.sections.find((s) => s.value === config.section) ?? paper.sections[0];
      const photo = config.photo ? PHOTO[config.style] : null;
      const key = `${section.value}:${photo}`;
      try {
        const story = await leadStory(paper, section.feed, photo);
        last.set(key, story);
        return story;
      } catch (err) {
        const old = last.get(key);
        if (old) return old;
        throw err;
      }
    },
    view: ({ config, data, now }) => {
      const date = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
      const classic = config.style === "classic";
      const clean = config.style === "clean";
      const bodyH = BODY_H[config.style];
      const photo = PHOTO[config.style];
      const n = data.title.length;
      const wide = !data.image;
      // Poster and Clean: the headline as big as fits in about two thirds of the column, then as much of the summary
      // as fits under it at a size still readable from 2–3 m. Classic: sizes by headline length, all of it.
      const width = 736 - (data.image ? photo + 28 : 0);
      const size = classic
        ? wide ? (n <= 70 ? 50 : n <= 110 ? 42 : 36) : n <= 60 ? 40 : n <= 90 ? 34 : 29
        : ([72, 64, 58, 52, 48, 44, 40].find((s) => wrap(data.title, s, width).length * s * 1.1 <= bodyH * 0.66) ?? 40);
      const SUMMARY = classic ? (wide ? 22 : 18) : 28;
      const room = Math.floor((bodyH - wrap(data.title, size, width).length * size * 1.1 - 16) / (SUMMARY * 1.3));
      const summary = classic ? data.summary : clip(data.summary, room, SUMMARY, width);
      const serif = { fontFamily: "Source Serif" };
      return (
        <div style={{ ...sheet, flexDirection: "column", padding: "18px 32px 22px" }}>
          {paper.masthead(clean ? 0.72 : 1)}
          {clean ? (
            <div style={{ height: 2, flexShrink: 0, background: "#000", marginTop: 10 }} />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", marginTop: 8, gap: 2 }}>
              <div style={{ height: 1, background: "#000" }} />
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 12, fontWeight: 500 }}>
                <span>{date}</span>
                <span>{paper.sections.find((s) => s.value === config.section)?.label ?? ""}</span>
              </div>
              <div style={{ height: 2, background: "#000" }} />
              <div style={{ height: 1, background: "#000" }} />
            </div>
          )}
          <div style={{ display: "flex", flex: 1, marginTop: 18, gap: 28 }}>
            <div style={{ display: "flex", flexDirection: "column", flex: 1, ...serif }}>
              <div style={{ fontSize: size, fontWeight: 700, lineHeight: classic ? 1.12 : 1.1, letterSpacing: -0.5 }}>{data.title}</div>
              {summary ? (
                <div style={{ fontSize: SUMMARY, lineHeight: classic ? 1.4 : 1.3, marginTop: classic ? 14 : 16 }}>{summary}</div>
              ) : null}
              {classic && data.byline ? (
                <div style={{ fontFamily: "Inter", fontSize: 12, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", marginTop: 14 }}>
                  {`By ${data.byline}`}
                </div>
              ) : null}
            </div>
            {data.image ? (
              <div style={{ display: "flex", flexDirection: "column", width: photo }}>
                <img src={data.image} width={photo} height={photo} />
                {data.credit ? <div style={{ fontSize: 10, marginTop: 5, alignSelf: "flex-end" }}>{data.credit}</div> : null}
              </div>
            ) : null}
          </div>
        </div>
      );
    },
  });
}

const nyt = (feed: string) => `https://rss.nytimes.com/services/xml/rss/nyt/${feed}.xml`;

export const nytimes = newspaper({
  kind: "nytimes",
  name: "New York Times",
  source: "NYT RSS feeds",
  description: "The story leading the front page, with its photo.",
  sections: [
    { value: "home", label: "Front page", feed: nyt("HomePage") },
    { value: "world", label: "World", feed: nyt("World") },
    { value: "us", label: "U.S.", feed: nyt("US") },
    { value: "business", label: "Business", feed: nyt("Business") },
    { value: "technology", label: "Tech", feed: nyt("Technology") },
    { value: "science", label: "Science", feed: nyt("Science") },
    { value: "arts", label: "Arts", feed: nyt("Arts") },
  ],
  masthead: (scale) => (
    <div style={{ display: "flex", justifyContent: "center", fontFamily: "Blackletter", fontSize: 50 * scale, lineHeight: 1 }}>The New York Times</div>
  ),
});

const wsjFeed = (feed: string) => `https://feeds.content.dowjones.io/public/rss/${feed}`;

export const wsj = newspaper({
  kind: "wsj",
  name: "Wall Street Journal",
  source: "WSJ RSS feeds (Dow Jones)",
  description: "The latest story in a section of the Journal, with its photo.",
  sections: [
    { value: "world", label: "World", feed: wsjFeed("RSSWorldNews") },
    { value: "us", label: "U.S.", feed: wsjFeed("RSSUSnews") },
    { value: "business", label: "Business", feed: wsjFeed("WSJcomUSBusiness") },
    { value: "markets", label: "Markets", feed: wsjFeed("RSSMarketsMain") },
    { value: "tech", label: "Tech", feed: wsjFeed("RSSWSJD") },
    { value: "opinion", label: "Opinion", feed: wsjFeed("RSSOpinion") },
    { value: "life", label: "Life & Arts", feed: wsjFeed("RSSLifestyle") },
  ],
  masthead: (scale) => (
    <div style={{ display: "flex", justifyContent: "center", fontFamily: "Source Serif", fontSize: 40 * scale, fontWeight: 700, letterSpacing: 1, lineHeight: 1.2 }}>
      THE WALL STREET JOURNAL.
    </div>
  ),
  // The Journal's image server resizes on request: no need to pull the full-size original.
  photoUrl: (src) => `${src}${src.includes("?") ? "&" : "?"}width=700&height=700`,
});
