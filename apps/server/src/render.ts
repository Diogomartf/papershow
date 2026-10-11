// JSX → frame, on the server. satori lays out and turns text into paths,
// resvg (Rust) rasterizes, then the result is reduced to what the panel shows.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Resvg } from "@resvg/resvg-js";
import { encode } from "fast-png";
import satori from "satori";
import { dither, pack1bpp, PANEL, type DitherMode } from "@papershow/scene";
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
const inter = (weight: number, file: string) => ({
  name: "Inter",
  weight: weight as 300 | 400 | 500 | 600 | 700,
  style: "normal" as const,
  data: readFileSync(require.resolve(`@expo-google-fonts/inter/${file}/Inter_${file}.ttf`)),
});
const FONTS = [inter(300, "300Light"), inter(400, "400Regular"), inter(500, "500Medium"), inter(600, "600SemiBold"), inter(700, "700Bold")];

export async function renderFrame(node: JSX.Element, mode: DitherMode = "threshold"): Promise<Frame> {
  const { w, h } = PANEL;
  const svg = await satori(node as never, { width: w, height: h, fonts: FONTS });
  // satori already turned text into paths, so resvg needs no fonts of its own.
  const image = new Resvg(svg, { background: "#ffffff", font: { loadSystemFonts: false } }).render();
  const png = new Uint8Array(image.asPng());
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
