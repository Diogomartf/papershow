// Live state from the server, kept fresh by long-polling. Shared by the dashboard and playlists.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import * as api from "./slides";
import type { State } from "./slides";

// One long-poll per tab, shared by every component that wants live state. Browsers allow only
// six connections per host across all tabs, so a second poll per page soon starves the site.
type Snapshot = { state: State | null; skew: number };
let snap: Snapshot = { state: null, skew: 0 };
const listeners = new Set<() => void>();
let polling = false;

function publish(s: State | null) {
  snap = { state: s, skew: s ? s.now - Date.now() : snap.skew };
  for (const l of listeners) l();
}

/** Start from state fetched elsewhere (as the page boots), so the first paint already has it. */
export const primeState = (s: State) => publish(s);

async function poll() {
  polling = true;
  // Already primed at boot: go straight to waiting for changes.
  if (!snap.state)
    try {
      publish(await api.getState());
    } catch {
      /* the loop below retries */
    }
  while (listeners.size) {
    try {
      const s = await api.waitState();
      if (listeners.size) publish(s);
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  polling = false;
}

function subscribe(l: () => void) {
  listeners.add(l);
  if (!polling) void poll();
  return () => listeners.delete(l);
}

/** Server state, kept fresh by long-polling; `skew` lines our clock up with the server's. */
export function useLiveState() {
  const { state, skew } = useSyncExternalStore(subscribe, () => snap);
  const accept = useCallback((s: State) => publish(s), []);
  /** Show a local change before the server answers. */
  const setState = useCallback((s: State | null) => publish(s), []);
  return { state, setState, accept, skew };
}

export function useNow(skew: number, every = 250) {
  const [now, setNow] = useState(() => Date.now() + skew);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() + skew), every);
    return () => clearInterval(t);
  }, [skew, every]);
  return now;
}

