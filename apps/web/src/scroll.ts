import { useEffect, useState, type RefObject } from "react";

/**
 * Horizontal scrolling without a scrollbar: the wheel scrolls sideways, and
 * `edges` says which sides have more to show so the container can fade them.
 * Pinch (or ⌘/Ctrl + wheel) calls `onZoom` instead of zooming the page.
 */
export function useSideScroll(ref: RefObject<HTMLElement | null>, onZoom?: (dir: 1 | -1) => void) {
  const [edges, setEdges] = useState({ start: false, end: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const max = el.scrollWidth - el.clientWidth;
      setEdges({ start: el.scrollLeft > 1, end: el.scrollLeft < max - 1 });
    };

    let pinch = 0;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        if (!onZoom) return;
        e.preventDefault();
        pinch += e.deltaY;
        if (Math.abs(pinch) > 24) {
          onZoom(pinch < 0 ? 1 : -1);
          pinch = 0;
        }
        return;
      }
      // A vertical wheel means "move along"; trackpads already send deltaX.
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };

    measure();
    el.addEventListener("scroll", measure, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: false });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", measure);
      el.removeEventListener("wheel", onWheel);
      ro.disconnect();
    };
  }, [ref, onZoom]);

  return edges;
}
