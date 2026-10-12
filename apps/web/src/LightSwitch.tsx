import { useLights } from "./theme";

const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** A wall switch: up is lights on, down dims the room. On its own it follows the sun. */
export function LightSwitch() {
  const { theme, flip, nextAt, held } = useLights();
  const on = theme === "light";
  const when = on ? `They dim at sunset, ${hhmm(nextAt)}` : `They come on at sunrise, ${hhmm(nextAt)}`;
  return (
    <button
      className="lightswitch"
      role="switch"
      aria-checked={on}
      aria-label="Lights"
      data-held={held}
      title={`${on ? "Dim the lights" : "Lights on"}. ${held ? `Back to following the sun at ${hhmm(nextAt)}.` : when + "."}`}
      onClick={flip}
    >
      <span className="rocker" />
    </button>
  );
}
