import { tx, type Db } from '../db/database';
import { ValidationError } from '../shared/validation';

/**
 * Reeksbewaking voor facturen van een telefoon. Een reeks is (apparaat_code, reeks_jaar) en loopt vanaf 1 tot het
 * hoogste volgnummer van een geimporteerde factuur. Een GAT is een aaneengesloten bereik volgnummers dat ontbreekt.
 *
 * Een volgnummer telt als bekend als er een factuur met dat nummer is, als een onverwerkte rij in sync_wachtrij
 * dat nummer draagt (de factuur komt dan nog) of als de gebruiker het als vervallen heeft gemarkeerd. Alles wat
 * overblijft is een gat. Niets wordt ooit gewijzigd of weggehaald: een markering is een rij erbij.
 *
 * De berekening gebruikt bereiken en SQL (een venster over de bekende nummers), nooit een lijst van alle
 * denkbare nummers: een telefoon die naar volgnummer 999999999 springt, kost een gat en een rij.
 */

/** Hoeveel nummers de gebruiker in een keer als vervallen kan markeren (de telefoon kiest de grootte van een gat, niet de pc). */
export const MAX_VERVALLEN_PER_MARKERING = 10000;
/** Hoe lang de reden hoogstens mag zijn (CONTRACT R6). */
export const MAX_REDEN_TEKENS = 4000;

/** De twee standaardredenen van de knoppen op Vandaag. */
export const REDEN_NIET_GEBRUIKT = 'Nummer nooit gebruikt';
export const REDEN_NIET_VERSTUURD = 'Factuur niet verstuurd of concept vervallen';

export interface ReeksGat {
  apparaat_code: string;
  reeks_jaar: number;
  /** het eerste ontbrekende volgnummer */
  van: number;
  /** het laatste ontbrekende volgnummer (gelijk aan van bij een enkel nummer) */
  tot: number;
  /** de apparaatcode is afgesloten (de telefoon is ontkoppeld): er komt niets meer van dat apparaat */
  afgesloten: boolean;
}

export interface ReeksOpties {
  now?: () => number;
}

const APPARAATCODE = /^M[1-9][0-9]*$/;

/** Het volgnummer in de canonieke vorm, bijvoorbeeld M1-2026-0003. */
export function reeksNummer(apparaat_code: string, reeks_jaar: number, reeks_volgnr: number): string {
  return `${apparaat_code}-${reeks_jaar}-${String(reeks_volgnr).padStart(4, '0')}`;
}

/**
 * De onverwerkte wachtrijrijen met een nummer, als (apparaat_code, reeks_jaar, reeks_volgnr). Een rij met een
 * nummer dat niet de vorm M1-2026-0001 heeft, telt niet mee. De vorm wordt in SQL gelezen, zodat er geen lijst in het geheugen komt.
 */
const WACHTEND_SQL = `
  SELECT substr(nummer, 1, instr(nummer, '-') - 1) AS apparaat_code,
         CAST(substr(nummer, instr(nummer, '-') + 1, 4) AS INTEGER) AS reeks_jaar,
         CAST(substr(nummer, instr(nummer, '-') + 6) AS INTEGER) AS reeks_volgnr
    FROM sync_wachtrij
   WHERE verwerkt_op IS NULL
     AND nummer GLOB 'M[1-9]*-[0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]*'
     AND nummer NOT GLOB '*[^-M0-9]*'`;

export class ReeksBewaking {
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    opties: ReeksOpties = {},
  ) {
    this.now = opties.now ?? Date.now;
  }

  /** Alle gaten, per apparaat en jaar oplopend op volgnummer: deterministisch gesorteerd. */
  gaten(): ReeksGat[] {
    const rijen = this.db
      .prepare(
        `WITH bekend(apparaat_code, reeks_jaar, reeks_volgnr) AS (
           SELECT apparaat_code, reeks_jaar, reeks_volgnr FROM invoices WHERE apparaat_code IS NOT NULL
           UNION SELECT apparaat_code, reeks_jaar, reeks_volgnr FROM factuur_reeks_vervallen
           UNION ${WACHTEND_SQL}
         ),
         hoogste AS (
           SELECT apparaat_code, reeks_jaar, MAX(reeks_volgnr) AS hoogste FROM invoices WHERE apparaat_code IS NOT NULL GROUP BY apparaat_code, reeks_jaar
         ),
         met_vorige AS (
           SELECT b.apparaat_code, b.reeks_jaar, b.reeks_volgnr,
                  LAG(b.reeks_volgnr, 1, 0) OVER (PARTITION BY b.apparaat_code, b.reeks_jaar ORDER BY b.reeks_volgnr) AS vorige
             FROM bekend b JOIN hoogste h ON h.apparaat_code = b.apparaat_code AND h.reeks_jaar = b.reeks_jaar
            WHERE b.reeks_volgnr >= 1 AND b.reeks_volgnr <= h.hoogste
         )
         SELECT m.apparaat_code, m.reeks_jaar, m.vorige + 1 AS van, m.reeks_volgnr - 1 AS tot,
                EXISTS (SELECT 1 FROM scanner_device_codes c WHERE c.code = m.apparaat_code AND c.afgesloten_op IS NOT NULL) AS afgesloten
           FROM met_vorige m
          WHERE m.reeks_volgnr - m.vorige > 1
          ORDER BY m.apparaat_code, m.reeks_jaar, van`,
      )
      .all() as { apparaat_code: string; reeks_jaar: number; van: number; tot: number; afgesloten: number }[];
    return rijen.map((r) => ({ apparaat_code: r.apparaat_code, reeks_jaar: r.reeks_jaar, van: r.van, tot: r.tot, afgesloten: r.afgesloten === 1 }));
  }

  /** De markeringen als vervallen van een reeks, voor weergave en controle (nooit gewijzigd). */
  vervallen(apparaat_code: string, reeks_jaar: number): { reeks_volgnr: number; reden: string; gemarkeerd_op: string }[] {
    return this.db
      .prepare('SELECT reeks_volgnr, reden, gemarkeerd_op FROM factuur_reeks_vervallen WHERE apparaat_code = ? AND reeks_jaar = ? ORDER BY reeks_volgnr')
      .all(apparaat_code, reeks_jaar) as { reeks_volgnr: number; reden: string; gemarkeerd_op: string }[];
  }

  /**
   * Markeert het hele bereik van, tot en met tot als vervallen, in een transactie. Alles of niets: bij een fout
   * blijft er niets bewaard. Geweigerd met een Nederlandse melding bij een lege reden (alleen spaties telt als
   * leeg), een ongeldige reeks of ongeldig bereik, een bereik van meer dan MAX_VERVALLEN_PER_MARKERING nummers
   * en een bereik dat een bestaande factuur, een wachtend nummer of een al vervallen nummer bevat of boven de
   * reeks uitkomt. Geeft het aantal gemarkeerde nummers.
   */
  markeerVervallen(apparaat_code: string, reeks_jaar: number, van: number, tot: number, reden: string): number {
    if (typeof reden !== 'string' || reden.trim() === '') throw new ValidationError('Geef een reden op waarom dit nummer vervalt.');
    const schoneReden = reden.trim();
    if (schoneReden.length > MAX_REDEN_TEKENS) throw new ValidationError(`De reden mag hoogstens ${MAX_REDEN_TEKENS} tekens hebben.`);
    if (typeof apparaat_code !== 'string' || !APPARAATCODE.test(apparaat_code)) throw new ValidationError('Onbekende apparaatcode.');
    if (!Number.isSafeInteger(reeks_jaar) || reeks_jaar < 1000 || reeks_jaar > 9999) throw new ValidationError('Het jaar van de reeks klopt niet.');
    if (!Number.isSafeInteger(van) || !Number.isSafeInteger(tot) || van < 1 || tot < van) throw new ValidationError('Het bereik klopt niet: het eerste nummer moet vanaf 1 lopen en hoogstens gelijk zijn aan het laatste.');
    if (tot - van + 1 > MAX_VERVALLEN_PER_MARKERING) throw new ValidationError(`Je kunt hoogstens ${MAX_VERVALLEN_PER_MARKERING} nummers in een keer als vervallen markeren. Markeer het bereik in delen.`);

    const bereik = `${reeksNummer(apparaat_code, reeks_jaar, van)}${tot > van ? ` tot en met ${reeksNummer(apparaat_code, reeks_jaar, tot)}` : ''}`;
    return tx(this.db, () => {
      const tel = (sql: string): number => (this.db.prepare(sql).pluck().get(apparaat_code, reeks_jaar, van, tot) as number);
      const hoogste = this.db.prepare('SELECT MAX(reeks_volgnr) FROM invoices WHERE apparaat_code = ? AND reeks_jaar = ?').pluck().get(apparaat_code, reeks_jaar) as number | null;
      if (hoogste === null || tot > hoogste) throw new ValidationError(`${bereik} ligt niet binnen de reeks: er is nog geen hoger nummer ontvangen, dus er ontbreekt niets.`);
      if (tel('SELECT COUNT(*) FROM invoices WHERE apparaat_code = ? AND reeks_jaar = ? AND reeks_volgnr BETWEEN ? AND ?') > 0) {
        throw new ValidationError(`${bereik} bevat een nummer waar al een factuur van is. Dat nummer kan niet vervallen.`);
      }
      if (tel(`SELECT COUNT(*) FROM (${WACHTEND_SQL}) w WHERE w.apparaat_code = ? AND w.reeks_jaar = ? AND w.reeks_volgnr BETWEEN ? AND ?`) > 0) {
        throw new ValidationError(`${bereik} bevat een nummer dat nog in de wachtrij staat: de factuur komt nog. Dat nummer kan niet vervallen.`);
      }
      if (tel('SELECT COUNT(*) FROM factuur_reeks_vervallen WHERE apparaat_code = ? AND reeks_jaar = ? AND reeks_volgnr BETWEEN ? AND ?') > 0) {
        throw new ValidationError(`${bereik} bevat een nummer dat al als vervallen is gemarkeerd.`);
      }
      // laatste controle op het gat zelf: het hele bereik moet in een gat liggen
      if (!this.gaten().some((g) => g.apparaat_code === apparaat_code && g.reeks_jaar === reeks_jaar && g.van <= van && tot <= g.tot)) {
        throw new ValidationError(`${bereik} ontbreekt niet (meer) in de reeks.`);
      }
      const gemarkeerd = new Date(this.now()).toISOString();
      return this.db
        .prepare(
          `WITH RECURSIVE r(n) AS (SELECT ? UNION ALL SELECT n + 1 FROM r WHERE n < ?)
           INSERT INTO factuur_reeks_vervallen (apparaat_code, reeks_jaar, reeks_volgnr, reden, gemarkeerd_op)
           SELECT ?, ?, n, ?, ? FROM r WHERE true
           ON CONFLICT(apparaat_code, reeks_jaar, reeks_volgnr) DO NOTHING`,
        )
        .run(van, tot, apparaat_code, reeks_jaar, schoneReden, gemarkeerd).changes;
    });
  }
}
