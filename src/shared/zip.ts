import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Minimale ZIP-schrijver (PKZIP 2.0, deflate, UTF-8-namen). Genoeg voor een exportpakket dat
 * Windows Verkenner, macOS en elk boekhoudpakket kan openen; geen ZIP64, dus onder 4 GB.
 */

export interface ZipEntry {
  /** pad in het archief, met '/' als scheiding */
  path: string;
  data: Buffer | string;
  /** wijzigingsdatum; standaard nu */
  date?: Date;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function createZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (const entry of entries) {
    if (!entry.path || entry.path.startsWith('/') || entry.path.split('/').some((p) => p === '..' || p === '')) throw new Error(`Ongeldig pad in ZIP: ${entry.path}`);
    if (seen.has(entry.path)) throw new Error(`Dubbel pad in ZIP: ${entry.path}`);
    seen.add(entry.path);
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
    const deflated = deflateRawSync(raw);
    // al gecomprimeerde bestanden (pdf, jpg) worden soms groter: dan ongecomprimeerd opslaan
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const name = Buffer.from(entry.path, 'utf8');
    const crc = crc32(raw);
    const { time, date } = dosDateTime(entry.date ?? new Date());
    if (offset + 30 + name.length + body.length > 0xffffffff) throw new Error('Het pakket is te groot (meer dan 4 GB)');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versie nodig
    local.writeUInt16LE(0x0800, 6); // bit 11: namen in UTF-8
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    // gemaakt op Unix: anders leest Info-ZIP de namen als DOS-codetabel, ondanks de UTF-8-vlag
    dir.writeUInt16LE((3 << 8) | 30, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(stored ? 0 : 8, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE((0o100644 << 16) >>> 0, 38); // gewoon bestand, rw-r--r--
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += 30 + name.length + body.length;
  }
  if (entries.length > 0xffff) throw new Error('Te veel bestanden voor één pakket');
  const dirSize = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}
