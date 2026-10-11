// Black-and-white marks drawn as vectors, so they stay crisp at 1 bit.
import type { JSX } from "#jsx/jsx-runtime";

/** Known crypto marks; anything else gets a ticker badge. */
export function TokenMark({ id, symbol, size }: { id: string; symbol: string; size: number }) {
  const circle = <circle cx="32" cy="32" r="32" fill="#000" />;
  const svg = (children: JSX.Element) => (
    <svg width={size} height={size} viewBox="0 0 64 64">
      {circle}
      {children}
    </svg>
  );
  if (id === "bitcoin")
    return svg(
      <g transform="rotate(14 32 32)" fill="#fff">
        <path d="M23 17h12.5c5 0 8 2.6 8 6.6 0 2.8-1.6 4.7-4 5.4 3.2.6 5.2 2.9 5.2 6.2 0 4.6-3.4 7.8-9 7.8H23zm6 5v8.2h5.4c2.6 0 4.1-1.5 4.1-4.1s-1.5-4.1-4.1-4.1zm0 12.8v8.4h6c2.8 0 4.4-1.6 4.4-4.2s-1.6-4.2-4.4-4.2z" fillRule="evenodd" />
        <rect x="28" y="12" width="3.4" height="7" />
        <rect x="34" y="12" width="3.4" height="7" />
        <rect x="28" y="41" width="3.4" height="7" />
        <rect x="34" y="41" width="3.4" height="7" />
      </g>,
    );
  if (id === "ethereum")
    return svg(
      <g fill="#fff">
        <polygon points="32,9 46,33 32,41.5 18,33" />
        <polygon points="32,44.5 46,36 32,55 18,36" />
      </g>,
    );
  if (id === "solana")
    return svg(
      <g fill="#fff">
        <polygon points="23,19 48,19 42,25.5 17,25.5" />
        <polygon points="17,29 42,29 48,35.5 23,35.5" />
        <polygon points="23,39 48,39 42,45.5 17,45.5" />
      </g>,
    );
  return <Badge text={symbol} size={size} round />;
}

/** A ticker in a black badge: round for tokens, rounded square for stocks. */
export function Badge({ text, size, round }: { text: string; size: number; round?: boolean }) {
  const fontSize = size * (text.length <= 2 ? 0.42 : text.length === 3 ? 0.32 : 0.26);
  return (
    <div
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: round ? size / 2 : size * 0.22,
        background: "#000",
        color: "#fff",
        fontSize,
        fontWeight: 700,
        letterSpacing: -0.5,
      }}
    >
      {text}
    </div>
  );
}

/** Up or down, since the panel has no red or green. */
export function Trend({ up, size }: { up: boolean; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10">
      <polygon points={up ? "5,1 9.5,8.5 0.5,8.5" : "5,9 9.5,1.5 0.5,1.5"} fill="#000" />
    </svg>
  );
}
