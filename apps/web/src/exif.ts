// When and where a photo was taken, from the EXIF a camera or phone writes into a JPEG. Nothing else is read.

/** EXIF tags: where the camera's own block starts, when it took the picture, and when the file was last changed. */
const EXIF_IFD = 0x8769;
const DATE_TAKEN = 0x9003;
const DATE_CHANGED = 0x0132;
/** Where the GPS block starts, and in it: north or south, latitude, east or west, longitude. */
const GPS_IFD = 0x8825;
const LAT_REF = 1;
const LAT = 2;
const LON_REF = 3;
const LON = 4;
/** Bytes per value of each EXIF type: a tag's values sit inline when they fit in four bytes, elsewhere when not. */
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

export type Where = { lat: number; lon: number };
export type Exif = { at: number | null; where: Where | null };
const NOTHING: Exif = { at: null, where: null };

/** "2019:10:21 14:03:59", the camera's wall-clock time, as ms since epoch in this browser's zone. */
function parseDate(s: string) {
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m || m[1] === "0000") return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return Number.isFinite(t) ? t : null;
}

/** When and where a JPEG was taken, each null when it doesn't say (not a JPEG, no EXIF, a screenshot, no GPS). */
export async function readExif(file: Blob): Promise<Exif> {
  // EXIF sits in the first segments; a few hundred KB covers even a big embedded thumbnail.
  const b = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
  if (b.byteLength < 4 || b.getUint16(0) !== 0xffd8) return NOTHING;
  let i = 2;
  while (i + 4 <= b.byteLength) {
    if (b.getUint8(i) !== 0xff) return NOTHING;
    const marker = b.getUint8(i + 1);
    const size = b.getUint16(i + 2);
    // APP1 starting "Exif\0\0": a TIFF block follows.
    if (marker === 0xe1 && i + 10 <= b.byteLength && b.getUint32(i + 4) === 0x45786966) return fromTiff(b, i + 10);
    // Start of scan: the picture itself, with no metadata after it.
    if (marker === 0xda) return NOTHING;
    i += 2 + size;
  }
  return NOTHING;
}

function fromTiff(b: DataView, start: number): Exif {
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
        out.set(u16(e), { count, at: count * (TYPE_SIZE[u16(e + 2)] ?? 1) > 4 ? u32(e + 8) : e + 8 });
      }
      return out;
    };
    const ascii = (t: { count: number; at: number } | undefined) =>
      t ? String.fromCharCode(...new Uint8Array(b.buffer, b.byteOffset + start + t.at, Math.min(t.count, 32))) : "";
    const ifd0 = entries(u32(4));
    const exif = ifd0.get(EXIF_IFD);
    // The camera's own block: its offset is the pointer tag's inline value.
    const taken = exif ? ascii(entries(u32(exif.at)).get(DATE_TAKEN)) : "";
    const at = parseDate(taken) ?? parseDate(ascii(ifd0.get(DATE_CHANGED)));

    const pointer = ifd0.get(GPS_IFD);
    if (!pointer) return { at, where: null };
    const gps = entries(u32(pointer.at));
    /** Degrees, minutes and seconds as three fractions, signed by which side of the equator or meridian it's on. */
    const angle = (tag: number, ref: number, negative: string) => {
      const t = gps.get(tag);
      if (!t) return NaN;
      const part = (k: number) => u32(t.at + k * 8) / u32(t.at + k * 8 + 4);
      return (part(0) + part(1) / 60 + part(2) / 3600) * (ascii(gps.get(ref)).startsWith(negative) ? -1 : 1);
    };
    const lat = angle(LAT, LAT_REF, "S");
    const lon = angle(LON, LON_REF, "W");
    // Phones without a fix sometimes write zeros: that's the sea off Africa, not where the photo was.
    const where =
      Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
        ? { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 }
        : null;
    return { at, where };
  } catch {
    // A truncated or odd block: nothing, rather than no photo.
    return NOTHING;
  }
}
