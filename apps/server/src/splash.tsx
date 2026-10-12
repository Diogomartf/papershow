// The panel's start-up screen: the glyph and the wordmark. The client shows it before it reaches the
// server, so it's rendered here once and kept next to the client. Run after changing the logo:
//   npx tsx src/splash.tsx
import { readFileSync, writeFileSync } from "node:fs";
import { sheet } from "./apps/types.ts";
import { renderFrame } from "./render.ts";

const svg = (name: string) =>
  `data:image/svg+xml;base64,${readFileSync(new URL(`../../web/public/${name}`, import.meta.url)).toString("base64")}`;

const frame = await renderFrame(
  <div style={{ ...sheet, alignItems: "center", justifyContent: "center", gap: 30 }}>
    <img src={svg("logo-isometric.svg")} width={180} height={180} />
    {/* The wordmark's viewBox is 2026 × 495. */}
    <img src={svg("wordmark.svg")} width={470} height={115} />
  </div>,
);
writeFileSync(new URL("../../panel/splash.png", import.meta.url), frame.mono);
