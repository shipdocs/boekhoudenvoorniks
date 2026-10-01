/**
 * Foto's van de bonnenscanner (#48): controleren dat het echt JPEG is, en een bon van meerdere foto's
 * samenvoegen tot één PDF (één pagina per foto). De JPEG-gegevens gaan ongewijzigd de PDF in; er wordt
 * niets opnieuw gecomprimeerd en er is geen beeldbibliotheek nodig.
 */

export interface JpegInfo {
  width: number;
  height: number;
  /** 1 = grijs, 3 = kleur */
  components: 1 | 3;
  /** EXIF-oriëntatie (1 = rechtop, 3 = ondersteboven, 6 en 8 = gekanteld); onbekend telt als 1 */
  orientation: number;
}

/**
 * Leest de afmetingen uit de kop van een JPEG. Null als het geen JPEG is die we kunnen bewaren
 * (ander bestand met een .jpg-naam, afgebroken bestand, CMYK).
 */
export function jpegInfo(data: Uint8Array): JpegInfo | null {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let orientation = 1;
  let off = 2;
  while (off + 4 <= b.length) {
    if (b[off] !== 0xff) return null;
    const marker = b[off + 1]!;
    if (marker === 0xff) {
      // opvulbyte
      off += 1;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // einde of beelddata vóór de afmetingen
    const size = b.readUInt16BE(off + 2);
    if (size < 2 || off + 2 + size > b.length) return null;
    if (marker === 0xe1 && b.toString('latin1', off + 4, off + 10) === 'Exif\0\0') orientation = exifOrientation(b.subarray(off + 10, off + 2 + size)) ?? orientation;
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) {
      if (size < 8) return null;
      const height = b.readUInt16BE(off + 5);
      const width = b.readUInt16BE(off + 7);
      const components = b[off + 9];
      if (b[off + 4] !== 8 || width < 1 || height < 1 || (components !== 1 && components !== 3)) return null;
      return { width, height, components, orientation };
    }
    off += 2 + size;
  }
  return null;
}

function exifOrientation(t: Buffer): number | null {
  if (t.length < 8) return null;
  const le = t.toString('latin1', 0, 2) === 'II';
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const ifd = u32(4);
  if (ifd + 2 > t.length) return null;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) return null;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

const PAGE_WIDTH = 595; // A4-breedte in punten; de hoogte volgt de foto
const ROTATE: Record<number, number> = { 3: 180, 6: 90, 8: 270 };

/**
 * Eén PDF met elke foto op een eigen pagina. Dezelfde foto's geven precies hetzelfde bestand (geen
 * datum of willekeurig ID erin), zodat een bon die nog een keer binnenkomt aan zijn hash herkend wordt.
 */
export function jpegsToPdf(photos: Uint8Array[]): Buffer {
  const infos = photos.map((p) => {
    const info = jpegInfo(p);
    if (!info) throw new Error('Een van de foto\'s is geen geldige JPEG');
    return info;
  });
  const objects: Buffer[] = [];
  const obj = (body: string | Buffer[]) => objects.push(Buffer.isBuffer(body[0]) ? Buffer.concat(body as Buffer[]) : Buffer.from(body as string, 'latin1'));
  // 1 = catalogus, 2 = pagina's, daarna per foto: pagina, inhoud, beeld
  const pageRef = (i: number) => 3 + i * 3;
  obj('<< /Type /Catalog /Pages 2 0 R >>');
  obj(`<< /Type /Pages /Kids [${photos.map((_, i) => `${pageRef(i)} 0 R`).join(' ')}] /Count ${photos.length} >>`);
  photos.forEach((photo, i) => {
    const { width, height, components, orientation } = infos[i]!;
    const h = Math.round((PAGE_WIDTH * height) / width);
    const draw = `q ${PAGE_WIDTH} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    const rotate = ROTATE[orientation];
    obj(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${h}]${rotate ? ` /Rotate ${rotate}` : ''} /Resources << /XObject << /Im0 ${pageRef(i) + 2} 0 R >> >> /Contents ${pageRef(i) + 1} 0 R >>`);
    obj(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    obj([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /${components === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${photo.byteLength} >>\nstream\n`, 'latin1'),
      Buffer.from(photo.buffer, photo.byteOffset, photo.byteLength),
      Buffer.from('\nendstream', 'latin1'),
    ]);
  });

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let position = parts[0]!.length;
  objects.forEach((body, i) => {
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    offsets.push(position);
    position += chunk.length;
    parts.push(chunk);
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`), `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`];
  parts.push(Buffer.from(xref.join(''), 'latin1'));
  return Buffer.concat(parts);
}
