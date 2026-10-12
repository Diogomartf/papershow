import { decode, defineApp, sheet } from "./types.ts";

const FEEDS = {
  home: "HomePage",
  world: "World",
  us: "US",
  business: "Business",
  technology: "Technology",
  science: "Science",
  arts: "Arts",
} as const;

type Story = { title: string; summary: string; byline: string; credit: string; image: string | null };

const tag = (xml: string, name: string) => decode(xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? "");

/** The first story in the section's RSS feed, which is the one leading the page. */
async function leadStory(section: keyof typeof FEEDS, withImage: boolean): Promise<Story> {
  const res = await fetch(`https://rss.nytimes.com/services/xml/rss/nyt/${FEEDS[section]}.xml`);
  if (!res.ok) throw new Error(`nytimes rss → ${res.status}`);
  const item = (await res.text()).match(/<item>([\s\S]*?)<\/item>/)?.[1];
  if (!item) throw new Error("nytimes rss: no stories");
  const src = item.match(/<media:content[^>]*url="([^"]+)"/)?.[1];
  let image: string | null = null;
  if (withImage && src) {
    const img = await fetch(decode(src));
    if (img.ok) image = `data:${img.headers.get("content-type") ?? "image/jpeg"};base64,${Buffer.from(await img.arrayBuffer()).toString("base64")}`;
  }
  return {
    title: tag(item, "title"),
    summary: tag(item, "description"),
    byline: tag(item, "dc:creator"),
    credit: tag(item, "media:credit"),
    image,
  };
}

const SECTION_NAMES: Record<string, string> = { home: "Front page", world: "World", us: "U.S.", business: "Business", technology: "Technology", science: "Science", arts: "Arts" };

// The last story that loaded, so a network blip keeps the old front page up instead of failing.
const last = new Map<string, Story>();

export default defineApp({
  kind: "nytimes",
  name: "New York Times",
  description: "The story leading the front page, with its photo.",
  defaults: { section: "home" as keyof typeof FEEDS, photo: true },
  fields: [
    {
      key: "section",
      label: "Section",
      type: "select",
      options: [
        { value: "home", label: "Front page" },
        { value: "world", label: "World" },
        { value: "us", label: "U.S." },
        { value: "business", label: "Business" },
        { value: "technology", label: "Tech" },
        { value: "science", label: "Science" },
        { value: "arts", label: "Arts" },
      ],
    },
    { key: "photo", label: "Photo", type: "toggle" },
  ],
  periodMs: 15 * 60_000,
  mock: false,
  dither: "atkinson",
  data: async (config) => {
    const key = `${config.section}:${config.photo}`;
    try {
      const story = await leadStory(config.section, config.photo);
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
    const n = data.title.length;
    const wide = !data.image;
    const size = wide ? (n <= 70 ? 50 : n <= 110 ? 42 : 36) : n <= 60 ? 40 : n <= 90 ? 34 : 29;
    const serif = { fontFamily: "Source Serif" };
    return (
      <div style={{ ...sheet, flexDirection: "column", padding: "18px 32px 22px" }}>
        <div style={{ display: "flex", justifyContent: "center", fontFamily: "Blackletter", fontSize: 50, lineHeight: 1 }}>
          The New York Times
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginTop: 8, gap: 2 }}>
          <div style={{ height: 1, background: "#000" }} />
          <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 12, fontWeight: 500 }}>
            <span>{date}</span>
            <span>{SECTION_NAMES[config.section] ?? ""}</span>
          </div>
          <div style={{ height: 2, background: "#000" }} />
          <div style={{ height: 1, background: "#000" }} />
        </div>
        <div style={{ display: "flex", flex: 1, marginTop: 18, gap: 28 }}>
          <div style={{ display: "flex", flexDirection: "column", flex: 1, ...serif }}>
            <div style={{ fontSize: size, fontWeight: 700, lineHeight: 1.12, letterSpacing: -0.5 }}>{data.title}</div>
            <div style={{ fontSize: wide ? 22 : 18, lineHeight: 1.4, marginTop: 14 }}>{data.summary}</div>
            {data.byline ? (
              <div style={{ fontFamily: "Inter", fontSize: 12, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", marginTop: 14 }}>
                {`By ${data.byline}`}
              </div>
            ) : null}
          </div>
          {data.image ? (
            <div style={{ display: "flex", flexDirection: "column", width: 330 }}>
              <img src={data.image} width={330} height={330} style={{ objectFit: "cover" }} />
              {data.credit ? <div style={{ fontSize: 10, marginTop: 5, alignSelf: "flex-end" }}>{data.credit}</div> : null}
            </div>
          ) : null}
        </div>
      </div>
    );
  },
});
