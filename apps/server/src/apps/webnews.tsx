import { getPublic } from "../net.ts";
import { ditheredImage } from "../render.ts";
import { FrontPage, PHOTO, STYLES, type Story, type Style } from "./news.tsx";
import { decode, defineApp } from "./types.ts";

const HEADERS = { "User-Agent": "Mozilla/5.0 (Papershow)", "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8" };
// Only the public internet: the address is typed by whoever made the app, guests included.
const get = (url: string) => getPublic(url, { headers: HEADERS });

/** A meta tag's content, whichever order its attributes come in. */
const meta = (html: string, name: string) => {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!new RegExp(`(property|name)=["']${name}["']`, "i").test(tag)) continue;
    const content = tag.match(/content=["']([^"']*)["']/i)?.[1];
    if (content) return decode(content);
  }
  return "";
};

// Twice: some feeds escape their CDATA and markup, which only shows once the entities are decoded.
const first = (xml: string, name: string) => decode(decode(xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"))?.[1] ?? ""));

type Lead = { title: string; url: string; summary: string; image: string };

/** The first item of an RSS or Atom feed: feeds list the stories the site puts first. */
function feedLead(xml: string, base: string): Lead | null {
  const item = xml.match(/<item\b[^>]*>([\s\S]*?)<\/item>/i)?.[1] ?? xml.match(/<entry\b[^>]*>([\s\S]*?)<\/entry>/i)?.[1];
  if (!item) return null;
  const link = first(item, "link") || item.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1] || "";
  // The description is often HTML with the photo inside it.
  const raw = item.match(/<(description|summary|content)\b[^>]*>([\s\S]*?)<\/\1>/i)?.[2] ?? "";
  const html = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
  const image =
    item.match(/<media:(?:content|thumbnail)\b[^>]*url=["']([^"']+)["']/i)?.[1] ??
    item.match(/<enclosure\b[^>]*url=["']([^"']+\.(?:jpe?g|png|webp|gif)[^"']*)["']/i)?.[1] ??
    html.match(/<img\b[^>]*src=["']([^"']+)["']/i)?.[1] ??
    "";
  return { title: first(item, "title"), url: abs(decode(link), base), summary: decode(html), image: image && abs(decode(image), base) };
}

/**
 * A link's headline. Cards often wrap a kicker ("Live", a section) and a summary in the same link: take its
 * heading when it has one, else its longest run of text.
 */
function headline(inner: string) {
  const heading = inner.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1];
  if (heading) return decode(heading);
  return inner
    // Any tag but inline emphasis ends a run, and so do comments.
    .split(/<(?!\/?(?:b|i|em|q|abbr)\b)[^>]+>/i)
    .map(decode)
    .reduce((a, b) => (b.length > a.length ? b : a), "");
}

/** The page's first headline: the first link to a story on the site whose text reads like one, in page order. */
function pageLead(html: string, base: string): Lead | null {
  const host = new URL(base).hostname.replace(/^www\./, "");
  const body = html.replace(/<(script|style|nav|header|footer)\b[\s\S]*?<\/\1>/gi, "");
  for (const [, attrs, href, inner] of body.matchAll(/<a\b([^>]*href=["']([^"'#]+)["'][^>]*)>([\s\S]*?)<\/a>/gi)) {
    // A card's link may be an empty box over it, its headline only in aria-label.
    const title = headline(inner) || decode(attrs.match(/aria-label=["']([^"']+)["']/i)?.[1] ?? "");
    if (title.length < 30 || title.split(" ").length < 5) continue;
    const url = abs(decode(href), base);
    // A story on this site, below its front page: not a menu, a social link or an ad.
    try {
      const u = new URL(url);
      if (u.hostname.replace(/^www\./, "") !== host || u.pathname.split("/").filter(Boolean).length === 0) continue;
    } catch {
      continue;
    }
    return { title, url, summary: "", image: "" };
  }
  return null;
}

const abs = (url: string, base: string) => {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
};

/** The site's own name: its og:site_name, else a short title up to the first separator, else its address. */
const siteName = (html: string, url: string) => {
  const title = first(html, "title").split(/\s+[|–—·-]\s+|:\s/)[0];
  return meta(html, "og:site_name") || (title.length <= 24 ? title : "") || new URL(url).hostname.replace(/^www\./, "");
};

type Page = Story & { site: string; host: string };

const isFeed = (text: string) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)?<(rss|feed|rdf:RDF)\b/i.test(text);

// Where sites usually keep a feed they don't link from the page.
const FEED_PATHS = ["/feed", "/rss", "/rss.xml", "/feed.xml", "/index.xml", "/feeds/posts/default"];

/** The site's feed: the one its page lists, else the first of the usual places that answers with one. */
async function findFeed(html: string, base: string): Promise<string | null> {
  const listed = html.match(/<link\b[^>]*type=["']application\/(?:rss|atom)\+xml["'][^>]*>/i)?.[0].match(/href=["']([^"']+)["']/i)?.[1];
  if (listed) return abs(decode(listed), base);
  const tries = FEED_PATHS.map(async (path) => {
    const res = await get(new URL(path, base).href);
    const text = res.ok ? await res.text() : "";
    if (!isFeed(text)) throw new Error("not a feed");
    return res.url;
  });
  return Promise.any(tries).catch(() => null);
}

/** What the paper shows: the newest story in the site's feed, or the one leading its front page. */
type From = "feed" | "page";

/**
 * The site's lead story, from its feed or from its front page as `from` asks, falling back on the other. A feed is
 * cleaner and lists the newest story first; the front page's first headline is the one the site leads with. Then
 * the story's own page fills in the summary and photo.
 */
async function lead(url: string, from: From, photo: number | null): Promise<Page> {
  const res = await get(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  const text = await res.text();
  const base = res.url || url;
  const feed = isFeed(text);
  let site = feed ? first(text, "title") : siteName(text, base);
  const fromFeed = async () => {
    const href = await findFeed(text, base);
    const f = href ? await get(href).catch(() => null) : null;
    return f?.ok ? feedLead(await f.text(), base) : null;
  };
  let story: Lead | null;
  if (feed) story = feedLead(text, base);
  else if (from === "feed") story = (await fromFeed()) ?? pageLead(text, base);
  else story = pageLead(text, base) ?? (await fromFeed());
  if (!story?.title) throw new Error(`${url}: no stories found`);

  // The story's page has the summary and photo the site shows when it's shared.
  if ((!story.summary || (photo && !story.image)) && story.url) {
    const page = await get(story.url).then((r) => (r.ok ? r.text() : ""), () => "");
    story.summary ||= meta(page, "og:description") || meta(page, "description");
    story.image ||= abs(meta(page, "og:image"), story.url);
    // A story's page names the site more reliably than a front page, whose title is often a slogan.
    if (meta(page, "og:site_name")) site = meta(page, "og:site_name");
    else if (feed) site ||= siteName(page, story.url);
  }

  let image: string | null = null;
  if (photo && story.image) {
    const img = await get(story.image).catch(() => null);
    const bytes = img?.ok ? img.bytes : null;
    const type = bytes && sniff(bytes);
    // A picture too big to draw safely leaves the story without one.
    if (type) image = tryDither(bytes, photo, type);
  }
  return { title: story.title, summary: story.summary, byline: "", credit: "", image, site, host: new URL(base).hostname.replace(/^www\./, "") };
}

function tryDither(bytes: Uint8Array, size: number, type: string) {
  try {
    return ditheredImage(bytes, size, size, { type });
  } catch {
    return null;
  }
}

/** A picture's type from its first bytes: some servers label JPEGs as PNGs. Null for kinds resvg can't draw. */
function sniff(b: Uint8Array) {
  const head = Buffer.from(b.subarray(0, 12)).toString("latin1");
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (head.startsWith("\x89PNG")) return "image/png";
  if (head.startsWith("GIF8")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8) === "WEBP") return "image/webp";
  return null;
}

// The last page that loaded per site, so a network blip keeps the old front page up instead of failing.
const last = new Map<string, Page>();

/** Asks for a URL until there's one: the frame says what to do instead of failing. */
const EMPTY: Page = {
  title: "Paste a news site's address in this app's settings",
  summary: "Its top story appears here, like sapo.pt or abola.pt.",
  byline: "",
  credit: "",
  image: null,
  site: "Custom news",
  host: "",
};

export default defineApp({
  kind: "webnews",
  name: "Custom news",
  category: "news",
  source: "the site you paste",
  description: "The top story of any news site, from its address.",
  defaults: { url: "", from: "feed" as From, name: "", photo: true, style: "poster" as Style },
  fields: [
    { key: "url", label: "Site", type: "text", placeholder: "https://sapo.pt", hint: "A news site's address: its feed is found for you. Or the feed's own address." },
    {
      key: "from",
      label: "Story",
      type: "select",
      options: [
        { value: "feed", label: "Latest" },
        { value: "page", label: "Top of the page" },
      ],
      hint: "Latest: the newest in the site's feed. Top of the page: the one the site leads with. Each falls back on the other.",
    },
    { key: "name", label: "Name", type: "text", placeholder: "From the site", hint: "Set at the top; leave empty for the site's own" },
    { key: "photo", label: "Photo", type: "toggle" },
    {
      key: "style",
      label: "Style",
      type: "select",
      options: STYLES,
      hint: "Poster reads from across the room. Clean: the same, under a smaller name with no date. Classic: the whole summary, smaller. Title: only the headline, as big as it fits. Fill: the headline as large as the panel allows, the site's name in the corner.",
    },
  ],
  periodMs: 15 * 60_000,
  mock: false,
  data: async (config) => {
    if (!config.url) return EMPTY;
    const url = /^https?:\/\//i.test(config.url) ? config.url : `https://${config.url}`;
    const photo = config.photo ? PHOTO[config.style] : null;
    const key = `${url}:${config.from}:${photo}`;
    try {
      const page = await lead(url, config.from, photo);
      last.set(key, page);
      // Addresses are typed in, so keep only the most recent ones.
      if (last.size > 50) last.delete(last.keys().next().value!);
      return page;
    } catch (err) {
      const old = last.get(key);
      if (old) return old;
      throw err;
    }
  },
  view: ({ config, data, now }) => {
    const name = config.name || data.site;
    return (
      <FrontPage
        // Long names come down in size so they stay on one line.
        masthead={(scale) => (
          <div style={{ display: "flex", justifyContent: "center", fontFamily: "Source Serif", fontWeight: 700, lineHeight: 1.2, fontSize: Math.min(44, 1300 / Math.max(name.length, 1)) * scale }}>
            {name}
          </div>
        )}
        label={data.host}
        kicker={name}
        style={config.style}
        story={data}
        now={now}
      />
    );
  },
});
