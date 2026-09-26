/**
 * GPS-positie uit de EXIF-gegevens van een JPEG-foto (#32). Wordt alleen gelezen als de gebruiker
 * locatie als signaal heeft aangezet; de positie blijft in de lokale database.
 */
export function readJpegGps(data: Uint8Array): { lat: number; lon: number } | null {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length < 4 || b.readUInt16BE(0) !== 0xffd8) return null;
  let off = 2;
  while (off + 4 <= b.length) {
    if (b[off] !== 0xff) return null;
    const marker = b[off + 1]!;
    const size = b.readUInt16BE(off + 2);
    if (marker === 0xe1 && b.toString('latin1', off + 4, off + 10) === 'Exif\0\0') return parseTiff(b.subarray(off + 10, off + 2 + size));
    if (marker === 0xda) return null; // begin van de beelddata: geen EXIF
    off += 2 + size;
  }
  return null;
}

function parseTiff(t: Buffer): { lat: number; lon: number } | null {
  if (t.length < 8) return null;
  const le = t.toString('latin1', 0, 2) === 'II';
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const entries = (ifd: number) => {
    const out = new Map<number, { type: number; count: number; valueOffset: number }>();
    if (ifd + 2 > t.length) return out;
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > t.length) break;
      out.set(u16(e), { type: u16(e + 2), count: u32(e + 4), valueOffset: e + 8 });
    }
    return out;
  };
  const ifd0 = entries(u32(4));
  const gpsPtr = ifd0.get(0x8825);
  if (!gpsPtr) return null;
  const gps = entries(u32(gpsPtr.valueOffset));
  const ref = (tag: number) => {
    const e = gps.get(tag);
    return e ? t.toString('latin1', e.valueOffset, e.valueOffset + 1) : '';
  };
  const dms = (tag: number) => {
    const e = gps.get(tag);
    if (!e || e.type !== 5 || e.count !== 3) return null;
    const at = u32(e.valueOffset);
    if (at + 24 > t.length) return null;
    const r = (i: number) => u32(at + i * 8) / (u32(at + i * 8 + 4) || 1);
    return r(0) + r(1) / 60 + r(2) / 3600;
  };
  const lat = dms(2);
  const lon = dms(4);
  if (lat === null || lon === null) return null;
  return { lat: ref(1) === 'S' ? -lat : lat, lon: ref(3) === 'W' ? -lon : lon };
}

/** Afstand in meters (haversine). */
export function distanceMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Minimale JPEG met alleen een EXIF-GPS-blok (voor tests). */
export function makeJpegWithGps(lat: number, lon: number): Uint8Array {
  const rational = (v: number) => {
    const d = Math.floor(Math.abs(v));
    const mFull = (Math.abs(v) - d) * 60;
    const m = Math.floor(mFull);
    const s = Math.round((mFull - m) * 60 * 10000);
    return [d, 1, m, 1, s, 10000];
  };
  // TIFF (big-endian): header(8) + IFD0 (1 entry) + GPS IFD (4 entries) + data
  const ifd0 = 8;
  const gpsIfd = ifd0 + 2 + 12 + 4;
  const data = gpsIfd + 2 + 4 * 12 + 4;
  const t = Buffer.alloc(data + 48);
  t.write('MM', 0, 'latin1');
  t.writeUInt16BE(42, 2);
  t.writeUInt32BE(ifd0, 4);
  t.writeUInt16BE(1, ifd0);
  t.writeUInt16BE(0x8825, ifd0 + 2);
  t.writeUInt16BE(4, ifd0 + 4);
  t.writeUInt32BE(1, ifd0 + 6);
  t.writeUInt32BE(gpsIfd, ifd0 + 10);
  t.writeUInt16BE(4, gpsIfd);
  const entry = (i: number, tag: number, type: number, count: number, write: (o: number) => void) => {
    const e = gpsIfd + 2 + i * 12;
    t.writeUInt16BE(tag, e);
    t.writeUInt16BE(type, e + 2);
    t.writeUInt32BE(count, e + 4);
    write(e + 8);
  };
  entry(0, 1, 2, 2, (o) => t.write(lat < 0 ? 'S' : 'N', o, 'latin1'));
  entry(1, 2, 5, 3, (o) => t.writeUInt32BE(data, o));
  entry(2, 3, 2, 2, (o) => t.write(lon < 0 ? 'W' : 'E', o, 'latin1'));
  entry(3, 4, 5, 3, (o) => t.writeUInt32BE(data + 24, o));
  rational(lat).forEach((v, i) => t.writeUInt32BE(v, data + i * 4));
  rational(lon).forEach((v, i) => t.writeUInt32BE(v, data + 24 + i * 4));
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(exif.length + 2, 2);
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8]), app1, exif, Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])]));
}
