// The sound of drawing: each pen scratches, hisses or swishes in its own way while it moves, and goes quiet when it stops.
// cuelume plays one-off cues, not a sound that follows a hand, so this is its own small Web Audio graph:
// a loop of noise through the pen's bands, louder the faster the pen moves. It follows the sound setting and volume.
import { soundOn, soundVolume } from "./sound";

/**
 * The noise a pen starts from. Smooth is plain hiss, for felt and ink gliding. Grainy comes in bursts of random length
 * and loudness, for a nib catching. Tooth is a faint hiss with sharp ticks scattered through it: graphite catching on
 * the fibres of the paper.
 */
type Grain = "smooth" | "grainy" | "tooth";

/** One band the noise rings in, and how much of it is heard. */
type Band = { type: BiquadFilterType; hz: number; q: number; gain?: number };

/** How a pen sounds: the noise it starts from, the bands it rings in, and how loud it gets at full speed. */
type Voice = { grain: Grain; bands: Band[]; level: number };

// Keyed by the names drawesome gives its tools, which are what the toolbar's buttons are labelled with.
const VOICES: Record<string, Voice> = {
  // A dry scratch: the ticks carry it, a low band gives the wood and paper some body, a little fizz on top.
  Pencil: {
    grain: "tooth",
    bands: [
      { type: "bandpass", hz: 2400, q: 0.8 },
      { type: "bandpass", hz: 900, q: 1.2, gain: 0.5 },
      { type: "highpass", hz: 7000, q: 0.7, gain: 0.15 },
    ],
    level: 0.55,
  },
  Pen: { grain: "smooth", bands: [{ type: "bandpass", hz: 2200, q: 1.6 }], level: 0.3 },
  // A felt tip gliding: a soft, narrowish band in the middle with a little body under it, and no hiss above.
  Fineliner: {
    grain: "smooth",
    bands: [
      { type: "bandpass", hz: 3000, q: 1.4 },
      { type: "bandpass", hz: 1100, q: 1, gain: 0.35 },
    ],
    level: 0.25,
  },
  Marker: { grain: "smooth", bands: [{ type: "bandpass", hz: 1300, q: 2.5 }], level: 0.4 },
  Highlighter: { grain: "smooth", bands: [{ type: "lowpass", hz: 1600, q: 0.7 }], level: 0.35 },
  Brush: { grain: "smooth", bands: [{ type: "lowpass", hz: 700, q: 0.5 }], level: 0.5 },
  "Fountain Pen": { grain: "grainy", bands: [{ type: "bandpass", hz: 2800, q: 5 }], level: 0.35 },
  Eraser: { grain: "grainy", bands: [{ type: "bandpass", hz: 450, q: 1 }], level: 0.7 },
};

let ctx: AudioContext | null = null;
const buffers = new Map<Grain, AudioBuffer>();

/** Two seconds of the pen's noise, made once. */
function noise(c: AudioContext, grain: Grain): AudioBuffer {
  let b = buffers.get(grain);
  if (b) return b;
  b = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
  const data = b.getChannelData(0);
  const ms = c.sampleRate / 1000;
  if (grain === "tooth") {
    // Ticks a fraction of a millisecond long, at irregular gaps, so nothing repeats often enough to hum.
    let next = 0;
    let tick = 0;
    for (let i = 0; i < data.length; i++) {
      if (i >= next) {
        tick = 0.3 + 0.7 * Math.random() ** 2;
        next = i + Math.round(ms * (0.4 + 3 * Math.random()));
      }
      tick *= 0.9;
      data[i] = (Math.random() * 2 - 1) * (0.12 + tick);
    }
  } else if (grain === "grainy") {
    // Bursts of 1–6 ms. The loudness glides to each new one: a step would click, and steps at a fixed rate would hum.
    let next = 0;
    let target = 1;
    let amp = 1;
    for (let i = 0; i < data.length; i++) {
      if (i >= next) {
        target = Math.random() ** 3;
        next = i + Math.round(ms * (1 + 5 * Math.random()));
      }
      amp += (target - amp) * 0.02;
      data[i] = (Math.random() * 2 - 1) * amp;
    }
  } else {
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  buffers.set(grain, b);
  return b;
}

/** The pen in hand, read off the toolbar: the pressed button with a tool's name. */
function penIn(root: HTMLElement): Voice | null {
  for (const b of root.querySelectorAll('[class*="Draw_toolbar"] [aria-pressed="true"]')) {
    const v = VOICES[b.getAttribute("aria-label") ?? ""];
    if (v) return v;
  }
  return null;
}

type Stroke = { id: number; gain: GainNode; filters: BiquadFilterNode[]; src: AudioBufferSourceNode; voice: Voice; x: number; y: number; t: number; speed: number };

/** Sound the pens on the drawing under `root`. Returns the way to stop. */
export function inkSounds(root: HTMLElement): () => void {
  let stroke: Stroke | null = null;

  const down = (e: PointerEvent) => {
    if (stroke || !soundOn() || !(e.target as Element).closest?.('[class*="Draw_surface"]')) return;
    const voice = penIn(root);
    if (!voice) return;
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const src = new AudioBufferSourceNode(ctx, { buffer: noise(ctx, voice.grain), loop: true });
    const gain = new GainNode(ctx, { gain: 0 });
    gain.connect(ctx.destination);
    const filters = voice.bands.map((band) => {
      const f = new BiquadFilterNode(ctx!, { type: band.type, frequency: band.hz, Q: band.q });
      src.connect(f).connect(new GainNode(ctx!, { gain: band.gain ?? 1 })).connect(gain);
      return f;
    });
    // Start somewhere new in the loop each time, so two strokes don't sound the same.
    src.start(0, Math.random() * 2);
    stroke = { id: e.pointerId, gain, filters, src, voice, x: e.clientX, y: e.clientY, t: e.timeStamp, speed: 0 };
  };

  const move = (e: PointerEvent) => {
    if (!stroke || !ctx || e.pointerId !== stroke.id) return;
    const dt = Math.max(1, e.timeStamp - stroke.t);
    const speed = Math.hypot(e.clientX - stroke.x, e.clientY - stroke.y) / dt;
    stroke.speed = stroke.speed * 0.7 + speed * 0.3;
    Object.assign(stroke, { x: e.clientX, y: e.clientY, t: e.timeStamp });
    // Fast strokes are louder and a little brighter; a pen held still is silent.
    const fast = Math.min(1, stroke.speed / 1.5);
    const now = ctx.currentTime;
    stroke.gain.gain.setTargetAtTime(fast * stroke.voice.level * soundVolume(), now, 0.03);
    stroke.voice.bands.forEach((band, i) => stroke!.filters[i].frequency.setTargetAtTime(band.hz * (0.85 + 0.3 * fast), now, 0.05));
    // Moving faster over the paper's grain packs the ticks closer, as a real pen does.
    stroke.src.playbackRate.setTargetAtTime(0.75 + 0.5 * fast, now, 0.05);
  };

  const up = (e: PointerEvent) => {
    if (!stroke || !ctx || e.pointerId !== stroke.id) return;
    stroke.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.04);
    stroke.src.stop(ctx.currentTime + 0.3);
    stroke = null;
  };

  root.addEventListener("pointerdown", down, true);
  addEventListener("pointermove", move, true);
  addEventListener("pointerup", up, true);
  addEventListener("pointercancel", up, true);
  return () => {
    root.removeEventListener("pointerdown", down, true);
    removeEventListener("pointermove", move, true);
    removeEventListener("pointerup", up, true);
    removeEventListener("pointercancel", up, true);
    if (stroke) stroke.src.stop();
    stroke = null;
  };
}
