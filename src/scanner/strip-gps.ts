/**
 * De plek waar een foto gemaakt is uit een JPEG halen, zonder het beeld aan te raken (bonnenscanner,
 * #48; locatie is opt-in, #32). Het beeld wordt niet opnieuw gecomprimeerd: alleen de gegevens vóór
 * de beelddata veranderen.
 *
 * Wat eruit gaat:
 * - de GPS-gegevens in de EXIF (de GPS-map en de verwijzing ernaar): ter plekke overschreven met nullen,
 *   zodat alle andere EXIF-gegevens (zoals de draairichting) op hun plaats blijven;
 * - een XMP-blok waarin een positie staat (GPS-velden): dat blok gaat in zijn geheel weg;
 * - een EXIF-blok dat niet te lezen is, of waarvan de GPS-map niet klopt: daarvan is niet te zien of
 *   en waar er een positie in staat, dus het gaat in zijn geheel weg.
 *
 * Wat we niet kunnen herkennen en dus laten staan: een positie in een merkeigen notitieveld
 * (MakerNote) en plaatsnamen in IPTC-gegevens.
 */
export function stripJpegGps(data: Uint8Array): Buffer {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return b;
  /** stukken van het origineel die blijven; een segment dat weg moet, wordt overgeslagen */
  const keep: Buffer[] = [];
  let changed = false;
  let from = 0;
  let off = 2;
  while (off + 4 <= b.length && b[off] === 0xff) {
    const marker = b[off + 1]!;
    if (marker === 0xff) {
      off += 1;
      continue;
    }
    // begin van de beelddata (of het einde): daarna staat er geen informatie over de foto meer
    if (marker === 0xda || marker === 0xd9) break;
    const size = b.readUInt16BE(off + 2);
    if (size < 2 || off + 2 + size > b.length) break;
    const end = off + 2 + size;
    if (marker === 0xe1) {
      const body = b.subarray(off + 4, end);
      let drop = false;
      if (body.toString('latin1', 0, 6) === 'Exif\0\0') {
        // een kopie van dit blok, waarin de GPS-gegevens overschreven worden
        const tiff = Buffer.from(body.subarray(6));
        const result = wipeGps(tiff);
        if (result === 'onleesbaar') drop = true;
        else if (result === 'gewist') {
          keep.push(b.subarray(from, off + 10), tiff);
          from = end;
          changed = true;
        }
      } else if (/^http:\/\/ns\.adobe\.com\/(xap\/1\.0|xmp\/extension)\/\0/.test(body.toString('latin1', 0, 40)) && body.includes('GPS')) {
        drop = true;
      }
      if (drop) {
        keep.push(b.subarray(from, off));
        from = end;
        changed = true;
      }
    }
    off = end;
  }
  if (!changed) return b;
  keep.push(b.subarray(from));
  return Buffer.concat(keep);
}

const GPS_POINTER = 0x8825;
/** aantal bytes per waarde, per TIFF-type (1 = byte … 12 = double) */
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/**
 * Overschrijft in een TIFF-blok (de inhoud van EXIF) de GPS-map met nullen en haalt de verwijzing
 * ernaar uit de hoofdmap. De lengte van het blok en alle andere verwijzingen blijven gelijk.
 */
function wipeGps(t: Buffer): 'geen' | 'gewist' | 'onleesbaar' {
  if (t.length < 8) return 'onleesbaar';
  const order = t.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return 'onleesbaar';
  const le = order === 'II';
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const w16 = (v: number, o: number) => (le ? t.writeUInt16LE(v, o) : t.writeUInt16BE(v, o));
  if (u16(2) !== 42) return 'onleesbaar';
  const ifd0 = u32(4);
  if (ifd0 < 8 || ifd0 + 2 > t.length) return 'onleesbaar';
  const count = u16(ifd0);
  const entries = ifd0 + 2;
  // de map zelf en de verwijzing naar de volgende map moeten binnen het blok liggen
  if (entries + count * 12 + 4 > t.length) return 'onleesbaar';
  let index = -1;
  for (let i = 0; i < count; i++) if (u16(entries + i * 12) === GPS_POINTER) index = i;
  if (index === -1) return 'geen';

  // Eerst kijken of de GPS-map helemaal te volgen is. Klopt er iets niet (verwijzing of waarde buiten het
  // blok), dan weten we niet zeker waar de positie staat: het hele blok gaat dan weg.
  const gps = u32(entries + index * 12 + 8);
  if (gps < 8 || gps + 2 > t.length) return 'onleesbaar';
  const n = u16(gps);
  if (gps + 2 + n * 12 + 4 > t.length) return 'onleesbaar';
  // een GPS-map die over de hoofdmap heen ligt, is geen GPS-map
  if (gps < entries + count * 12 + 4 && gps + 2 + n * 12 + 4 > ifd0) return 'onleesbaar';
  const values: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const e = gps + 2 + i * 12;
    const bytes = (TYPE_SIZE[u16(e + 2)] ?? 1) * u32(e + 4);
    if (bytes <= 4) continue;
    const at = u32(e + 8);
    if (at < 8 || at + bytes > t.length) return 'onleesbaar';
    values.push([at, at + bytes]);
  }
  // de waarden die buiten de map staan, en dan de map zelf
  for (const [from, to] of values) t.fill(0, from, to);
  t.fill(0, gps, gps + 2 + n * 12 + 4);
  // dan de verwijzing: de regels erna schuiven één plek op, de map telt er één minder
  const after = entries + (index + 1) * 12;
  const tail = entries + count * 12 + 4; // tot en met de verwijzing naar de volgende map
  t.copy(t, entries + index * 12, after, tail);
  t.fill(0, tail - 12, tail);
  w16(count - 1, ifd0);
  return 'gewist';
}
