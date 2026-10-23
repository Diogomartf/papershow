// The town a photo was taken in, from where its camera says it was: OpenStreetMap's Nominatim, which needs no key.
// Its policy is at most one request a second with an identifying User-Agent, so photos are named one after another,
// each point once, and the names are kept in the database.
import * as store from "./db.ts";

const AGENT = "Papershow (self-hosted e-ink photo frame; https://github.com/Diogomartf/papershow)";
const GAP_MS = 1100;

/** Points Nominatim had no name for: asking again won't change that. */
const nameless = new Set<string>();
const key = (p: { lat: number; lon: number }) => `${p.lat},${p.lon}`;
let running = false;

type Reverse = { address?: Record<string, string>; name?: string };

/** The town or city, or the nearest thing to one out in the country. */
async function lookUp(lat: number, lon: number): Promise<string | null> {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=en&lat=${lat}&lon=${lon}`;
  const res = await fetch(url, { headers: { "User-Agent": AGENT }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`nominatim → ${res.status}`);
  const json = (await res.json()) as Reverse;
  const a = json.address ?? {};
  return a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? a.state ?? a.country ?? json.name ?? null;
}

/**
 * Name every photo that says where it was taken and isn't named yet, in the background. `named` runs after each
 * new name, so what shows places can redraw. A failure stops the round; the next call tries again.
 */
export function namePlaces(named: () => void) {
  if (running) return;
  running = true;
  void (async () => {
    try {
      for (;;) {
        const next = store.unnamedPlaces().find((p) => !nameless.has(key(p)));
        if (!next) break;
        const name = await lookUp(next.lat, next.lon);
        if (name) {
          store.namePlace(next.lat, next.lon, name);
          named();
        } else nameless.add(key(next));
        await new Promise((r) => setTimeout(r, GAP_MS));
      }
    } catch (err) {
      console.warn(`places: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  })();
}
