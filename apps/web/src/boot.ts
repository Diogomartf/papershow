// What the first screen needs, asked for all at once as the page starts, so it paints once, complete,
// instead of drawing an empty layout and then jumping as each piece arrives.
import { hello, type Hello } from "./house";
import { primeState } from "./live";
import { getState } from "./slides";
import { loadItems } from "./sources";

/** The house's state and the library. Rejects when no one is signed in. */
export const loadEverything = () => Promise.all([getState().then(primeState), loadItems()]);

/** Who this device is; if they're in, everything else is fetched alongside and has arrived by the time this resolves. */
export const booting: Promise<Hello> = (() => {
  const everything = loadEverything().catch(() => null);
  return hello().then(async (h) => {
    if (h.me?.status === "in") await everything;
    return h;
  });
})();
