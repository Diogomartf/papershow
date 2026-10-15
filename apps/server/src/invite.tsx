// An invite on the panel: a QR code to scan with a phone, and the code itself to type.
import qrcode from "qrcode-generator";
import { sheet } from "./apps/types.ts";
import type { Invite } from "./people.ts";
import { renderFrame, type Frame } from "./render.ts";

/** A QR code as one SVG path in a square of `size` modules, quiet zone included. */
export function qrPath(text: string) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  let d = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  return { d, size: n + quiet * 2 };
}

/** The QR code as a standalone SVG, for the web app's invite screen. */
export function qrSvg(text: string) {
  const { d, size } = qrPath(text);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

const hhmm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function InviteCard({ url, code, until }: { url: string; code: string; until: number }) {
  const { d, size } = qrPath(url);
  // Whole pixels per module, so every square comes out crisp in 1 bit.
  const px = Math.floor(400 / size) * size;
  return (
    <div style={{ ...sheet, alignItems: "center", padding: "0 56px", gap: 48 }}>
      <svg width={px} height={px} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
        <path d={d} fill="#000" />
      </svg>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <span style={{ fontSize: 64, fontWeight: 700, letterSpacing: -2 }}>Come in!</span>
        <span style={{ fontSize: 26, marginTop: 14, lineHeight: 1.3 }}>Scan this with your phone's camera to join the house.</span>
        <span style={{ fontSize: 20, marginTop: 34 }}>Or type the code</span>
        <span style={{ fontSize: 52, fontWeight: 600, letterSpacing: 6, marginTop: 4 }}>{code}</span>
        <span style={{ fontSize: 20, marginTop: 30 }}>{`Works until ${hhmm(until)}`}</span>
      </div>
    </div>
  );
}

let cached: { key: string; frame: Promise<Frame> } | null = null;

/** The invite's frame, rendered once per invite. */
export function inviteFrame(invite: Invite): Promise<Frame> {
  if (cached?.key !== invite.code)
    cached = { key: invite.code, frame: renderFrame(<InviteCard url={invite.url} code={invite.code} until={invite.expiresAt} />) };
  return cached.frame;
}
