// Shared between the ImageGen editor (browser) and SlideGen (server).
// Nothing in here may touch the DOM.

import type { Stroke } from "drawesome";

/** The Waveshare 7.5" B/W panel. Every scene is authored at panel resolution. */
export const PANEL = { w: 800, h: 480 } as const;

/** Typed words on top of the drawing. Panel pixels; `y` is the top of the first line. */
export type TextItem = {
  id: string;
  x: number;
  y: number;
  text: string;
  /** Font size in panel pixels. */
  size: number;
  bold: boolean;
  color: string;
};

/** Line height as a multiple of the font size, the same on screen and in the saved image. */
export const TEXT_LINE = 1.2;
export const TEXT_FONT = '"Inter Variable", Inter, sans-serif';

export type Scene = {
  id: string;
  name: string;
  width: number;
  height: number;
  background: string;
  strokes: Stroke[];
  /** Drawn above the strokes. Older scenes have none. */
  texts?: TextItem[];
  createdAt: number;
  updatedAt: number;
};

export type DitherMode = "atkinson" | "floyd" | "threshold";

/**
 * Reduce RGBA pixels to 1 bit per pixel, in place, so the result is still a
 * drawable RGBA buffer. Returns the same array for chaining.
 *
 * Atkinson is the default: it only diffuses 3/4 of the error, which keeps flat
 * areas clean and gives the crisp, high-contrast look that suits e-ink.
 */
export function dither(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  mode: DitherMode = "atkinson",
  threshold = 128,
): Uint8ClampedArray {
  const lum = new Float32Array(width * height);
  for (let i = 0, p = 0; p < lum.length; i += 4, p++) {
    // Composite over white first: transparent pixels are paper, not ink.
    const a = rgba[i + 3] / 255;
    const r = rgba[i] * a + 255 * (1 - a);
    const g = rgba[i + 1] * a + 255 * (1 - a);
    const b = rgba[i + 2] * a + 255 * (1 - a);
    lum[p] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  const spread = (x: number, y: number, err: number) => {
    if (x < 0 || x >= width || y >= height) return;
    lum[y * width + x] += err;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const old = lum[p];
      const next = old < threshold ? 0 : 255;
      lum[p] = next;
      const err = old - next;
      if (mode === "atkinson") {
        const e = err / 8;
        spread(x + 1, y, e);
        spread(x + 2, y, e);
        spread(x - 1, y + 1, e);
        spread(x, y + 1, e);
        spread(x + 1, y + 1, e);
        spread(x, y + 2, e);
      } else if (mode === "floyd") {
        spread(x + 1, y, (err * 7) / 16);
        spread(x - 1, y + 1, (err * 3) / 16);
        spread(x, y + 1, (err * 5) / 16);
        spread(x + 1, y + 1, err / 16);
      }
    }
  }

  for (let i = 0, p = 0; p < lum.length; i += 4, p++) {
    const v = lum[p];
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
    rgba[i + 3] = 255;
  }
  return rgba;
}

/**
 * Pack a dithered RGBA buffer into the panel's native format: 1 bit per pixel,
 * MSB first, 1 = white. 800×480 → 48,000 bytes, written straight to the EPD.
 */
export function pack1bpp(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array<ArrayBuffer> {
  const stride = Math.ceil(width / 8);
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4] >= 128) out[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}
