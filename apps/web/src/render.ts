import { toSvg } from "drawesome";
import { dither, enhance, pack1bpp, TEXT_FONT, TEXT_LINE, type Scene, type TextItem } from "@papershow/scene";

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

/** The scene as pixels. For the panel (`mono`), a photo is tuned for 1 bit before the ink goes on top. */
async function sceneToCanvas(scene: Scene, mono = false): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  canvas.width = scene.width;
  canvas.height = scene.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  if (scene.photo) {
    ctx.drawImage(await loadImage(scene.photo), 0, 0, scene.width, scene.height);
    if (mono) {
      const data = ctx.getImageData(0, 0, scene.width, scene.height);
      enhance(data.data, scene.width, scene.height);
      ctx.putImageData(data, 0, 0);
    }
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

/** A picked photo, cropped to fill the panel, small enough to keep in the scene. */
export async function photoFor(file: Blob, w: number, h: number): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.max(w / bmp.width, h / bmp.height);
  const sw = w / scale;
  const sh = h / scale;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0, 0, w, h);
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

const toBlob = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encode failed"))), "image/png"),
  );

/** Everything SlideGen stores: colour PNG, 1-bit PNG, and the panel's raw 1bpp frame. */
export async function renderScene(scene: Scene): Promise<{ png: Blob; mono: Blob; bin: Blob }> {
  const png = await toBlob(await sceneToCanvas(scene));
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
