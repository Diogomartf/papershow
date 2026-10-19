import { useEffect, useRef, useState } from "react";
import type { Sleep } from "./slides";

const pad = (n: number) => String(n).padStart(2, "0");
const HOURS = Array.from({ length: 24 }, (_, h) => pad(h));
const MINUTES = Array.from({ length: 12 }, (_, k) => pad(k * 5));

/**
 * A time as an hour and a minute, each picked from a list: easier than the browser's time field, where the minutes
 * are fiddly to reach. It saves once you stop changing it, not on every pick, since each save makes the panel
 * look again. Minutes come in fives, plus whatever was set before.
 */
function HourInput({ value, onSave, label }: { value: string; onSave: (t: string) => void; label: string }) {
  const [text, setText] = useState(value);
  const [was, setWas] = useState(value);
  if (was !== value) {
    setWas(value);
    setText(value);
  }
  const timer = useRef<number | undefined>(undefined);
  // What's waiting to be saved, so closing the settings first still saves it.
  const pending = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      pending.current?.();
    },
    [],
  );
  const [h, m] = text.split(":");
  const pick = (t: string) => {
    setText(t);
    clearTimeout(timer.current);
    pending.current = t === value ? null : () => onSave(t);
    timer.current = window.setTimeout(() => {
      pending.current?.();
      pending.current = null;
    }, 800);
  };
  const minutes = MINUTES.includes(m) ? MINUTES : [...MINUTES, m].sort();
  return (
    <span className="hour-input" role="group" aria-label={label}>
      <select value={h} aria-label={`${label}, hour`} onChange={(e) => pick(`${e.target.value}:${m}`)}>
        {HOURS.map((x) => (
          <option key={x}>{x}</option>
        ))}
      </select>
      <span aria-hidden>:</span>
      <select value={m} aria-label={`${label}, minutes`} onChange={(e) => pick(`${h}:${e.target.value}`)}>
        {minutes.map((x) => (
          <option key={x}>{x}</option>
        ))}
      </select>
    </span>
  );
}

/** Night: when the panel sleeps, and what it shows meanwhile. It belongs to the device, not a playlist. */
export function NightSettings({ sleep, onChange }: { sleep: Sleep; onChange: (p: Partial<Sleep>) => void }) {
  return (
    <div className="night-settings">
      <div className="night-row">
        <div>
          <strong>Sleep at night</strong>
          <small className="muted">The panel rests; the playlists wait until morning.</small>
        </div>
        <button className="toggle" role="switch" aria-checked={sleep.enabled} aria-label="Sleep at night" onClick={() => onChange({ enabled: !sleep.enabled })}>
          <span />
        </button>
      </div>
      <div className="night-row" data-dim={!sleep.enabled}>
        <label>Hours</label>
        <div className="hours">
          <HourInput value={sleep.start} onSave={(start) => onChange({ start })} label="Sleep from" />
          <span className="muted">to</span>
          <HourInput value={sleep.end} onSave={(end) => onChange({ end })} label="Wake at" />
        </div>
      </div>
      <div className="night-row" data-dim={!sleep.enabled}>
        <label>Panel shows</label>
        <div className="segmented" role="radiogroup" aria-label="Panel shows">
          {(
            [
              ["moon", "Moon"],
              ["blank", "Blank"],
              ["off", "Keep last"],
            ] as const
          ).map(([v, l]) => (
            <button key={v} role="radio" aria-checked={sleep.screen === v} onClick={() => onChange({ screen: v })}>
              {l}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
