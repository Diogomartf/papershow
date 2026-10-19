import { toSvg } from "drawesome";
import { dither, enhance, pack1bpp, PANEL, PHOTO_FILL, photoSize, TEXT_FONT, TEXT_LINE, type Scene, type TextItem } from "@papershow/scene";

const fontOf = (t: TextItem) => `${t.bold ? 700 : 450} ${t.size}px ${TEXT_FONT}`;

/** Paint text the way the browser lays it out in the editor: the font's ascent and descent centred in each line. */
async function drawTexts(ctx: CanvasRenderingContext2D, texts: TextItem[]) {
  await Promise.all(texts.map((t) => document.fonts.load(fontOf(t), t.text)));
  ctx.textBaseline = "alphabetic";
  for (const t of texts) {
    ctx.font = fontOf(t);
    ctx.fillStyle = t.color;
    const { fontBoundingBoxAscent: asc, fontBoundingBoxDescent: desc } = ctx.measureText(t.text);
    const line = t.size * TEXT_LINE;
    const baseline = (line - (asc + desc)) / 2 + asc;
    t.text.split("\n").forEach((row, i) => ctx.fillText(row, t.x, t.y + line * i + baseline));
  }
}

const loadImage = async (src: string) => {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
};

/** The last photo, decoded. The e-ink preview repaints on every stroke, so it isn't decoded again each time. */
let lastImage: { src: string; image: Promise<HTMLImageElement> } | null = null;
/** The last photo tuned for 1 bit at the size it's drawn: kept for the same reason. */
let lastTuned: { key: string; canvas: HTMLCanvasElement } | null = null;

function photoImage(src: string) {
  if (lastImage?.src !== src) lastImage = { src, image: loadImage(src) };
  return lastImage.image;
}

/**
 * The photo at `w`×`h`, with its levels, contrast and edges tuned for 1 bit. Tuned on its own,
 * not with the paper around it: the margins of a smaller photo would throw off its levels.
 */
function tunedPhoto(img: HTMLImageElement, src: string, w: number, h: number) {
  const key = `${w}x${h} ${src}`;
  if (lastTuned?.key === key) return lastTuned.canvas;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  enhance(data.data, w, h);
  ctx.putImageData(data, 0, 0);
  lastTuned = { key, canvas };
  return canvas;
}

/** The scene as pixels. For the panel (`mono`), a photo is tuned for 1 bit before the ink goes on top. */
async function sceneToCanvas(scene: Scene, mono = false): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  canvas.width = scene.width;
  canvas.height = scene.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  if (scene.photo) {
    const img = await photoImage(scene.photo);
    const at = scene.photoAt ?? PHOTO_FILL;
    const size = photoSize(img.naturalWidth, img.naturalHeight, at);
    const w = Math.max(1, Math.round(size.w));
    const h = Math.max(1, Math.round(size.h));
    // Paper first: a photo made smaller doesn't cover it all.
    ctx.fillStyle = scene.background;
    ctx.fillRect(0, 0, scene.width, scene.height);
    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.rotate((at.angle * Math.PI) / 180);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(mono ? tunedPhoto(img, scene.photo, w, h) : img, -w / 2, -h / 2, w, h);
    ctx.restore();
  }
  // Over a photo the strokes go on without their paper.
  const svg = toSvg(scene.strokes, scene.width, scene.height, scene.photo ? null : scene.background);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    ctx.drawImage(await loadImage(url), 0, 0, scene.width, scene.height);
  } finally {
    URL.revokeObjectURL(url);
  }
  if (scene.texts?.length) await drawTexts(ctx, scene.texts);
  return canvas;
}

/**
 * A picked photo, whole, small enough to keep in the scene: its short side at most the panel's width,
 * which fills the panel whichever way it's turned.
 */
export async function photoFor(file: Blob): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, PANEL.w / Math.min(bmp.width, bmp.height), (3 * PANEL.w) / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * k);
  canvas.height = Math.round(bmp.height * k);
  const ctx = canvas.getContext("2d")!;
  // Phone photos are several times the panel's size: a plain bilinear shrink turns their detail into jaggies.
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

/** Dither a canvas in place to what the e-ink panel will show. */
function toMono(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  dither(data.data, canvas.width, canvas.height);
  ctx.putImageData(data, 0, 0);
  return canvas;
}

const toBlob = (canvas: HTMLCanvasElement, type = "image/png", quality?: number) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(`${type} encode failed`))), type, quality),
  );

/**
 * Everything SlideGen stores: the colour picture, 1-bit PNG, and the panel's raw 1bpp frame.
 * Over a photo the colour picture is a JPEG: as a PNG it's about three times the size, and it's only for looking at.
 */
export async function renderScene(scene: Scene): Promise<{ png: Blob; mono: Blob; bin: Blob }> {
  const colour = await sceneToCanvas(scene);
  const png = scene.photo ? await toBlob(colour, "image/jpeg", 0.9) : await toBlob(colour);
  const monoCanvas = toMono(await sceneToCanvas(scene, true));
  const mono = await toBlob(monoCanvas);
  const pixels = monoCanvas.getContext("2d")!.getImageData(0, 0, scene.width, scene.height).data;
  const bin = new Blob([pack1bpp(pixels, scene.width, scene.height)], { type: "application/octet-stream" });
  return { png, mono, bin };
}

/** For the live e-ink preview: paint the dithered scene onto an existing canvas. */
export async function paintMono(scene: Scene, target: HTMLCanvasElement) {
  const mono = toMono(await sceneToCanvas(scene, true));
  target.width = scene.width;
  target.height = scene.height;
  target.getContext("2d")!.drawImage(mono, 0, 0);
}
