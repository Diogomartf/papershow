import { useRef, useState } from "react";
import type { Sleep } from "./slides";

/** Today as 'YYYY-MM-DD', local time, for the date input's minimum. */
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const when = (t: number) =>
  new Date(t).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function PowerIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M12 3v8" />
      <path d="M6.6 6.6a7.5 7.5 0 1 0 10.8 0" />
    </svg>
  );
}

/**
 * Turning the panel off, for a holiday or a weekend out. Off takes a press and hold, so a stray tap on a
 * phone can't do it; on is one press. `back` is when it's due back on by itself, if a date is set.
 */
export function Power({ sleep, back, onChange }: { sleep: Sleep; back: number | null; onChange: (p: Partial<Sleep>) => void }) {
  const [holding, setHolding] = useState(false);
  // Keyboard holds repeat keydown; only the first starts the hold.
  const held = useRef(false);
  const start = () => {
    if (held.current) return;
    held.current = true;
    setHolding(true);
  };
  const stop = () => {
    held.current = false;
    setHolding(false);
  };

  if (sleep.away) {
    return (
      <div className="power" data-off>
        <button className="power-btn" onClick={() => onChange({ away: false, back: null })} aria-label="Turn the panel on">
          <PowerIcon />
        </button>
        <div className="power-text">
          <strong>Off</strong>
          <small>{back ? `Turns on by itself ${when(back)}.` : "Cleaned to white and unpowered, until you turn it on."}</small>
        </div>
        <label className="power-back">
          <span>Back on</span>
          <input type="date" min={today()} value={sleep.back ?? ""} onChange={(e) => onChange({ back: e.target.value || null })} />
        </label>
      </div>
    );
  }

  return (
    <div className="power">
      <button
        className="power-btn"
        data-holding={holding}
        aria-label="Hold to turn the panel off"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          start();
        }}
        onPointerUp={stop}
        onPointerCancel={stop}
        onKeyDown={(e) => (e.key === " " || e.key === "Enter") && (e.preventDefault(), start())}
        onKeyUp={stop}
        onContextMenu={(e) => e.preventDefault()}
      >
        <svg className="power-ring" viewBox="0 0 60 60" aria-hidden>
          <circle
            cx="30"
            cy="30"
            r="28"
            pathLength="1"
            onAnimationEnd={() => {
              stop();
              onChange({ away: true });
            }}
          />
        </svg>
        <PowerIcon />
      </button>
      <div className="power-text">
        <strong>{holding ? "Keep holding…" : "Hold to turn off"}</strong>
        <small className="muted">For a holiday or a weekend out. The panel is cleaned to white and left unpowered.</small>
      </div>
    </div>
  );
}
