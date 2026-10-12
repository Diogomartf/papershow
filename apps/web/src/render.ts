import { toSvg } from "drawesome";
import { dither, pack1bpp, TEXT_FONT, TEXT_LINE, type Scene, type TextItem } from "@papershow/scene";

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

async function sceneToCanvas(scene: Scene): Promise<HTMLCanvasElement> {
  const svg = toSvg(scene.strokes, scene.width, scene.height, scene.background);
  const img = new Image();
  img.src = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    await img.decode();
  } finally {
    URL.revokeObjectURL(img.src);
  }
  const canvas = document.createElement("canvas");
  canvas.width = scene.width;
  canvas.height = scene.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, scene.width, scene.height);
  if (scene.texts?.length) await drawTexts(ctx, scene.texts);
  return canvas;
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
  const monoCanvas = toMono(await sceneToCanvas(scene));
  const mono = await toBlob(monoCanvas);
  const pixels = monoCanvas.getContext("2d")!.getImageData(0, 0, scene.width, scene.height).data;
  const bin = new Blob([pack1bpp(pixels, scene.width, scene.height)], { type: "application/octet-stream" });
  return { png, mono, bin };
}

/** For the live e-ink preview: paint the dithered scene onto an existing canvas. */
export async function paintMono(scene: Scene, target: HTMLCanvasElement) {
  const mono = toMono(await sceneToCanvas(scene));
  target.width = scene.width;
  target.height = scene.height;
  target.getContext("2d")!.drawImage(mono, 0, 0);
}
