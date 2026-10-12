// JSX → frame, on the server. satori lays out and turns text into paths,
// resvg (Rust) rasterizes, then the result is reduced to what the panel shows.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Resvg } from "@resvg/resvg-js";
import { encode } from "fast-png";
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

/**
 * A picture already reduced to 1 bit at the size it will be drawn, as a data URL for <img>.
 * Cropped to fill the box, then levels, contrast and edges are tuned for e-ink before dithering.
 * Dithering just the picture keeps text around it crisp: the frame itself can then use plain threshold.
 */
export function ditheredImage(
  bytes: Uint8Array,
  width: number,
  height = width,
  { round = false, type = "image/png", ...tune }: { round?: boolean; type?: string } & Enhance = {},
) {
  const href = `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
  const r = Math.min(width, height) / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <clipPath id="c"><circle cx="${width / 2}" cy="${height / 2}" r="${r}"/></clipPath>
    <image href="${href}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice" ${round ? 'clip-path="url(#c)"' : ""}/>
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
  // A crisp ring after dithering, so round marks keep a clean edge.
  if (round)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const d = Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2);
        if (d > r) gray[y * width + x] = 255;
        else if (d > r - 3) gray[y * width + x] = 0;
      }
  return `data:image/png;base64,${Buffer.from(encode({ width, height, data: gray, channels: 1, depth: 8 })).toString("base64")}`;
}
