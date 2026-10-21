// JSX → frame, on the server. satori lays out and turns text into paths,
// resvg (Rust) rasterizes, then the result is reduced to what the panel shows.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Resvg } from "@resvg/resvg-js";
import { decode, encode } from "fast-png";
import satori from "satori";
import { dither, enhance, pack1bpp, PANEL, type DitherMode, type Enhance } from "@papershow/scene";
import type { JSX } from "#jsx/jsx-runtime";

export type Frame = {
  /** As rendered, before reduction. */
  png: Uint8Array<ArrayBuffer>;
  /** 1-bit, what the panel shows. */
  mono: Uint8Array<ArrayBuffer>;
  /** 1bpp packed, straight to the EPD. */
  bin: Uint8Array<ArrayBuffer>;
  /** Changes only when the pixels do. */
  hash: string;
};

const require = createRequire(import.meta.url);
const font = (name: string, pkg: string, prefix: string) => (weight: number, file: string) => ({
  name,
  weight: weight as 300 | 400 | 500 | 600 | 700,
  style: "normal" as const,
  data: readFileSync(require.resolve(`@expo-google-fonts/${pkg}/${file}/${prefix}_${file}.ttf`)),
});
const inter = font("Inter", "inter", "Inter");
const serif = font("Source Serif", "source-serif-4", "SourceSerif4");
const FONTS = [
  inter(300, "300Light"), inter(400, "400Regular"), inter(500, "500Medium"), inter(600, "600SemiBold"), inter(700, "700Bold"),
  // Newspaper-style apps: a serif for headlines, blackletter for mastheads.
  serif(400, "400Regular"), serif(600, "600SemiBold"), serif(700, "700Bold"),
  font("Blackletter", "unifrakturmaguntia", "UnifrakturMaguntia")(400, "400Regular"),
];

/** `pngScale`: draw the colour `png` larger than the panel (2 for sharp previews on high-density screens). */
export async function renderFrame(node: JSX.Element, mode: DitherMode = "threshold", { pngScale = 1 } = {}): Promise<Frame> {
  const { w, h } = PANEL;
  const svg = await satori(node as never, { width: w, height: h, fonts: FONTS });
  // satori already turned text into paths, so resvg needs no fonts of its own.
  const options = { background: "#ffffff", font: { loadSystemFonts: false } };
  const image = new Resvg(svg, options).render();
  const png =
    pngScale === 1
      ? new Uint8Array(image.asPng())
      : new Uint8Array(new Resvg(svg, { ...options, fitTo: { mode: "zoom", value: pngScale } }).render().asPng());
  return { png, ...reduce(new Uint8ClampedArray(image.pixels), w, h, mode) };
}

/**
 * A drawing's panel files, made from the 1-bit PNG the browser sent: what the household sees (`mono`) and what the
 * panel draws (`bin`) come from the same pixels, so one can't be swapped for the other. Null when it isn't an
 * 800×480 PNG.
 */
export function panelFiles(png: Uint8Array): { mono: Uint8Array<ArrayBuffer>; bin: Uint8Array<ArrayBuffer> } | null {
  const { w, h } = PANEL;
  // Check the size before decoding: a small file can claim a huge one.
  const size = pictureSize(png);
  if (!size || size.width !== w || size.height !== h || png[0] !== 0x89) return null;
  let img;
  try {
    img = decode(png);
  } catch {
    return null;
  }
  if (img.palette || (img.depth !== 8 && img.depth !== 16)) return null;
  const { channels, data } = img;
  const max = img.depth === 16 ? 65535 : 255;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    // Grey (or red, in colour), over white where it's see-through; then black or white, as the panel shows it.
    const v = data[p * channels] / max;
    const a = channels === 2 || channels === 4 ? data[p * channels + channels - 1] / max : 1;
    const ink = v * a + (1 - a) >= 0.5 ? 255 : 0;
    rgba.set([ink, ink, ink, 255], p * 4);
  }
  return reduce(rgba, w, h, "threshold");
}

/**
 * RGBA → 1-bit PNG + packed frame. The hot loop: if it ever matters on the Pi,
 * this is the function to move into a Rust native module.
 */
function reduce(rgba: Uint8ClampedArray, w: number, h: number, mode: DitherMode) {
  dither(rgba, w, h, mode);
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) gray[i] = rgba[i * 4];
  const mono = encode({ width: w, height: h, data: gray, channels: 1, depth: 8 });
  const bin = pack1bpp(rgba, w, h);
  return { mono: new Uint8Array(mono), bin, hash: createHash("sha1").update(bin).digest("hex").slice(0, 12) };
}

// Set while rendering the full-resolution original (the Apps page's "Original" view): pictures keep their colours.
const originals = new AsyncLocalStorage<true>();

/** Run a render with pictures left as they are, for the full-resolution view. */
export const renderingOriginal = <T>(fn: () => T) => originals.run(true, fn);

/** True inside `renderingOriginal`: anything caching pictures should keep the two apart. */
export const isOriginal = () => originals.getStore() === true;

/** Signed distance from a point (relative to the centre) to a rounded rectangle's edge: negative inside. */
function roundedRectDistance(px: number, py: number, halfW: number, halfH: number, r: number) {
  const qx = Math.abs(px) - (halfW - r);
  const qy = Math.abs(py) - (halfH - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** The most pixels a picture may have: resvg unpacks it whole, and a small file can claim a huge size. */
const MAX_PIXELS = 25_000_000;

/** A PNG, JPEG, GIF or WebP's size from its header, without decoding it. Null for anything else. */
export function pictureSize(b: Uint8Array): { width: number; height: number } | null {
  const u16be = (i: number) => (b[i] << 8) | b[i + 1];
  const u24le = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 3) === "PNG") {
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (b.length >= 10 && ascii(0, 4) === "GIF8") return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
  if (b.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8 ") return { width: ((b[27] << 8) | b[26]) & 0x3fff, height: ((b[29] << 8) | b[28]) & 0x3fff };
    if (chunk === "VP8L") return { width: 1 + (((b[22] & 0x3f) << 8) | b[21]), height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
    if (chunk === "VP8X") return { width: 1 + u24le(24), height: 1 + u24le(27) };
    return null;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    // Walk the segments to the frame header (SOFn), which holds the size.
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { width: u16be(i + 7), height: u16be(i + 5) };
      i += marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8) ? 2 : 2 + u16be(i + 2);
    }
  }
  return null;
}

/**
 * A picture already reduced to 1 bit at the size it will be drawn, as a data URL for <img>.
 * Cropped to fill the box, then levels, contrast and edges are tuned for e-ink before dithering.
 * Dithering just the picture keeps text around it crisp: the frame itself can then use plain threshold.
 * Throws for a picture that isn't a PNG, JPEG, GIF or WebP, or that's too big to unpack safely.
 */
export function ditheredImage(
  bytes: Uint8Array,
  width: number,
  height = width,
  { round = false, radius, type = "image/png", ...tune }: { round?: boolean; radius?: number; type?: string } & Enhance = {},
) {
  const size = pictureSize(bytes);
  if (!size || !size.width || !size.height) throw new Error("not a picture that can be drawn");
  if (size.width * size.height > MAX_PIXELS) throw new Error(`picture too big: ${size.width}×${size.height}`);
  // A circle is a rounded square whose corners meet: one shape covers both.
  const corner = round ? Math.min(width, height) / 2 : radius;
  const href = `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <clipPath id="c"><rect width="${width}" height="${height}" rx="${corner ?? 0}"/></clipPath>
    <image href="${href}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice" ${corner ? 'clip-path="url(#c)"' : ""}/>
  </svg>`;
  // The original view: cropped and clipped the same, but in full colour and at 2× for the sharp preview.
  if (isOriginal())
    return `data:image/png;base64,${Buffer.from(new Resvg(svg, { background: "#ffffff", fitTo: { mode: "zoom", value: 2 } }).render().asPng()).toString("base64")}`;
  const img = new Resvg(svg, { background: "#ffffff" }).render();
  const rgba = new Uint8ClampedArray(img.pixels);
  enhance(rgba, width, height, tune);
  dither(rgba, width, height, "atkinson");
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) gray[i] = rgba[i * 4];
  // A crisp outline after dithering, so shaped marks keep a clean edge.
  if (corner)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const d = roundedRectDistance(x + 0.5 - width / 2, y + 0.5 - height / 2, width / 2, height / 2, corner);
        if (d > 0) gray[y * width + x] = 255;
        else if (d > -3) gray[y * width + x] = 0;
      }
  return `data:image/png;base64,${Buffer.from(encode({ width, height, data: gray, channels: 1, depth: 8 })).toString("base64")}`;
}

/**
 * A drawing's ink, cropped to it and shrunk to fit `maxW` × `maxH`, as a 1-bit data URL with its size. For doodles
 * around a clock: anything but near-white counts as ink, so thin lines shrunk to a third still read on the panel.
 * Null when the drawing is blank.
 */
export function doodleImage(png: Uint8Array, maxW: number, maxH: number, crop = inkBox(png)) {
  if (!crop) return null;
  const { cw, ch, gray: src } = crop;
  const scale = Math.min(1, maxW / cw, maxH / ch);
  const ow = Math.max(1, Math.round(cw * scale)), oh = Math.max(1, Math.round(ch * scale));
  // Shrink by averaging each output pixel's patch of the drawing: quick, and as smooth as resampling needs to be here.
  const gray = new Uint8Array(ow * oh);
  for (let oy = 0; oy < oh; oy++) {
    const y0 = Math.floor((oy * ch) / oh), y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * ch) / oh));
    for (let ox = 0; ox < ow; ox++) {
      const x0 = Math.floor((ox * cw) / ow), x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * cw) / ow));
      let sum = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += src[y * cw + x];
      // A lighter cut than the frame's threshold: shrinking greys out thin lines, and they should stay black.
      gray[oy * ow + ox] = sum / ((y1 - y0) * (x1 - x0)) < 210 ? 0 : 255;
    }
  }
  const mono = encode({ width: ow, height: oh, data: gray, channels: 1, depth: 8 });
  return { src: `data:image/png;base64,${Buffer.from(mono).toString("base64")}`, width: ow, height: oh };
}

/**
 * Where a drawing's ink is: the box `doodleImage` crops to, in the drawing's pixels. The slow half of a doodle
 * (decoding and scanning every pixel), so callers drawing one drawing at several sizes find it once.
 * Null when the drawing is blank.
 */
export function inkBox(png: Uint8Array) {
  const img = decode(png);
  const { width: w, height: h, channels } = img;
  const data = img.data as Uint8Array | Uint16Array;
  const max = img.depth === 16 ? 65535 : 255;
  // Ink: dark enough, and not transparent.
  const ink = (i: number) => {
    const p = i * channels;
    const alpha = channels === 4 || channels === 2 ? data[p + channels - 1] / max : 1;
    const luma = channels >= 3 ? (data[p] * 0.3 + data[p + 1] * 0.59 + data[p + 2] * 0.11) / max : data[p] / max;
    return alpha > 0.5 && luma < 0.8;
  };
  const cols = new Uint32Array(w);
  const rows = new Uint32Array(h);
  let total = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (ink(y * w + x)) cols[x]++, rows[y]++, total++;
  if (!total) return null;
  // The ink's extent, less stray specks: a small bit at an edge, cut off from the rest by a gap, would leave the
  // doodle mostly empty.
  const GAP = 16;
  const span = (counts: Uint32Array) => {
    let from = counts.findIndex((n) => n > 0);
    let to = counts.findLastIndex((n) => n > 0);
    for (const dir of [1, -1]) {
      for (;;) {
        // The run of ink at this edge, until a gap of GAP empty lines.
        let i = dir > 0 ? from : to, mass = 0, empty = 0;
        for (; i >= from && i <= to && empty < GAP; i += dir) counts[i] ? ((mass += counts[i]), (empty = 0)) : empty++;
        if (i < from || i > to || mass >= total * 0.03) break;
        // A speck: skip it, to the next ink.
        while (i >= from && i <= to && !counts[i]) i += dir;
        if (dir > 0) from = i;
        else to = i;
      }
    }
    return [from, to];
  };
  let [x0, x1] = span(cols);
  let [y0, y1] = span(rows);
  const pad = 4;
  x0 = Math.max(0, x0 - pad), y0 = Math.max(0, y0 - pad), x1 = Math.min(w - 1, x1 + pad), y1 = Math.min(h - 1, y1 + pad);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  // The cropped drawing in grey, as it looks on white paper, ready to shrink to any size.
  const gray = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const p = ((y + y0) * w + x + x0) * channels;
      const alpha = channels === 4 || channels === 2 ? data[p + channels - 1] / max : 1;
      const luma = channels >= 3 ? (data[p] * 0.3 + data[p + 1] * 0.59 + data[p + 2] * 0.11) / max : data[p] / max;
      gray[y * cw + x] = 255 * (luma * alpha + 1 - alpha);
    }
  return { cw, ch, gray };
}
