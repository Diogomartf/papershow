import { useEffect, useState } from "react";

/** Phone-sized screens, where the layout stacks into one column. Matches the CSS breakpoint. */
const NARROW = "(max-width: 720px)";

export function useNarrow() {
  const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches);
  useEffect(() => {
    const mq = matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}
