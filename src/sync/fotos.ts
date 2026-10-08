import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { leesFotoVelden, leesWijziging, type Wijziging } from '@gratis-boekhouden/kern';
import type { Db } from '../db/database';
import { resolveAttachmentPath } from '../main/attachments';
import { jpegInfo } from '../scanner/jpeg-pdf';
import { stripJpegGps } from '../scanner/strip-gps';
import { controleerBijlagen, controleerGrenzen } from './bonnen';
import type { SyncResultaat } from './ontvangst';
import type { SyncWachtrij, WachtrijBehandelaar, WachtrijRij } from './wachtrij';

export interface FotoOntvangstOpties {
  /** de pc-klok in milliseconden (voor ontvangen_op); standaard Date.now */
  now?: () => number;
  /** logboek voor storingen (nooit met een pad of de inhoud van een foto) */
  log?: (melding: string) => void;
  /** mag de locatie in een foto bewaard worden? (opt-in van #32; standaard niet) */
  keepLocation?: () => boolean;
  /** Verwijdert één bestand (gooit bij elke fout behalve "bestaat niet"). Los gemaakt zodat een test de fout kan nabootsen. */
  verwijderBestand?: (pad: string) => void;
}

interface RegisterRij {
  uitkomst: string;
  fout: string | null;
}

/** Wat er van één foto bewaard wordt: het relatieve pad, en de sha256 en grootte van het bewaarde bestand. */
interface Bewaard {
  pad: string;
  sha256: string;
  bytes: number;
}

type Klaar = { uitkomst: 'toegepast' | 'overgeslagen' } | { uitkomst: 'afgewezen'; fout: string };
type Uitkomst = Klaar | { uitkomst: 'wacht' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** Het relatieve pad van een foto in de administratie: bijlagen/telefoon/<wijziging-uuid>/<volgnr>.jpg (volgnr vanaf 1). */
export function fotoPad(uuid: string, volgnr: number): string {
  if (!UUID.test(uuid)) throw new Error('Ongeldige uuid');
  return `bijlagen/telefoon/${uuid}/${volgnr}.jpg`;
}

/**
 * Neemt een foto van de telefoon over (entiteit foto): een of meer JPEG's bij een project (klus). Een foto heeft
 * precies een revisie en wordt nooit bewerkt of verwijderd.
 *
 * De bestanden staan onder bijlagen/telefoon/<wijziging-uuid>/<volgnr>.jpg in de administratie (zodat verhuizen en
 * een back-up ze meenemen), exclusief aangemaakt: bestaat een bestand al, dan wordt de inhoud vergeleken en is een
 * andere inhoud een fout. De GPS in de JPEG wordt gestript, tenzij de gebruiker locatie bewaren heeft toegestaan;
 * job_photos bewaart de sha256 van het bewaarde bestand, de sha256 in de velden is die van wat de telefoon stuurde.
 *
 * Volgorde per wijziging, binnen de databasetransactie van SyncOntvangst.verwerk: register, wachtrij, grenzen,
 * velden en bijlagen, project zoeken. Een bekend project: bestanden schrijven, job_photos en registerrij. Een onbekend
 * project: een wachtrijrij (reden project-onbekend), de bestanden al op schijf en verwijzingen in sync_wachtrij_bijlagen;
 * de wachtrij bewaart nooit bytes. Mislukt er iets, dan draait de databank terug en `terugdraaien` haalt de net
 * geschreven bestanden weg; lukt dat verwijderen niet, dan wordt het bestand onthouden (en later opnieuw geprobeerd)
 * en wordt het nooit een foto. Hervatten van wachtende foto's gebeurt in `verwerkObject` (aangeroepen door de wachtrij).
 */
export class FotoOntvangst implements WachtrijBehandelaar {
  readonly entiteit = 'foto';
  private readonly now: () => number;
  private readonly log: (melding: string) => void;
  private readonly keepLocation: () => boolean;
  private readonly verwijder: (pad: string) => void;
  /** relatieve paden die deze aanroep zelf neerzette (en die nog niet definitief zijn) */
  private nieuw: string[] = [];
  /** relatieve paden van mislukte ontvangsten die niet verwijderd konden worden: nooit een foto, later opnieuw proberen */
  private readonly teVerwijderen = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly adminDir: string,
    private readonly wachtrij: SyncWachtrij,
    opties: FotoOntvangstOpties = {},
  ) {
    this.now = opties.now ?? Date.now;
    this.log = opties.log ?? (() => undefined);
    this.keepLocation = opties.keepLocation ?? (() => false);
    this.verwijder =
      opties.verwijderBestand ??
      ((pad) => {
        try {
          unlinkSync(pad);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
      });
  }

  /** Verwerkt een fotowijziging; hoort binnen een transactie te draaien (SyncOntvangst doet dat). */
  verwerk(deviceId: string, bron: string, w: Wijziging, route: string, bijlagen: Buffer[]): SyncResultaat {
    this.nieuw = [];
    // 1. exact dezelfde sleutel al gezien: niets schrijven en de uitkomst van de eerste keer herhalen
    const bekend = this.db
      .prepare('SELECT uitkomst, fout FROM sync_ontvangen WHERE apparaat_id = ? AND entiteit = ? AND uuid = ? AND revisie = ?')
      .get(deviceId, w.entiteit, w.uuid, w.revisie) as RegisterRij | undefined;
    if (bekend) {
      if (bekend.uitkomst === 'afgewezen') return { status: 200, uitkomst: 'afgewezen', fout: bekend.fout ?? undefined };
      // dezelfde uuid met een andere inhoud dan de bewaarde foto is nooit een herhaling: de eerste inhoud blijft staan
      if (UUID.test(w.uuid) && bijlagen.length > 0 && this.botst(w.uuid, bijlagen)) return { status: 200, uitkomst: 'afgewezen', fout: 'id-botst' };
      return { status: 200, uitkomst: 'overgeslagen' };
    }

    // 1b. dezelfde sleutel staat al in de wachtrij (ook al afgehandeld): de eerst opgeslagen inhoud blijft leidend
    const inWachtrij = this.wachtrij.rij(deviceId, w.entiteit, w.uuid, w.revisie);
    if (inWachtrij) {
      if (inWachtrij.verwerkt_op === null) return { status: 200, uitkomst: 'wacht' };
      return inWachtrij.verwerkt_uitkomst === 'afgewezen' ? { status: 200, uitkomst: 'afgewezen', ...(inWachtrij.verwerkt_reden ? { fout: inWachtrij.verwerkt_reden } : {}) } : { status: 200, uitkomst: 'overgeslagen' };
    }

    // 2. de grenzen (ook voor map en mail, op de ruwe velden), de revisie, de velden en de bijlagen
    const groot = controleerGrenzen(w, bijlagen);
    if (groot) return groot;
    if (w.revisie !== 1) return { status: 400, fout: 'ongeldig', melding: 'Een foto heeft alleen revisie 1' };
    const gelezen = leesFotoVelden(w.velden);
    if (!gelezen.ok) return { status: 400, fout: 'veld-ongeldig', veld: gelezen.veld, melding: gelezen.melding };
    const melding = controleerBijlagen(gelezen.velden.fotos, bijlagen);
    if (melding) return { status: 400, fout: 'ongeldig', melding };
    const velden = gelezen.velden;

    // 3. wat er bewaard wordt (zonder locatie, tenzij toegestaan) en past het bij wat er al staat?
    const opgeslagen = bijlagen.map((b) => (this.keepLocation() ? b : stripJpegGps(b)));
    const items: Bewaard[] = opgeslagen.map((b, i) => ({ pad: fotoPad(w.uuid, i + 1), sha256: sha(b), bytes: b.length }));
    if (this.botst(w.uuid, bijlagen)) {
      this.schrijfRegister(deviceId, w, { uitkomst: 'afgewezen', fout: 'id-botst' }, route);
      return { status: 200, uitkomst: 'afgewezen', fout: 'id-botst' };
    }

    // 4. het project: onbekend wacht (bestanden al op schijf, verwijzingen in de wachtrij), bekend bewaart
    const job = this.db.prepare('SELECT id FROM jobs WHERE uuid = ?').get(velden.project_uuid) as { id: number } | undefined;
    if (!job) {
      // zonder registerrij en zonder foto: alleen een wachtrijrij; een volle wachtrij geeft 503 (herhaalbaar) zonder rij en zonder bestanden
      const r = this.wachtrij.zetIn(deviceId, bron, w, { entiteit: 'project', uuid: velden.project_uuid, reden: 'project-onbekend' }, route);
      if (r === 'vol') return { status: 503, fout: 'wachtrij-vol' };
      const rij = this.wachtrij.rij(deviceId, w.entiteit, w.uuid, w.revisie)!;
      this.schrijfBestanden(opgeslagen, items);
      const voeg = this.db.prepare('INSERT INTO sync_wachtrij_bijlagen (wachtrij_id, volgnr, file_path, sha256, bytes) VALUES (?, ?, ?, ?, ?) ON CONFLICT(wachtrij_id, volgnr) DO NOTHING');
      items.forEach((it, i) => voeg.run(rij.id, i + 1, it.pad, it.sha256, it.bytes));
      return { status: 200, uitkomst: 'wacht' };
    }
    this.schrijfBestanden(opgeslagen, items);
    const uitkomst = this.voegToe(job.id, w.uuid, items, velden.notitie, w.tijd);
    this.schrijfRegister(deviceId, w, uitkomst, route);
    return { status: 200, uitkomst: uitkomst.uitkomst };
  }

  /** De transactie is gelukt: de bestanden die deze aanroep neerzette zijn nu definitief. */
  afgerond(): void {
    this.nieuw = [];
  }

  /**
   * De transactie is mislukt (of teruggedraaid): de bestanden die deze aanroep neerzette horen bij rijen die er niet
   * meer zijn en gaan weg. Lukt het verwijderen niet, dan verdwijnt die fout niet stil: het bestand wordt onthouden,
   * `opruimen` probeert het opnieuw, en het wordt nooit een foto (er is geen rij die ernaar verwijst). De fout
   * komt in het logboek, zonder pad of inhoud. Bestanden die er al stonden (eerdere, bevestigde foto's) blijven altijd staan.
   */
  terugdraaien(): void {
    const paden = this.nieuw;
    this.nieuw = [];
    let mislukt = false;
    for (const pad of paden) if (!this.ruimOp(pad)) mislukt = true;
    if (mislukt) this.log('Een bestand van een mislukte fotoontvangst kon niet worden verwijderd; het wordt later opnieuw geprobeerd en nooit als foto bewaard');
  }

  /** Probeert bestanden van eerdere mislukte ontvangsten alsnog te verwijderen. Gooit nooit. */
  opruimen(): void {
    for (const pad of [...this.teVerwijderen]) {
      try {
        // een bestand waar inmiddels een rij naar verwijst (dezelfde wijziging kwam daarna wel binnen) is geen afval meer
        if (this.isVerwezen(pad)) this.teVerwijderen.delete(pad);
        else this.ruimOp(pad);
      } catch {
        /* volgende keer */
      }
    }
  }

  /**
   * Verwerkt de wachtende rijen van een foto (aangeroepen door SyncWachtrij), in een transactie; geeft true als er een
   * rij is afgehandeld. De wijziging wordt opnieuw gelezen en de bewaarde bestanden opnieuw gecontroleerd. De bestanden
   * blijven waar ze staan: job_photos wijst ernaar. Herhaalbaar en idempotent: een afgehandelde rij wordt niet nog eens verwerkt.
   */
  verwerkObject(uuid: string): boolean {
    if (this.wachtrij.onverwerkt('foto', uuid).length === 0) return false;
    return this.db.transaction(() => {
      let voortgang = false;
      for (const rij of this.wachtrij.onverwerkt('foto', uuid)) {
        const u = this.neemOver(rij);
        if (u.uitkomst === 'wacht') continue;
        const reden = u.uitkomst === 'afgewezen' ? u.fout : null;
        this.schrijfRegister(rij.apparaat_id, { entiteit: 'foto', uuid, revisie: rij.revisie, tijd: rij.tijd }, u, rij.route ?? 'netwerk');
        if (this.wachtrij.markeer(rij.id, u.uitkomst, reden)) voortgang = true;
      }
      return voortgang;
    })();
  }

  // ---------------------------------------------------------------------------------------------

  /** Een wachtrijrij opnieuw lezen, de bestanden controleren en bij een bekend project overnemen. */
  private neemOver(rij: WachtrijRij): Uitkomst {
    let raw: unknown;
    try {
      raw = JSON.parse(rij.wijziging);
    } catch {
      return this.afwijzing('onleesbaar');
    }
    const w = leesWijziging(raw);
    if (!w.ok || w.wijziging.entiteit !== 'foto' || w.wijziging.uuid !== rij.uuid) return this.afwijzing('wijziging');
    const velden = leesFotoVelden(w.wijziging.velden);
    if (!velden.ok) return this.afwijzing(`${velden.veld}: ${velden.melding}`);

    // de bewaarde bestanden: evenveel als in de velden, en elk bestand is nog wat er bewaard werd
    const refs = this.db.prepare('SELECT volgnr, file_path, sha256, bytes FROM sync_wachtrij_bijlagen WHERE wachtrij_id = ? ORDER BY volgnr').all(rij.id) as { volgnr: number; file_path: string; sha256: string; bytes: number }[];
    if (refs.length !== velden.velden.fotos.length || refs.some((r, i) => r.volgnr !== i + 1)) return this.afwijzing('bijlagen');
    for (const r of refs) {
      let data: Buffer;
      try {
        data = readFileSync(resolveAttachmentPath(this.adminDir, r.file_path));
      } catch (e) {
        // een bestand dat er niet is, is weg; een andere leesfout (bv. tijdelijk in gebruik) is later opnieuw proberen
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return this.afwijzing('bijlage ontbreekt');
        if (!(e as NodeJS.ErrnoException).code) return this.afwijzing('bijlage-pad');
        throw e;
      }
      if (data.length !== r.bytes || sha(data) !== r.sha256 || !jpegInfo(data)) return this.afwijzing('bijlage klopt niet');
    }

    const job = this.db.prepare('SELECT id FROM jobs WHERE uuid = ?').get(velden.velden.project_uuid) as { id: number } | undefined;
    if (!job) return { uitkomst: 'wacht' };
    return this.voegToe(job.id, rij.uuid, refs.map((r) => ({ pad: r.file_path, sha256: r.sha256, bytes: r.bytes })), velden.velden.notitie, w.wijziging.tijd);
  }

  private afwijzing(reden: string): Uitkomst {
    this.log(`Wachtende fotowijziging afgewezen bij het verwerken (${reden})`);
    return { uitkomst: 'afgewezen', fout: reden === 'bijlagen' || reden.startsWith('bijlage') ? 'ongeldig' : 'veld-ongeldig' };
  }

  /**
   * Bewaart de rijen van een foto bij een project. Staan er al rijen onder deze wijziging-uuid (bv. van een ander
   * apparaat), dan wordt er niets bijgeschreven: dezelfde inhoud is overgeslagen, een andere inhoud id-botst.
   */
  private voegToe(jobId: number, uuid: string, items: Bewaard[], notitie: string | null, tijd: number): Klaar {
    const bestaand = this.db.prepare('SELECT volgnr, sha256 FROM job_photos WHERE wijziging_uuid = ? ORDER BY volgnr').all(uuid) as { volgnr: number; sha256: string }[];
    if (bestaand.length > 0) {
      const gelijk = bestaand.length === items.length && bestaand.every((b, i) => b.volgnr === i + 1 && b.sha256 === items[i]!.sha256);
      return gelijk ? { uitkomst: 'overgeslagen' } : { uitkomst: 'afgewezen', fout: 'id-botst' };
    }
    const voeg = this.db.prepare('INSERT INTO job_photos (job_id, wijziging_uuid, volgnr, file_path, sha256, bytes, notitie, tijd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    items.forEach((it, i) => voeg.run(jobId, uuid, i + 1, it.pad, it.sha256, it.bytes, notitie, tijd));
    return { uitkomst: 'toegepast' };
  }

  /**
   * Past de inhoud van deze foto niet bij wat er al onder deze wijziging-uuid bewaard is (job_photos) of wacht
   * (verwijzingen in sync_wachtrij_bijlagen)? Zowel met als zonder locatie telt als dezelfde foto.
   */
  private botst(uuid: string, bijlagen: Buffer[]): boolean {
    const bestaand = this.db.prepare('SELECT volgnr, sha256 FROM job_photos WHERE wijziging_uuid = ?').all(uuid) as { volgnr: number; sha256: string }[];
    if (bestaand.length > 0 && bestaand.length !== bijlagen.length) return true;
    const alsVerwezen = this.db.prepare('SELECT sha256 FROM job_photos WHERE file_path = ? UNION ALL SELECT sha256 FROM sync_wachtrij_bijlagen WHERE file_path = ?');
    for (let i = 0; i < bijlagen.length; i++) {
      const pad = fotoPad(uuid, i + 1);
      const staat = alsVerwezen.all(pad, pad) as { sha256: string }[];
      if (staat.length === 0) continue;
      const toegestaan = new Set([sha(bijlagen[i]!), sha(stripJpegGps(bijlagen[i]!))]);
      if (staat.some((s) => !toegestaan.has(s.sha256))) return true;
    }
    return false;
  }

  /** Schrijft de bestanden, exclusief aangemaakt. Bestaat een bestand al, dan moet de inhoud gelijk zijn (anders een fout). */
  private schrijfBestanden(inhoud: Buffer[], items: Bewaard[]): void {
    inhoud.forEach((data, i) => {
      const pad = items[i]!.pad;
      const abs = resolveAttachmentPath(this.adminDir, pad);
      mkdirSync(dirname(abs), { recursive: true });
      let fd: number;
      try {
        fd = openSync(abs, 'wx', 0o600);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        // het bestand stond er al (een achtergebleven bestand of dezelfde foto van een ander apparaat): gelijk is goed
        if (!readFileSync(abs).equals(data)) throw new Error('Een fotobestand met een andere inhoud staat er al');
        return;
      }
      this.nieuw.push(pad);
      try {
        writeSync(fd, data);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    });
  }

  /** Verwijdert een net neergezet bestand (en zijn lege map); geeft false en onthoudt het als dat niet lukt. */
  private ruimOp(pad: string): boolean {
    try {
      const abs = resolveAttachmentPath(this.adminDir, pad);
      this.verwijder(abs);
      this.teVerwijderen.delete(pad);
      try {
        rmdirSync(dirname(abs));
      } catch {
        /* niet leeg of al weg */
      }
      return true;
    } catch {
      this.teVerwijderen.add(pad);
      return false;
    }
  }

  private isVerwezen(pad: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM job_photos WHERE file_path = ? UNION ALL SELECT 1 FROM sync_wachtrij_bijlagen WHERE file_path = ? LIMIT 1').get(pad, pad));
  }

  private schrijfRegister(deviceId: string, w: Pick<Wijziging, 'entiteit' | 'uuid' | 'revisie' | 'tijd'>, uitkomst: Klaar, route: string): void {
    const fout = uitkomst.uitkomst === 'afgewezen' ? uitkomst.fout : null;
    this.db
      .prepare(
        `INSERT INTO sync_ontvangen (apparaat_id, entiteit, uuid, revisie, tijd, ontvangen_op, uitkomst, fout, route) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(apparaat_id, entiteit, uuid, revisie) DO NOTHING`,
      )
      .run(deviceId, w.entiteit, w.uuid, w.revisie, w.tijd, this.now(), uitkomst.uitkomst, fout, route);
  }
}
