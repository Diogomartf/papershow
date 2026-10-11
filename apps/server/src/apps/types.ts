import type { DitherMode } from "@papershow/scene";
import type { JSX } from "#jsx/jsx-runtime";

/** One setting in an app's form. The Apps page builds its UI from these. */
export type Field =
  | { key: string; label: string; type: "text"; placeholder?: string; hint?: string }
  | { key: string; label: string; type: "toggle"; hint?: string }
  | { key: string; label: string; type: "select"; options: { value: string; label: string }[]; hint?: string }
  /** Comma-separated in the form, an array in the config. */
  | { key: string; label: string; type: "list"; placeholder?: string; hint?: string };

export type AppDef<C extends Record<string, unknown>, D> = {
  kind: string;
  name: string;
  description: string;
  defaults: C;
  fields: Field[];
  /** The frame can change at most this often; renders are cached per period, aligned to the clock. */
  periodMs: number;
  /** True while `data` returns made-up numbers instead of calling a real source. */
  mock: boolean;
  data(config: C, now: Date): D | Promise<D>;
  view(props: { config: C; data: D; now: Date }): JSX.Element;
  /** Vector art thresholds cleanly; photos want dithering. */
  dither?: DitherMode;
};

export const defineApp = <C extends Record<string, unknown>, D>(def: AppDef<C, D>) => def;

/** Every app draws on the panel's 800×480 white sheet in black. */
export const sheet = {
  width: 800,
  height: 480,
  display: "flex",
  background: "#fff",
  color: "#000",
  fontFamily: "Inter",
  // satori defaults to content-box: without this, padding grows the sheet past the panel.
  boxSizing: "border-box",
} as const;

// ── Helpers shared by apps ─────────────────────────────────────────────────

/** Wall-clock parts in a time zone (falls back to the server's if the zone is unknown). */
export function clockParts(now: Date, timeZone: string, hour12 = false) {
  const zone = isZone(timeZone) ? timeZone : undefined;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hour12,
      weekday: "long",
      day: "numeric",
      month: "long",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    hour: parts.hour as string,
    minute: parts.minute as string,
    period: (parts.dayPeriod as string | undefined)?.toUpperCase(),
    date: `${parts.weekday}, ${parts.day} ${parts.month}`,
  };
}

export function isZone(tz: string) {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Smooth, repeatable wobble in [-1, 1] for mock data: the same seed and time
 * always give the same value, so every client sees the same "price".
 */
export function wobble(seed: string, t: number) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) | 0;
  const p = (h % 1000) / 1000;
  return (Math.sin(t / 7 + p * 6.28) * 0.6 + Math.sin(t / 2.3 + p * 12.1) * 0.3 + Math.sin(t / 0.9 + p * 3.7) * 0.1);
}

export const money = (n: number, currency = "USD") =>
  n.toLocaleString("en-US", { style: "currency", currency, maximumFractionDigits: n < 1 ? 4 : 2 });
