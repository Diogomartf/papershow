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
  /** A photo under everything, as a JPEG data URL. Older scenes saved it already cropped to the panel. */
  photo?: string;
  /** Where the photo sits. Without it, the photo fills the panel. */
  photoAt?: PhotoAt;
  /** When the photo was taken (ms since epoch), from its EXIF or else the file's date. Photos only; not always known. */
  takenAt?: number;
  /** Where the photo was taken, from its EXIF GPS. Photos only, and only when the camera wrote it. */
  takenWhere?: { lat: number; lon: number };
  createdAt: number;
  updatedAt: number;
};

/** Where a photo sits on the panel: its centre in panel pixels, its size, and how far it's turned. */
export type PhotoAt = {
  x: number;
  y: number;
  /** 1 fills the panel edge to edge, cropping what doesn't fit. Smaller leaves paper around it. */
  scale: number;
  /** Degrees clockwise, 0 to 360. */
  angle: number;
};

export const PHOTO_FILL: PhotoAt = { x: PANEL.w / 2, y: PANEL.h / 2, scale: 1, angle: 0 };

/** A `w`×`h` photo's sides as they lie across the panel: swapped when it's nearer sideways than upright. */
const across = (w: number, h: number, angle: number) => (Math.round(angle / 90) % 2 ? [h, w] : [w, h]);

/**
 * The scale that fills the panel with a `w`×`h` photo, in panel pixels per photo pixel.
 * At an angle in between it's the fill for the nearest straight one.
 */
const coverOf = (w: number, h: number, angle: number) => {
  const [sw, sh] = across(w, h, angle);
  return Math.max(PANEL.w / sw, PANEL.h / sh);
};

/** A `w`×`h` photo's size on the panel, before it's turned. */
export function photoSize(w: number, h: number, at: PhotoAt) {
  const k = coverOf(w, h, at.angle) * at.scale;
  return { w: w * k, h: h * k };
}

/** The scale at which the whole photo just fits on the panel. */
export function photoFit(w: number, h: number, angle: number) {
  const [sw, sh] = across(w, h, angle);
  return Math.min(PANEL.w / sw, PANEL.h / sh) / coverOf(w, h, angle);
}

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

  // Serpentine: every other row runs right to left, so error doesn't pile up into diagonal "worms".
  for (let y = 0; y < height; y++) {
    const d = y % 2 ? -1 : 1;
    for (let i = 0; i < width; i++) {
      const x = d === 1 ? i : width - 1 - i;
      const p = y * width + x;
      const old = lum[p];
      const next = old < threshold ? 0 : 255;
      lum[p] = next;
      const err = old - next;
      if (mode === "atkinson") {
        const e = err / 8;
        spread(x + d, y, e);
        spread(x + 2 * d, y, e);
        spread(x - d, y + 1, e);
        spread(x, y + 1, e);
        spread(x + d, y + 1, e);
        spread(x, y + 2, e);
      } else if (mode === "floyd") {
        spread(x + d, y, (err * 7) / 16);
        spread(x - d, y + 1, (err * 3) / 16);
        spread(x, y + 1, (err * 5) / 16);
        spread(x + d, y + 1, err / 16);
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

export type Enhance = {
  /** Stretch the darkest and brightest 1% to black and white, so dull pictures use the full range. */
  levels?: boolean;
  /** S-curve strength: 0 leaves mid-tones alone, 1 pushes them hard towards black or white. */
  contrast?: number;
  /** Unsharp mask amount: edges and thin lines survive dithering instead of dissolving into dots. */
  sharpen?: number;
};

/**
 * Get a picture ready for 1 bit, in place, before `dither`: grey levels stretched,
 * contrast raised, edges sharpened. Meant for photos and logos, not for text or line art,
 * which already threshold cleanly.
 */
export function enhance(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  { levels = true, contrast = 0.5, sharpen = 1 }: Enhance = {},
): Uint8ClampedArray {
  const n = width * height;
  let lum = new Float32Array(n);
  for (let i = 0, p = 0; p < n; i += 4, p++) {
    const a = rgba[i + 3] / 255;
    lum[p] = (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) * a + 255 * (1 - a);
  }

  if (levels) {
    const hist = new Uint32Array(256);
    for (const v of lum) hist[Math.round(v)]++;
    const at = (q: number) => {
      for (let v = 0, seen = 0; v < 256; v++) if ((seen += hist[v]) >= q * n) return v;
      return 255;
    };
    const lo = at(0.01);
    const hi = at(0.99);
    // A nearly flat picture (a blank card) has nothing to stretch.
    if (hi - lo > 24) for (let p = 0; p < n; p++) lum[p] = ((lum[p] - lo) / (hi - lo)) * 255;
  }

  if (contrast > 0) {
    for (let p = 0; p < n; p++) {
      const t = Math.min(1, Math.max(0, lum[p] / 255));
      const s = t * t * (3 - 2 * t); // smoothstep: the S-curve
      lum[p] = (t + (s - t) * contrast * 2) * 255;
    }
  }

  if (sharpen > 0) {
    // Unsharp mask over a 3×3 blur: push each pixel away from its neighbourhood.
    const out = new Float32Array(n);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            sum += lum[yy * width + xx];
            count++;
          }
        }
        const p = y * width + x;
        out[p] = lum[p] + sharpen * (lum[p] - sum / count);
      }
    }
    lum = out;
  }

  for (let i = 0, p = 0; p < n; i += 4, p++) {
    rgba[i] = rgba[i + 1] = rgba[i + 2] = lum[p];
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
