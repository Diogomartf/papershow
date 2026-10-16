// Sizing type so it fills a box and still looks set: as large as it can be, then a step or two smaller when
// that pulls a short last word up onto the line above. Anything that cannot fit even then is cut.
import type { JSX } from "#jsx/jsx-runtime";
import { sheet } from "./types.ts";

export type Font = "sans" | "serif";

type Box = { w: number; h: number };

export type Block = {
  size: number;
  lineHeight: number;
  tracking: number;
  lines: string[];
  clipped: boolean;
};

/** A glyph's width in ems. A little wide on purpose: a line that measures as fitting then really does. */
function em(c: string, font: Font) {
  const serif = font === "serif";
  if (c === " ") return 0.28;
  if (c === "…" || c === "—") return 1;
  if (c === "–" || c === "-") return 0.42;
  if (/[0-9]/.test(c)) return serif ? 0.56 : 0.62;
  if (/[mw]/.test(c)) return serif ? 0.92 : 0.88;
  if (/[MW]/.test(c)) return 0.96;
  if (/[ilj]/.test(c)) return 0.3;
  if (/[ft]/.test(c)) return 0.38;
  if (c === "r") return 0.4;
  if (/[.,;:'’!|`]/.test(c)) return 0.32;
  if (/[“”"]/.test(c)) return 0.48;
  if (/[A-Z]/.test(c)) return serif ? 0.74 : 0.7;
  return serif ? 0.54 : 0.58;
}

// Wider than the drawn glyphs, so a line that measures as fitting does not get wrapped again by satori.
const slack = 1.05;

/** How wide `text` paints at `size` px. `tracking` is the extra px between glyphs (negative pulls them together). */
export function textWidth(text: string, size: number, font: Font = "sans", tracking = 0) {
  const glyphs = [...text];
  if (!glyphs.length) return 0;
  return glyphs.reduce((sum, c) => sum + em(c, font), 0) * size * slack + tracking * (glyphs.length - 1);
}

/** Tighter leading and tracking as the type gets bigger, which is how a poster stays even instead of loose. */
const leading = (size: number) => (size >= 88 ? 1.04 : size >= 56 ? 1.1 : size >= 36 ? 1.16 : 1.22);
const trackingFor = (size: number, font: Font) =>
  font === "serif" ? (size >= 80 ? -0.8 : 0) : size >= 90 ? -size * 0.025 : size >= 48 ? -1 : 0;

function pieces(word: string, size: number, width: number, font: Font, tracking: number): string[] {
  const chars = [...word];
  if (textWidth(word, size, font, tracking) <= width || chars.length <= 1) return [word];
  const out: string[] = [];
  let rest = chars;
  while (rest.length) {
    const whole = rest.join("");
    if (textWidth(whole, size, font, tracking) <= width) {
      out.push(whole);
      break;
    }
    let n = rest.length - 1;
    while (n > 1 && textWidth(`${rest.slice(0, n).join("")}-`, size, font, tracking) > width) n--;
    const take = Math.max(n, 1);
    out.push(`${rest.slice(0, take).join("")}-`);
    rest = rest.slice(take);
  }
  return out;
}

/** The lines `text` takes at `size`. A word wider than the box is broken with a hyphen, so it can't run off. */
function breakLines(text: string, size: number, width: number, font: Font, tracking: number) {
  const out: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    for (const piece of pieces(word, size, width, font, tracking)) {
      const line = out.length ? `${out.at(-1)} ${piece}` : piece;
      if (out.length && textWidth(line, size, font, tracking) <= width) out[out.length - 1] = line;
      else out.push(piece);
    }
  }
  return out;
}

/**
 * How many px of size a ragged last line is worth giving up. A single short word costs the most;
 * a last line that still fills a third of the measure costs nothing.
 */
function rag(lines: string[], size: number, width: number, font: Font, tracking: number) {
  if (lines.length < 2) return 0;
  const last = textWidth(lines.at(-1)!, size, font, tracking);
  if (last >= width * 0.38) return 0;
  const short = 1 - last / (width * 0.38);
  const oneWord = lines.at(-1)!.trim().split(/\s+/).length === 1;
  return short * (oneWord ? 12 : 7);
}

function clipTo(lines: string[], rows: number, size: number, width: number, font: Font, tracking: number) {
  if (lines.length <= rows) return lines;
  const kept = lines.slice(0, Math.max(rows, 1));
  let last = kept.at(-1)!.replace(/[-–—\s]+$/, "");
  while (last && textWidth(`${last}…`, size, font, tracking) > width) last = last.replace(/\s*\S+$/, "").replace(/[-–—\s]+$/, "");
  kept[kept.length - 1] = `${last || kept.at(-1)!.slice(0, 1)}…`;
  return kept;
}

type RowOpts = { max?: number; min?: number; font?: Font };

/**
 * Largest type at which `rows` fit in `box`, stepping down a little when that makes the rag more even.
 * Each entry of `rows` stays its own paragraph (a haiku, a list of headlines). Cut only at `min`.
 */
export function fitRows(rows: string[], box: Box, opts: RowOpts = {}): Block & { groups: string[][] } {
  const font = opts.font ?? "sans";
  const max = opts.max ?? 160;
  const min = opts.min ?? 22;
  const source = rows.map((r) => r.trim()).filter(Boolean);
  if (!source.length) return { size: min, lineHeight: leading(min), tracking: 0, lines: [], groups: [], clipped: false };

  let best: { size: number; groups: string[][]; rank: number } | null = null;
  let largest = 0;
  for (let size = max; size >= min; size -= 2) {
    const track = trackingFor(size, font);
    const lh = leading(size);
    const groups = source.map((row) => breakLines(row, size, box.w, font, track));
    const gap = source.length > 1 ? size * 0.22 : 0;
    const lines = groups.reduce((n, g) => n + g.length, 0);
    const height = lines * size * lh + gap * (source.length - 1);
    if (height > box.h) continue;
    if (!largest) largest = size;
    const penalty = groups.reduce((p, g) => p + rag(g, size, box.w, font, track), 0);
    const rank = size - penalty;
    if (!best || rank > best.rank) best = { size, groups, rank };
    // A widow is worth a small step down, not a much smaller poster.
    if (largest - size >= 14) break;
  }

  if (best) {
    const track = trackingFor(best.size, font);
    return {
      size: best.size,
      lineHeight: leading(best.size),
      tracking: track,
      groups: best.groups,
      lines: best.groups.flat(),
      clipped: false,
    };
  }

  const track = trackingFor(min, font);
  const lh = leading(min);
  const gap = source.length > 1 ? min * 0.22 : 0;
  const budget = Math.max(1, Math.floor((box.h - gap * (source.length - 1)) / Math.max(min * lh, 1)));
  const groups = source.map((row) => breakLines(row, min, box.w, font, track));
  let left = budget;
  const kept: string[][] = [];
  for (const group of groups) {
    if (left <= 0) break;
    if (group.length > left) {
      kept.push(clipTo(group, left, min, box.w, font, track));
      left = 0;
    } else {
      kept.push(group);
      left -= group.length;
    }
  }
  // Whole rows fell off the bottom: the last line that remains still has to say there's more.
  if (left === 0 && kept.length && groups.flat().length > budget && !kept.at(-1)!.at(-1)!.endsWith("…")) {
    const last = kept.length - 1;
    let line = kept[last].at(-1)!.replace(/[-–—\s]+$/, "");
    while (line && textWidth(`${line}…`, min, font, track) > box.w) line = line.replace(/\s*\S+$/, "").replace(/[-–—\s]+$/, "");
    kept[last] = [...kept[last].slice(0, -1), `${line || kept[last].at(-1)!.slice(0, 1)}…`];
  }
  return { size: min, lineHeight: lh, tracking: track, groups: kept, lines: kept.flat(), clipped: true };
}

/** `fitRows` for one paragraph. */
export function fitText(text: string, box: Box, opts: RowOpts = {}): Block {
  const laid = fitRows([text], box, opts);
  return { size: laid.size, lineHeight: laid.lineHeight, tracking: laid.tracking, lines: laid.lines, clipped: laid.clipped };
}

/**
 * A word (or short heading) over its meaning. The word stays the larger of the two, and both have to fit;
 * if the meaning would be cut, the word steps down until it isn't.
 */
export function fitPair(head: string, body: string, box: Box) {
  const font: Font = "sans";
  const widest = Math.max(textWidth(head, 1, font), 0.01);
  const headMax = Math.min(150, Math.floor(box.w / widest));
  let best: { head: Block; body: Block; score: number } | null = null;
  for (let headSize = Math.max(headMax, 36); headSize >= 36; headSize -= 2) {
    const track = trackingFor(headSize, font);
    const headLines = breakLines(head, headSize, box.w, font, track);
    if (headLines.length > 2) continue;
    const headH = headLines.length * headSize * leading(headSize);
    const remain = box.h - headH - 22;
    if (remain < 40) continue;
    const bodyMax = Math.min(72, Math.round(headSize * 0.7));
    const bodyBlock = fitText(body, { w: box.w, h: remain }, { max: bodyMax, min: 22, font });
    const score = headSize * 2 + bodyBlock.size - (bodyBlock.clipped ? 80 : 0);
    const headBlock: Block = { size: headSize, lineHeight: leading(headSize), tracking: track, lines: headLines, clipped: false };
    if (!best || score > best.score) best = { head: headBlock, body: bodyBlock, score };
  }
  if (best) return { head: best.head, body: best.body };
  const bodyBlock = fitText(body, box, { max: 28, min: 22 });
  return { head: fitText(head, { w: box.w, h: 48 }, { max: 36, min: 22 }), body: bodyBlock };
}

/** One line, as big as `max`, shrunk or cut so it stays within `width`. `loose` under 1 treats glyphs as narrower. */
export function fitLine(text: string, width: number, max: number, min = 14, font: Font = "sans", loose = 1) {
  const clean = text.trim();
  const wide = (value: string, size: number, tracking: number) => textWidth(value, size, font, tracking) * loose;
  for (let size = max; size >= min; size -= 1) {
    if (wide(clean, size, trackingFor(size, font)) <= width) return { size, text: clean };
  }
  const track = trackingFor(min, font);
  let cut = clean;
  while (cut && wide(`${cut}…`, min, track) > width) cut = cut.replace(/\s*\S+$/, "");
  return { size: min, text: cut ? `${cut}…` : clean.slice(0, 1) };
}

/** The box Fill leaves once the corner label and the margins are in. No label, and the type can use the top too. */
export function fillBox(kicker?: string): Box {
  const top = kicker?.trim() ? 44 : 32;
  return { w: 800 - 64, h: 480 - top - 28 };
}

export function TypeBlock({ lines, size, lineHeight, tracking, weight, font = "sans" }: { lines: string[]; size: number; lineHeight: number; tracking: number; weight: number; font?: Font }) {
  if (!lines.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%" }}>
      {lines.map((line, i) => (
        <div
          key={i}
          style={{
            fontFamily: font === "serif" ? "Source Serif" : "Inter",
            fontSize: size,
            fontWeight: weight,
            lineHeight,
            letterSpacing: tracking,
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {line}
        </div>
      ))}
    </div>
  );
}

/** Paragraphs set as one block, with a gap between them (the haiku's three lines). */
export function TypeRows({ groups, size, lineHeight, tracking, weight, font = "sans", gap }: { groups: string[][]; size: number; lineHeight: number; tracking: number; weight: number; font?: Font; gap: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", gap }}>
      {groups.map((lines, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column" }}>
          <TypeBlock lines={lines} size={size} lineHeight={lineHeight} tracking={tracking} weight={weight} font={font} />
        </div>
      ))}
    </div>
  );
}

export function Fitted({ text, width, height, max = 80, min = 22, weight = 500, font = "sans" }: { text: string; width: number; height: number; max?: number; min?: number; weight?: number; font?: Font }) {
  const block = fitText(text, { w: width, h: height }, { max, min, font });
  return <TypeBlock lines={block.lines} size={block.size} lineHeight={block.lineHeight} tracking={block.tracking} weight={weight} font={font} />;
}

export function FittedRows({ rows, width, height, max = 80, min = 22, weight = 500, font = "sans" }: { rows: string[]; width: number; height: number; max?: number; min?: number; weight?: number; font?: Font }) {
  const block = fitRows(rows, { w: width, h: height }, { max, min, font });
  return <TypeRows groups={block.groups} size={block.size} lineHeight={block.lineHeight} tracking={block.tracking} weight={weight} font={font} gap={rows.length > 1 ? block.size * 0.22 : 0} />;
}

export function FittedPair({ head, body, width, height }: { head: string; body: string; width: number; height: number }) {
  const pair = fitPair(head, body, { w: width, h: height });
  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", gap: 22 }}>
      <TypeBlock lines={pair.head.lines} size={pair.head.size} lineHeight={pair.head.lineHeight} tracking={pair.head.tracking} weight={600} />
      <TypeBlock lines={pair.body.lines} size={pair.body.size} lineHeight={pair.body.lineHeight} tracking={pair.body.tracking} weight={400} />
    </div>
  );
}

/**
 * Small type in the top-right corner, on the edge: it's there to be read up close, and it stays out of the
 * main text. The parent has to be `position: "relative"`.
 */
export function Kicker({ text }: { text: string }) {
  const label = text.trim();
  if (!label) return null;
  let size = 14;
  while (size > 11 && textWidth(label.toUpperCase(), size, "sans", 1.4) > 340) size -= 1;
  return (
    <div style={{ position: "absolute", top: 10, right: 14, fontSize: size, fontWeight: 600, letterSpacing: 1.4, textTransform: "uppercase" }}>
      {label}
    </div>
  );
}

function Frame({ kicker, children }: { kicker?: string; children: JSX.Element }) {
  const label = kicker?.trim() || undefined;
  return (
    <div style={{ ...sheet, position: "relative", flexDirection: "column", justifyContent: "center", padding: label ? "44px 32px 28px" : "32px 32px 28px" }}>
      {label ? <Kicker text={label} /> : null}
      {children}
    </div>
  );
}

/** Fill: one block of text, as large as the panel allows, with `kicker` small in the corner. */
export function FillFrame({ kicker, text, font = "sans", keepLines = false }: { kicker?: string; text: string; font?: Font; keepLines?: boolean }) {
  const label = kicker?.trim() || undefined;
  const box = fillBox(label);
  const rows = text.split("\n").map((r) => r.trim()).filter(Boolean);
  const weight = font === "serif" ? 600 : 500;
  if (keepLines && rows.length > 1) {
    const block = fitRows(rows, box, { max: 150, min: 22, font });
    return (
      <Frame kicker={label}>
        <TypeRows groups={block.groups} size={block.size} lineHeight={block.lineHeight} tracking={block.tracking} weight={weight} font={font} gap={block.size * 0.22} />
      </Frame>
    );
  }
  const block = fitText(rows.join(" "), box, { max: 160, min: 22, font });
  return (
    <Frame kicker={label}>
      <TypeBlock lines={block.lines} size={block.size} lineHeight={block.lineHeight} tracking={block.tracking} weight={weight} font={font} />
    </Frame>
  );
}

/** Fill for a word and its meaning: the word large, the meaning under it, the label in the corner. */
export function FillPair({ kicker, head, body }: { kicker?: string; head: string; body: string }) {
  const label = kicker?.trim() || undefined;
  const pair = fitPair(head, body, fillBox(label));
  return (
    <Frame kicker={label}>
      <div style={{ display: "flex", flexDirection: "column", width: "100%", gap: 22 }}>
        <TypeBlock lines={pair.head.lines} size={pair.head.size} lineHeight={pair.head.lineHeight} tracking={pair.head.tracking} weight={600} />
        <TypeBlock lines={pair.body.lines} size={pair.body.size} lineHeight={pair.body.lineHeight} tracking={pair.body.tracking} weight={400} />
      </div>
    </Frame>
  );
}
