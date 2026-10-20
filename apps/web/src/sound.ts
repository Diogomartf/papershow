// Interaction sounds, from cuelume: synthesized as they play, no audio files.
// Every control sounds without being marked up: just before cuelume hears a press, `mark` gives the control the cue
// its job calls for, read from what it already says it is (a switch, a tab, a menu, a link, a danger button).
// Mark a control yourself (`data-cuelume-open`, …) to choose its cue, or `data-quiet` to play something in its handler instead.
// Outcomes (saved, on the panel, errors, someone at the door) play from where they happen, with `cue`.
import { useSyncExternalStore } from "react";
import { bind, play, setEnabled, setVolume, unlock, type PlayOptions, type SoundName } from "cuelume";

const KEY = "papershow-sound";
const VOLUME_KEY = "papershow-sound-volume";
const CHANGED = "papershow:sound";

/** Sound is a setting of this device, like the lights: on unless switched off here. */
export function soundOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSound(on: boolean) {
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "off");
  } catch {
    // Private mode: it still switches, just isn't remembered.
  }
  setEnabled(on);
  dispatchEvent(new Event(CHANGED));
  // Switching on is a click, the gesture browsers want before they let a page make sound.
  if (on) unlock().then((ok) => ok && play("toggle"));
}

/** How loud, from 0 to 1, on this device: full unless turned down here. */
export function soundVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY) ?? 1);
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  } catch {
    return 1;
  }
}

/** Turn it up or down; each step plays at the new level, so you hear where it is. */
export function setSoundVolume(v: number) {
  const down = v < soundVolume();
  try {
    if (v >= 1) localStorage.removeItem(VOLUME_KEY);
    else localStorage.setItem(VOLUME_KEY, String(v));
  } catch {
    // Private mode: it still changes, just isn't remembered.
  }
  setVolume(v);
  dispatchEvent(new Event(CHANGED));
  play("select", { emphasis: "subtle", direction: down ? "back" : "forward" });
}

const onChange = (l: () => void) => {
  addEventListener(CHANGED, l);
  // Another tab changed it.
  const storage = (e: StorageEvent) =>
    (e.key === KEY || e.key === VOLUME_KEY) && (setEnabled(soundOn()), setVolume(soundVolume()), l());
  addEventListener("storage", storage);
  return () => (removeEventListener(CHANGED, l), removeEventListener("storage", storage));
};

export const useSound = () => useSyncExternalStore(onChange, soundOn);
export const useSoundVolume = () => useSyncExternalStore(onChange, soundVolume);

/** A cue, with how much it matters: a name, or a name and its options. */
export type Cue = SoundName | [SoundName, PlayOptions];

/** Something done: saved, added, asked. */
export const DONE: Cue = ["success", { emphasis: "subtle" }];
/** Something of yours went on the panel: the moment the whole app is for. */
export const ON_AIR: Cue = ["success", { emphasis: "strong" }];

/** Play the sound of an outcome: saved, on the panel, refused. */
export function cue(c: Cue | null | undefined) {
  if (!c) return;
  if (typeof c === "string") play(c);
  else play(c[0], c[1]);
}

const CLICKS = [
  "button",
  "a[href]",
  "summary",
  "label",
  "select",
  "textarea",
  "[contenteditable]",
  'input:not([type="hidden"])',
  "[role=button]",
  "[role=switch]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=tab]",
  "[role=option]",
  "[role^=menuitem]",
].join(",");
const TYPING = "textarea, [contenteditable]:not([contenteditable=false]), input";
const KINDS = ["tap", "type", "select", "toggle", "open", "close", "navigate"].map((k) => `data-cuelume-${k}`);
const AUTO = "data-sound-auto";

/** The cue a control's job calls for, from what it already says about itself. */
function cueFor(el: Element): [attr: string, emphasis?: "subtle" | "strong"] | null {
  const role = el.getAttribute("role");
  const type = el instanceof HTMLInputElement ? el.type : null;
  if (type === "file" || type === "submit" || type === "button") return ["tap", "subtle"];
  if (type === "checkbox" || role === "switch" || role === "checkbox" || role === "menuitemcheckbox" || el.hasAttribute("aria-pressed"))
    return ["toggle"];
  if (type === "radio" || type === "range" || el.tagName === "SELECT") return ["select", type === "range" ? "subtle" : undefined];
  if (el.matches(TYPING)) return ["type"];
  if (role === "radio" || role === "tab" || role === "option" || role === "menuitemradio") return ["select"];
  if (el.classList.contains("danger")) return ["close", "strong"];
  if (role === "menuitem") return ["select"];
  if (el.getAttribute("aria-expanded") === "true") return ["close", "subtle"];
  if (el.hasAttribute("aria-expanded") || el.hasAttribute("aria-haspopup")) return ["open", "subtle"];
  if (el.hasAttribute("download")) return ["tap"];
  if (el.tagName === "A") return ["navigate"];
  if (el.classList.contains("primary")) return ["tap"];
  return ["tap", "subtle"];
}

/** Give the control under an event its cue, unless it chose its own. Runs again each time: a menu that's open closes. */
function mark(e: Event) {
  if (!(e.target instanceof Element)) return;
  let el = e.target.closest(CLICKS);
  if (el instanceof HTMLLabelElement) el = el.control;
  if (!el) return;
  const auto = el.hasAttribute(AUTO);
  if (!auto && KINDS.some((k) => el.hasAttribute(k))) return;
  for (const k of KINDS) el.removeAttribute(k);
  el.removeAttribute("data-cuelume-emphasis");
  el.removeAttribute(AUTO);
  const found = el.closest("[data-quiet]") ? null : cueFor(el);
  if (!found) return;
  el.setAttribute(`data-cuelume-${found[0]}`, "");
  if (found[1]) el.setAttribute("data-cuelume-emphasis", found[1]);
  el.setAttribute(AUTO, "");
}

let started = false;

/** Once, as the page starts. Sound plays from the first press; browsers keep it quiet until then. */
export function startSound() {
  if (started) return;
  started = true;
  setEnabled(soundOn());
  setVolume(soundVolume());
  // On the window, so it runs before cuelume, which listens on the document.
  for (const type of ["pointerdown", "keydown", "focusin"]) addEventListener(type, mark, { capture: true });
  bind();
}
