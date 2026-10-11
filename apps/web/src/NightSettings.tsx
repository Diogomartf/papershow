import type { Sleep } from "./slides";

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
          <input type="time" value={sleep.start} onChange={(e) => e.target.value && onChange({ start: e.target.value })} aria-label="Sleep from" />
          <span className="muted">to</span>
          <input type="time" value={sleep.end} onChange={(e) => e.target.value && onChange({ end: e.target.value })} aria-label="Wake at" />
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
