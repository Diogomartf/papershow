// Offsets into the pulse for each of the nine blocks, in seconds before it starts (row by row).
// Uneven on purpose: blocks swell and shrink out of step, like a panel redrawing in patches.
const DELAYS = [0.9, 0.2, 0.55, 0.35, 1.1, 0.05, 0.7, 0.45, 1.25];

/** A loading mark: a 3×3 grid of rounded blocks pulsing out of step. `size` is one block's side in px. */
export function Blocks({ size = 12 }: { size?: number }) {
  return (
    <span className="blocks" style={{ ["--b" as string]: `${size}px` }} aria-hidden>
      {DELAYS.map((d, i) => (
        <span key={i} style={{ animationDelay: `-${d}s` }} />
      ))}
    </span>
  );
}
