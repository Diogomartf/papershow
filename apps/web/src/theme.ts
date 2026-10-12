import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

/** From public/lights.js, which sets the theme before first paint. */
type Lights = {
  KEY: string;
  sun: (t: number) => { rise: number; set: number };
  auto: (t: number) => Theme;
  nextChange: (t: number) => number;
  held: (t: number) => Theme | null;
  current: (t: number) => Theme;
};
const lights = () => (window as unknown as { papershowLights: Lights }).papershowLights;

const apply = (theme: Theme, animate: boolean) => {
  if (document.documentElement.dataset.theme === theme) return;
  const set = () => {
    document.documentElement.dataset.theme = theme;
  };
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (animate && document.startViewTransition && !reduce) document.startViewTransition(set);
  else set();
};

/**
 * Lights follow the sun: bright by day, dimmed after sunset.
 * A flip of the switch holds until the next sunrise or sunset.
 */
export function useLights() {
  const [theme, setTheme] = useState<Theme>(() => lights().current(Date.now()));
  const [nextAt, setNextAt] = useState(() => lights().nextChange(Date.now()));
  // True while a flip overrides the sun.
  const [held, setHeld] = useState(() => lights().held(Date.now()) !== null);

  useEffect(() => {
    let timer = 0;
    const check = () => {
      const now = Date.now();
      const next = lights().current(now);
      apply(next, true);
      setTheme(next);
      setNextAt(lights().nextChange(now));
      setHeld(lights().held(now) !== null);
      clearTimeout(timer);
      // Look again at sunrise or sunset (and at least hourly, in case the computer slept).
      timer = window.setTimeout(check, Math.min(lights().nextChange(now) - now + 1000, 36e5));
    };
    check();
    // Other tabs, and coming back to a tab that slept through sunset.
    const onStorage = (e: StorageEvent) => e.key === lights().KEY && check();
    addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearTimeout(timer);
      removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);

  const flip = () => {
    const now = Date.now();
    const next: Theme = theme === "dark" ? "light" : "dark";
    try {
      // Back to what the sun says: nothing to hold.
      if (next === lights().auto(now)) localStorage.removeItem(lights().KEY);
      else localStorage.setItem(lights().KEY, JSON.stringify({ theme: next, until: lights().nextChange(now) }));
    } catch {
      /* private mode: still flips, just won't remember */
    }
    apply(next, true);
    setTheme(next);
    setHeld(next !== lights().auto(now));
  };

  return { theme, flip, nextAt, held };
}
