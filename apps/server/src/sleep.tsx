// What the panel shows at night: a moon and when it wakes, or nothing at all.
import { sheet } from "./apps/types.ts";
import { renderFrame, type Frame } from "./render.ts";
import type { Sleep } from "./schedule.ts";

const hhmm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function Moon({ until }: { until: number }) {
  return (
    <div style={{ ...sheet, flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      <svg width="132" height="132" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="44" fill="#000" />
        <circle cx="68" cy="38" r="40" fill="#fff" />
      </svg>
      <div style={{ fontSize: 60, fontWeight: 500, letterSpacing: -1.5, marginTop: 34 }}>Good night</div>
      <div style={{ fontSize: 30, fontWeight: 400, marginTop: 12 }}>{`Back at ${hhmm(until)}`}</div>
    </div>
  );
}

let cached: { key: string; frame: Promise<Frame> } | null = null;

/** The sleep frame for tonight, rendered once. Null when the panel should just keep its last picture. */
export function sleepFrame(sleep: Sleep, until: number): Promise<Frame> | null {
  if (sleep.screen === "off") return null;
  const key = `${sleep.screen}:${until}`;
  if (cached?.key !== key) {
    cached = { key, frame: renderFrame(sleep.screen === "moon" ? <Moon until={until} /> : <div style={sheet} />) };
  }
  return cached.frame;
}
