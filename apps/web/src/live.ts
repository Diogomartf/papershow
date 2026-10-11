// Live state from the server, kept fresh by long-polling. Shared by the dashboard and playlists.
import { useCallback, useEffect, useState } from "react";
import * as api from "./slides";
import type { State } from "./slides";

/** Server state, kept fresh by long-polling; `skew` lines our clock up with the server's. */
export function useLiveState() {
  const [state, setState] = useState<State | null>(null);
  const [skew, setSkew] = useState(0);
  const accept = useCallback((s: State) => {
    setState(s);
    setSkew(s.now - Date.now());
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        accept(await api.getState());
      } catch {
        /* the loop below retries */
      }
      while (alive) {
        try {
          const s = await api.waitState();
          if (alive) accept(s);
        } catch {
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [accept]);

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

