// Sorting a list by dragging, with a mouse or a finger. The browser's own drag and drop doesn't work with touch, so
// this follows the pointer itself: the item lifts into a floating copy under the pointer, a ghost marks where it
// will land, and the new order is handed over when it's let go.

import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { cue } from "./sound";

type Lift = { group: string; id: string; ids: string[]; width: number; height: number; landed: boolean };

type Press = {
  group: string;
  id: string;
  ids: string[];
  el: HTMLElement;
  x: number;
  y: number;
  /** The pointer now, to place the floating copy as soon as it mounts. */
  cx: number;
  cy: number;
  /** Where in the item it was grabbed, so it doesn't jump to the pointer's corner. */
  offX: number;
  offY: number;
  /** Lifts once it moves; otherwise a finger lifts after a short press, so a swipe still scrolls. */
  eager: boolean;
  live: boolean;
  timer?: number;
};

/**
 * Drag to sort within a group (one list). Spread `bind(group, id, ids)` on each item, render `order(group, ids)`,
 * draw a ghost in place of `lifted.id`, and give the floating copy `ref={float}`. `onDrop` gets the new order
 * when it changed; the list keeps it until that settles, so nothing jumps back and forth.
 * An element inside an item with `data-sort-handle` picks it up at once, even by touch: give it `touch-action: none`.
 */
export function useSortable(onDrop: (group: string, ids: string[]) => Promise<unknown>) {
  const press = useRef<Press | null>(null);
  const [lift, setLiftState] = useState<Lift | null>(null);
  // The window listeners outlive a render, so they read the lift from here.
  const liftNow = useRef(lift);
  const setLift = (l: Lift | null) => {
    liftNow.current = l;
    setLiftState(l);
  };
  const float = useRef<HTMLElement | null>(null);
  const place = () => {
    const p = press.current;
    if (p && float.current) float.current.style.transform = `translate(${p.cx - p.offX}px, ${p.cy - p.offY}px)`;
  };

  const pickUp = () => {
    const p = press.current;
    if (!p) return;
    p.live = true;
    const r = p.el.getBoundingClientRect();
    p.offX = p.x - r.left;
    p.offY = p.y - r.top;
    setLift({ group: p.group, id: p.id, ids: p.ids, width: r.width, height: r.height, landed: false });
    navigator.vibrate?.(10);
    cue("select");
  };

  useEffect(() => {
    const onMove = (ev: globalThis.PointerEvent) => {
      const p = press.current;
      if (!p) return;
      p.cx = ev.clientX;
      p.cy = ev.clientY;
      if (!p.live) {
        const far = Math.hypot(ev.clientX - p.x, ev.clientY - p.y);
        if (p.eager && far > 6) pickUp();
        else if (!p.eager && far > 10) {
          // Moving before the press is long enough: a scroll, not a drag.
          clearTimeout(p.timer);
          press.current = null;
        }
        return;
      }
      place();
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-sort-id]");
      const l = liftNow.current;
      if (!l || !over || over.dataset.sortGroup !== l.group || over.dataset.sortId === l.id) return;
      const ids = l.ids.filter((x) => x !== l.id);
      ids.splice(l.ids.indexOf(over.dataset.sortId!), 0, l.id);
      setLift({ ...l, ids });
    };
    const onUp = () => {
      const p = press.current;
      if (!p) return;
      clearTimeout(p.timer);
      if (!p.live) return void (press.current = null);
      const l = liftNow.current;
      if (l && l.ids.join() !== p.ids.join()) {
        cue(["tap", { emphasis: "strong" }]);
        setLift({ ...l, landed: true });
        onDrop(l.group, l.ids).finally(() => setLift(null));
      } else {
        cue(["close", { emphasis: "subtle" }]);
        setLift(null);
      }
      // Let the click that ends a drag pass by before forgetting it, so it doesn't open the item.
      setTimeout(() => (press.current = null));
    };
    // While something is lifted, a finger moves it instead of the page.
    const onTouch = (ev: TouchEvent) => {
      if (press.current?.live) ev.preventDefault();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("touchmove", onTouch, { passive: false });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("touchmove", onTouch);
    };
  });

  const bind = (group: string, id: string, ids: string[]) => ({
    "data-sort-group": group,
    "data-sort-id": id,
    onPointerDown: (ev: PointerEvent<HTMLElement>) => {
      if (ev.button !== 0 || liftNow.current) return;
      const eager = ev.pointerType === "mouse" || !!(ev.target as HTMLElement).closest("[data-sort-handle]");
      const p: Press = { group, id, ids, el: ev.currentTarget, x: ev.clientX, y: ev.clientY, cx: ev.clientX, cy: ev.clientY, offX: 0, offY: 0, eager, live: false };
      press.current = p;
      if (!eager) p.timer = window.setTimeout(pickUp, 300);
    },
    // A press and hold would otherwise open the browser's menu for the picture.
    onContextMenu: (ev: MouseEvent) => ev.preventDefault(),
    onClickCapture: (ev: MouseEvent) => {
      if (press.current?.live) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    },
  });

  return {
    /** What's being dragged, while it is: draw a ghost in its place and the floating copy. */
    lifted: lift && !lift.landed ? lift : null,
    /** `ids` in the order being dragged into. */
    order: (group: string, ids: string[]) => (lift?.group === group ? lift.ids : ids),
    bind,
    /** The ref for the floating copy: it follows the pointer without re-rendering the page. */
    float: (el: HTMLElement | null) => {
      float.current = el;
      place();
    },
  };
}
