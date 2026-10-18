import { createHash } from 'node:crypto';
import type { Db } from '../db/database';
import { isStoredAttachmentPath } from '../db/attachment-paths';
import { ValidationError } from '../shared/validation';

/** Hoeveel foto's één aanroep van `list` hoogstens teruggeeft. */
export const FOTO_LIJST_MAX = 200;
/** De hoogste offset die we aannemen (voorkomt rare invoer van buiten). */
const OFFSET_MAX = 1_000_000;

/** Wat de pc over een foto laat zien: nooit het pad, de sha256 of de wijziging-uuid. */
export interface JobPhoto {
  id: number;
  /** de plek van de foto binnen de wijziging van de telefoon (vanaf 1) */
  volgnr: number;
  /** het bewerkmoment op de telefoon, in milliseconden sinds 1-1-1970 UTC */
  tijd: number;
  notitie: string | null;
  /** de grootte van het bewaarde bestand in bytes */
  grootte: number;
  /** true = bij het bewaren is een controlesom (sha256) vastgelegd; bij het lezen wordt het bestand er echt mee vergeleken */
  gecontroleerd: boolean;
}

export interface JobPhotoContent {
  mimeType: 'image/jpeg';
  base64: string;
}

interface Rij {
  id: number;
  volgnr: number;
  tijd: number;
  notitie: string | null;
  bytes: number;
  sha256: string;
}

/** Een veilig geheel getal binnen de grenzen, anders een Nederlandse fout. */
function geheel(waarde: unknown, naam: string, min: number, max: number): number {
  if (typeof waarde !== 'number' || !Number.isSafeInteger(waarde) || waarde < min || waarde > max) {
    throw new ValidationError(`${naam} moet een geheel getal van ${min} tot en met ${max} zijn`);
  }
  return waarde;
}

/**
 * De foto's van de telefoon bij een klus (job_photos), alleen lezen. Een foto is onveranderlijk: deze klasse
 * heeft bewust geen functie om er een te wijzigen of weg te halen. Het bestand wordt gelezen met de functie die de
 * host levert (host.readAttachment), die alleen bestanden in bijlagen/ van de administratie opent.
 */
export class JobPhotos {
  constructor(private readonly db: Db) {}

  /** Het aantal foto's van een klus (een klus die niet bestaat heeft er 0). */
  count(jobId: number): number {
    geheel(jobId, 'Het klusnummer', 1, Number.MAX_SAFE_INTEGER);
    return (this.db.prepare('SELECT COUNT(*) AS n FROM job_photos WHERE job_id = ?').get(jobId) as { n: number }).n;
  }

  /**
   * De foto's van een klus, oplopend op de tijd van de telefoon en dan op id (een vaste volgorde, ook bij
   * offset). Hoogstens 200 per aanroep; `count` geeft het totaal. Een onbekende klus geeft [].
   */
  list(jobId: number, opties: { limiet?: number; offset?: number } = {}): JobPhoto[] {
    geheel(jobId, 'Het klusnummer', 1, Number.MAX_SAFE_INTEGER);
    const limiet = opties.limiet === undefined ? FOTO_LIJST_MAX : geheel(opties.limiet, 'De limiet', 1, FOTO_LIJST_MAX);
    const offset = opties.offset === undefined ? 0 : geheel(opties.offset, 'De offset', 0, OFFSET_MAX);
    const rijen = this.db
      .prepare('SELECT id, volgnr, tijd, notitie, bytes, sha256 FROM job_photos WHERE job_id = ? ORDER BY tijd, id LIMIT ? OFFSET ?')
      .all(jobId, limiet, offset) as Rij[];
    return rijen.map((r) => ({ id: r.id, volgnr: r.volgnr, tijd: r.tijd, notitie: r.notitie, grootte: r.bytes, gecontroleerd: /^[0-9a-f]{64}$/.test(r.sha256) && r.bytes > 0 }));
  }

  /**
   * De inhoud van een foto. `leesBijlage` is de veilige leesroute van de host (alleen bijlagen van de
   * administratie). Een ontbrekend of beschadigd bestand geeft een Nederlandse fout, zonder het pad.
   */
  read(photoId: number, leesBijlage: (opgeslagenPad: string) => Buffer): JobPhotoContent {
    geheel(photoId, 'Het fotonummer', 1, Number.MAX_SAFE_INTEGER);
    const rij = this.db.prepare('SELECT file_path, sha256 FROM job_photos WHERE id = ?').get(photoId) as { file_path: string; sha256: string } | undefined;
    if (!rij) throw new ValidationError(`Foto ${photoId} bestaat niet`);
    if (!isStoredAttachmentPath(rij.file_path)) throw new ValidationError('Deze foto staat niet in de bijlagen van de administratie');
    let bytes: Buffer;
    try {
      bytes = leesBijlage(rij.file_path);
    } catch {
      // de systeemfout bevat het pad; dat blijft hier
      throw new ValidationError('Het bestand van deze foto is niet gevonden of niet te lezen');
    }
    if (createHash('sha256').update(bytes).digest('hex') !== rij.sha256) throw new ValidationError('Het bestand van deze foto klopt niet meer met wat is bewaard');
    return { mimeType: 'image/jpeg', base64: bytes.toString('base64') };
  }
}
