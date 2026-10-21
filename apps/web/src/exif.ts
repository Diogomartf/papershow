// When a photo was taken, from the EXIF a camera or phone writes into a JPEG. Just the date: nothing else is read.

/** EXIF tags: where the camera's own block starts, when it took the picture, and when the file was last changed. */
const EXIF_IFD = 0x8769;
const DATE_TAKEN = 0x9003;
const DATE_CHANGED = 0x0132;

/** "2019:10:21 14:03:59", the camera's wall-clock time, as ms since epoch in this browser's zone. */
function parseDate(s: string) {
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m || m[1] === "0000") return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return Number.isFinite(t) ? t : null;
}

/** When a JPEG was taken, or null when it doesn't say (not a JPEG, no EXIF, a screenshot). */
export async function takenAt(file: Blob): Promise<number | null> {
  // EXIF sits in the first segments; a few hundred KB covers even a big embedded thumbnail.
  const b = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
  if (b.byteLength < 4 || b.getUint16(0) !== 0xffd8) return null;
  let i = 2;
  while (i + 4 <= b.byteLength) {
    if (b.getUint8(i) !== 0xff) return null;
    const marker = b.getUint8(i + 1);
    const size = b.getUint16(i + 2);
    // APP1 starting "Exif\0\0": a TIFF block follows.
    if (marker === 0xe1 && i + 10 <= b.byteLength && b.getUint32(i + 4) === 0x45786966) return fromTiff(b, i + 10);
    // Start of scan: the picture itself, with no metadata after it.
    if (marker === 0xda) return null;
    i += 2 + size;
  }
  return null;
}

function fromTiff(b: DataView, start: number) {
  try {
    const little = b.getUint16(start) === 0x4949;
    const u16 = (at: number) => b.getUint16(start + at, little);
    const u32 = (at: number) => b.getUint32(start + at, little);
    /** The tags of the directory at `at`: each one's value, or where its value is, by tag. */
    const entries = (at: number) => {
      const out = new Map<number, { count: number; at: number }>();
      const n = u16(at);
      for (let k = 0; k < n; k++) {
        const e = at + 2 + k * 12;
        const count = u32(e + 4);
        // Values of four bytes or fewer are inline; longer ones are elsewhere, at an offset.
        out.set(u16(e), { count, at: count > 4 ? u32(e + 8) : e + 8 });
      }
      return out;
    };
    const ascii = (t: { count: number; at: number } | undefined) =>
      t ? String.fromCharCode(...new Uint8Array(b.buffer, b.byteOffset + start + t.at, Math.min(t.count, 32))) : "";
    const ifd0 = entries(u32(4));
    const exif = ifd0.get(EXIF_IFD);
    // The camera's own block: its offset is the pointer tag's inline value.
    const taken = exif ? ascii(entries(u32(exif.at)).get(DATE_TAKEN)) : "";
    return parseDate(taken) ?? parseDate(ascii(ifd0.get(DATE_CHANGED)));
  } catch {
    // A truncated or odd block: no date, rather than no photo.
    return null;
  }
}
