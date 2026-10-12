import { useCallback, useEffect, useRef, useState } from "react";

type Toast = { msg: string; undo?: () => void };

/** A status toast that can carry an Undo button for a few seconds. */
export function useUndoToast() {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback((msg: string, undo?: () => void) => {
    clearTimeout(timer.current);
    setToast({ msg, undo });
    timer.current = window.setTimeout(() => setToast(null), undo ? 6000 : 2400);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  const node = (
    <div className="toast" data-on={!!toast} role="status">
      {toast?.msg}
      {toast?.undo && (
        <button
          className="toast-undo"
          onClick={() => {
            toast.undo!();
            setToast(null);
          }}
        >
          Undo
        </button>
      )}
    </div>
  );
  return { show, node };
}

/**
 * A small menu floating above an element. Fixed-positioned so it escapes
 * scrolling containers; follows the anchor when they scroll.
 */
export function FloatingMenu({
  anchor,
  children,
  onClose,
  keepOpenWithin,
}: {
  anchor: HTMLElement | null;
  children: React.ReactNode;
  onClose: () => void;
  /** A selector for other places a click shouldn't close it, such as the selected clip's own settings. */
  keepOpenWithin?: string;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const self = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      setPos({ x: r.left + r.width / 2, y: r.top });
    };
    place();
    addEventListener("scroll", place, true);
    addEventListener("resize", place);
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (self.current?.contains(t) || anchor.contains(t)) return;
      if (keepOpenWithin && t instanceof Element && t.closest(keepOpenWithin)) return;
      onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("pointerdown", away);
    addEventListener("keydown", esc);
    return () => {
      removeEventListener("scroll", place, true);
      removeEventListener("resize", place);
      removeEventListener("pointerdown", away);
      removeEventListener("keydown", esc);
    };
  }, [anchor, onClose, keepOpenWithin]);

  if (!anchor || !pos) return null;
  return (
    <div ref={self} className="float-menu" role="menu" style={{ left: pos.x, top: pos.y }}>
      {children}
    </div>
  );
}

// Line icons for menu items, 14px, drawn in the text colour.
const ICONS = {
  show: <><rect x="2" y="3" width="12" height="8" rx="1.5" /><path d="M6 14h4M8 11v3" /></>,
  earlier: <path d="M10 3.5 5.5 8l4.5 4.5" />,
  later: <path d="M6 3.5 10.5 8 6 12.5" />,
  open: <path d="M6 3.5h6.5V10M12.5 3.5 4 12" />,
  remove: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />,
};

/** One action in a FloatingMenu: an icon and a short label. `danger` for actions that take something away. */
export function MenuItem({
  icon,
  danger,
  children,
  ...rest
}: { icon: keyof typeof ICONS; danger?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button role="menuitem" className={danger ? "danger" : undefined} {...rest}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {ICONS[icon]}
      </svg>
      {children}
    </button>
  );
}

/** A hairline between groups, so a destructive action sits apart. */
export const MenuDivider = () => <span className="float-menu-divider" role="separator" />;
