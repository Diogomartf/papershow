import { useLights } from "./theme";

/** A wall switch: up is lights on, down dims the room. */
export function LightSwitch() {
  const { theme, flip } = useLights();
  const on = theme === "light";
  return (
    <button
      className="lightswitch"
      role="switch"
      aria-checked={on}
      aria-label="Lights"
      title={on ? "Dim the lights" : "Lights on"}
      onClick={flip}
    >
      <span className="rocker" />
    </button>
  );
}
