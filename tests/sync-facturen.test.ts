import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeTotals, type LineInput, type Wijziging } from '@gratis-boekhouden/kern';
import { setup } from './helpers';
import { RelationsService } from '../src/relations/relations';
import { SyncOntvangst } from '../src/sync/ontvangst';
import { counterKey } from '../src/documents/numbering';
import { Bonnenscanner } from '../src/scanner/scanner';
import { ScannerPairing } from '../src/scanner/pairing';
import { LIMITS, ProtocolError, encodeFrame, parseFrame } from '../src/scanner/protocol';

// De pc-kant van een factuurwijziging van de telefoon (docs/bonnenscanner-protocol.md): direct aannemen via
// SyncOntvangst.verwerk en FactuurOntvangst, met een echte databank, echte klassen en relatieve datums.

const APPARAAT = 'apparaat-1';
const BRON = 'M1';
const DAG = 24 * 60 * 60 * 1000;

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** de factuurdatum: tien dagen geleden, de vervaldatum een maand later; het jaar volgt de datum */
const DATUM = iso(Date.now() - 10 * DAG);
const VERVAL = iso(Date.now() + 20 * DAG);
const JAAR = DATUM.slice(0, 4);
const nummer = (volgnr: number, code = BRON) => `${code}-${JAAR}-${String(volgnr).padStart(4, '0')}`;

const KLANT = { name: 'Bakkerij De Korst', address: 'Dorpsstraat 1', city: 'Utrecht', country: 'NL', vat_number: 'NL123456789B01', kvk_number: '12345678', email: 'info@korst.example' };
const BEDRIJF = { name: 'Jansen Klus', address: 'Werfstraat 2', city: 'Zwolle', kvkNumber: '87654321', vatNumber: 'NL987654321B01', kor: false };
type Regel = { omschrijving: string; hoeveelheid: number; prijs: number; btw_soort: string; eenheid?: string };
const HOOG: Regel = { omschrijving: 'Montage', hoeveelheid: 2, prijs: 4550, btw_soort: 'hoog', eenheid: 'uur' };
const LAAG: Regel = { omschrijving: 'Boeken', hoeveelheid: 3, prijs: 1000, btw_soort: 'laag' };

/** De velden van een factuurwijziging, doorgerekend met de kern; `over` overschrijft of voegt velden toe. */
function velden(klantUuid: string, regels: Regel[] = [HOOG, LAAG], over: Record<string, unknown> = {}): Record<string, unknown> {
  const t = computeTotals(regels.map((r): LineInput => ({ description: r.omschrijving, quantity: r.hoeveelheid, unitPrice: r.prijs, vatCode: r.btw_soort as LineInput['vatCode'] })));
  return {
    nummer: nummer(1),
    datum: DATUM,
    vervaldatum: VERVAL,
    klant_uuid: klantUuid,
    klant_momentopname: { ...KLANT },
    bedrijf_momentopname: { ...BEDRIJF },
    regels,
    totalen: { subtotaal: t.subtotal, btw: t.vatTotal, totaal: t.total },
    verzonden_op: `${DATUM} 10:30:00`,
    regeltabel_versie: '2026-1',
    ...over,
  };
}

function omgeving() {
  const t = setup();
  const sync = new SyncOntvangst(t.db, new RelationsService(t.db), { now: () => Date.now(), invoices: t.s.invoices });
  const klantUuid = randomUUID();
  const eerste = sync.verwerk(APPARAAT, BRON, { entiteit: 'klant', uuid: klantUuid, revisie: 1, tijd: Date.now() - 5 * DAG, velden: { naam: KLANT.name } });
  expect(eerste).toMatchObject({ status: 200, uitkomst: 'toegepast' });
  const factuur = (v: Record<string, unknown>, over: Partial<Wijziging> = {}, route = 'netwerk', bron = BRON) =>
    sync.verwerk(APPARAAT, bron, { entiteit: 'factuur', uuid: randomUUID(), revisie: 1, tijd: Date.now() - DAG, velden: v, ...over }, route);
  return { ...t, sync, klantUuid, factuur };
}
type Omg = ReturnType<typeof omgeving>;

const n = (db: Database.Database, sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
/** De tabellen waar een factuur iets achterlaat (sync_ontvangen alleen voor de entiteit factuur). */
function telling(db: Database.Database) {
  return {
    invoices: n(db, 'SELECT COUNT(*) AS n FROM invoices'),
    invoice_lines: n(db, 'SELECT COUNT(*) AS n FROM invoice_lines'),
    journal_entries: n(db, 'SELECT COUNT(*) AS n FROM journal_entries'),
    sync_wachtrij: n(db, 'SELECT COUNT(*) AS n FROM sync_wachtrij'),
    sync_ontvangen: n(db, `SELECT COUNT(*) AS n FROM sync_ontvangen WHERE entiteit = 'factuur'`),
  };
}
const register = (db: Database.Database, uuid: string) => db.prepare('SELECT uitkomst, fout, route FROM sync_ontvangen WHERE entiteit = ? AND uuid = ?').all('factuur', uuid);
const factuurRij = (db: Database.Database, uuid: string) => db.prepare('SELECT * FROM invoices WHERE uuid = ?').get(uuid) as Record<string, unknown> | undefined;

describe('factuurwijziging van de telefoon op de pc', () => {
  it('FACT-01 overgenomen: geldige factuur van bekende klant geeft toegepast, een invoices-rij met nummer, de relation_snapshot uit de payload, een journal_entry en een registerrij toegepast', () => {
    const o = omgeving();
    const uuid = randomUUID();
    const voor = telling(o.db);
    const r = o.factuur(velden(o.klantUuid), { uuid });
    expect(r).toEqual({ status: 200, uitkomst: 'toegepast' });
    const rij = factuurRij(o.db, uuid)!;
    expect(rij).toMatchObject({ number: nummer(1), status: 'verzonden', apparaat_code: BRON, reeks_jaar: Number(JAAR), reeks_volgnr: 1, invoice_date: DATUM, job_id: null });
    expect(rij.relation_id).toBe(o.db.prepare('SELECT id FROM relations WHERE uuid = ?').pluck().get(o.klantUuid));
    expect(JSON.parse(rij.relation_snapshot as string)).toMatchObject(KLANT);
    expect(rij.journal_entry_id).not.toBeNull();
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM journal_entries WHERE id = ?', rij.journal_entry_id)).toBe(1);
    expect(telling(o.db)).toEqual({ ...voor, invoices: voor.invoices + 1, invoice_lines: voor.invoice_lines + 2, journal_entries: voor.journal_entries + 1, sync_ontvangen: voor.sync_ontvangen + 1 });
    expect(register(o.db, uuid)).toEqual([{ uitkomst: 'toegepast', fout: null, route: 'netwerk' }]);
  });

  it('FACT-02 dubbel: dezelfde wijziging opnieuw geeft overgeslagen en de rijtellingen van invoices, invoice_lines, journal_entries en sync_ontvangen blijven gelijk', () => {
    const o = omgeving();
    const w = { uuid: randomUUID() };
    expect(o.factuur(velden(o.klantUuid), w)).toMatchObject({ uitkomst: 'toegepast' });
    const na = telling(o.db);
    const totaal = n(o.db, 'SELECT COUNT(*) AS n FROM sync_ontvangen');
    expect(o.factuur(velden(o.klantUuid), w)).toEqual({ status: 200, uitkomst: 'overgeslagen' });
    expect(telling(o.db)).toEqual(na);
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM sync_ontvangen')).toBe(totaal);
    expect(na.invoices).toBe(1);
  });

  it('FACT-03 dubbel via andere route: verwerk() met route map op dezelfde sleutel geeft overgeslagen en geen nieuwe rijen', () => {
    const o = omgeving();
    const w = { uuid: randomUUID() };
    expect(o.factuur(velden(o.klantUuid), w, 'netwerk')).toMatchObject({ uitkomst: 'toegepast' });
    const na = telling(o.db);
    expect(o.factuur(velden(o.klantUuid), w, 'map')).toEqual({ status: 200, uitkomst: 'overgeslagen' });
    expect(telling(o.db)).toEqual(na);
    expect(register(o.db, w.uuid)).toEqual([{ uitkomst: 'toegepast', fout: null, route: 'netwerk' }]);
  });

  it('FACT-04 onveranderlijk: zelfde uuid, hogere revisie en andere bedragen geeft overgeslagen en het bedrag in invoices blijft gelijk', () => {
    const o = omgeving();
    const uuid = randomUUID();
    expect(o.factuur(velden(o.klantUuid, [HOOG]), { uuid })).toMatchObject({ uitkomst: 'toegepast' });
    const voor = factuurRij(o.db, uuid)!;
    const totaalVoor = voor.total;
    const na = telling(o.db);
    const duurder = velden(o.klantUuid, [{ ...HOOG, prijs: 9999 }]);
    expect(o.factuur(duurder, { uuid, revisie: 2 })).toEqual({ status: 200, uitkomst: 'overgeslagen' });
    // ook dezelfde revisie met andere inhoud: de registersleutel is al gezien
    expect(o.factuur(duurder, { uuid, revisie: 1 })).toEqual({ status: 200, uitkomst: 'overgeslagen' });
    expect(factuurRij(o.db, uuid)).toEqual(voor);
    expect(factuurRij(o.db, uuid)!.total).toBe(totaalVoor);
    expect(telling(o.db)).toEqual({ ...na, sync_ontvangen: na.sync_ontvangen + 1 });
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM invoice_lines')).toBe(1);
  });

  it('FACT-05 apparaatcode fout: een nummer waarvan de apparaatcode niet gelijk is aan bron geeft 400 ongeldig en nul nieuwe rijen in invoices, invoice_lines, journal_entries, sync_wachtrij en sync_ontvangen', () => {
    const o = omgeving();
    const voor = telling(o.db);
    const totaalVoor = n(o.db, 'SELECT COUNT(*) AS n FROM sync_ontvangen');
    const r = o.factuur(velden(o.klantUuid, [HOOG], { nummer: nummer(1, 'M2') }));
    expect(r).toMatchObject({ status: 400, fout: 'ongeldig' });
    expect(r.uitkomst).toBeUndefined();
    expect(telling(o.db)).toEqual(voor);
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM sync_ontvangen')).toBe(totaalVoor);
    // dezelfde factuur van het juiste apparaat wordt wel overgenomen
    expect(o.factuur(velden(o.klantUuid, [HOOG]))).toMatchObject({ status: 200, uitkomst: 'toegepast' });
  });

  it('FACT-06 ongeldige velden: onbekend veld, __proto__, te veel velden en een hoeveelheid met meer dan drie decimalen geven 400 veld-ongeldig en nul rijen', () => {
    const o = omgeving();
    const voor = telling(o.db);
    const totaalVoor = n(o.db, 'SELECT COUNT(*) AS n FROM sync_ontvangen');
    const geldig = velden(o.klantUuid);
    const metProto = JSON.parse(JSON.stringify(geldig).replace(/^\{/, '{"__proto__":{"x":1},')) as Record<string, unknown>;
    const teVeel = velden(o.klantUuid, Array.from({ length: 201 }, () => ({ ...LAAG })));
    const decimalen = velden(o.klantUuid, [{ ...LAAG, hoeveelheid: 1.0005 }]);
    const gevallen: [string, Record<string, unknown>, string][] = [
      ['onbekend veld', { ...geldig, kleur: 'rood' }, 'kleur'],
      ['__proto__', metProto, '__proto__'],
      ['te veel regels', teVeel, 'regels'],
      ['drie decimalen', decimalen, 'regels[0].hoeveelheid'],
    ];
    for (const [naam, v, veld] of gevallen) {
      const r = o.factuur(v);
      expect(r, naam).toMatchObject({ status: 400, fout: 'veld-ongeldig', veld });
      expect(r.melding, naam).toEqual(expect.any(String));
    }
    expect(telling(o.db)).toEqual(voor);
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM sync_ontvangen')).toBe(totaalVoor);
    // de grens maxWijzigingJsonBytes geldt op bytes: ruim onder 128 KiB aan tekens, maar erboven aan bytes
    const tweebyte = (tekens: number) => encodeFrame({ soort: 'wijziging', tijd: Date.now(), wijziging: { entiteit: 'factuur', uuid: randomUUID(), revisie: 1, tijd: Date.now(), velden: { opmerking: 'é'.repeat(tekens) } } });
    const ruim = tweebyte(LIMITS.maxWijzigingJsonBytes / 2 + 100);
    expect(JSON.stringify({ x: 'é'.repeat(LIMITS.maxWijzigingJsonBytes / 2 + 100) }).length).toBeLessThan(LIMITS.maxWijzigingJsonBytes);
    expect(() => parseFrame(ruim, 2)).toThrow(ProtocolError);
    expect(() => parseFrame(ruim, 2)).toThrow(/te groot/);
    try {
      parseFrame(ruim, 2);
    } catch (e) {
      expect((e as ProtocolError).code).toBe('te-groot');
    }
  });

  it('FACT-07 nummer-bezet: een bestaand nummer bij een andere uuid geeft 200 afgewezen met fout nummer-bezet, een registerrij afgewezen en geen nieuwe factuur', () => {
    const o = omgeving();
    expect(o.factuur(velden(o.klantUuid, [HOOG]))).toMatchObject({ uitkomst: 'toegepast' });
    const voor = telling(o.db);
    const uuid = randomUUID();
    const r = o.factuur(velden(o.klantUuid, [LAAG]), { uuid });
    expect(r).toMatchObject({ status: 200, uitkomst: 'afgewezen', fout: 'nummer-bezet' });
    expect(factuurRij(o.db, uuid)).toBeUndefined();
    expect(register(o.db, uuid)).toEqual([{ uitkomst: 'afgewezen', fout: 'nummer-bezet', route: 'netwerk' }]);
    expect(telling(o.db)).toEqual({ ...voor, sync_ontvangen: voor.sync_ontvangen + 1 });
    // een herhaling levert dezelfde afwijzing zonder nieuwe rijen
    expect(o.factuur(velden(o.klantUuid, [LAAG]), { uuid })).toMatchObject({ status: 200, uitkomst: 'afgewezen', fout: 'nummer-bezet' });
    expect(telling(o.db)).toEqual({ ...voor, sync_ontvangen: voor.sync_ontvangen + 1 });
    // een creditnota bij een onbekend origineel wacht sinds s12b in de wachtrij (reden origineel-onbekend)
    const credit = velden(o.klantUuid, [{ ...HOOG, hoeveelheid: -2 }], { nummer: nummer(2), creditnota_van: randomUUID() });
    expect(o.factuur(credit)).toMatchObject({ status: 200, uitkomst: 'wacht' });
    expect(telling(o.db).invoices).toBe(voor.invoices);
    // een periode bij de boekhouder wacht sinds s12b (reden periode)
    // tot twee dagen geleden, maar nooit tot en met 31 december: dan vraagt de echte service om een jaarafsluitingsbevestiging
    let tot = Date.now() - 2 * DAG;
    while (iso(tot).slice(5) === '12-31') tot -= DAG;
    o.s.periods.startExchange(iso(tot), 7, [], iso(Date.now()));
    const vast = o.factuur(velden(o.klantUuid, [HOOG], { nummer: nummer(3) }));
    expect(vast).toMatchObject({ status: 200, uitkomst: 'wacht' });
    expect(telling(o.db).invoices).toBe(voor.invoices);
  });

  it('FACT-08 alias: een klant_uuid van een samengevoegde klant (relation_aliases) wijst naar de doelklant en de momentopname houdt de gegevens uit de payload', () => {
    const o = omgeving();
    const doel = o.db.prepare('SELECT id FROM relations WHERE uuid = ?').pluck().get(o.klantUuid) as number;
    const alias = randomUUID();
    o.db.prepare(`INSERT INTO relation_aliases (alias_uuid, relation_id, aangemaakt_op) VALUES (?, ?, ?)`).run(alias, doel, new Date().toISOString());
    const uuid = randomUUID();
    const momentopname = { ...KLANT, name: 'Oude naam van de samengevoegde klant' };
    expect(o.factuur(velden(alias, [HOOG], { klant_momentopname: momentopname }), { uuid })).toMatchObject({ status: 200, uitkomst: 'toegepast' });
    const rij = factuurRij(o.db, uuid)!;
    expect(rij.relation_id).toBe(doel);
    expect(JSON.parse(rij.relation_snapshot as string).name).toBe('Oude naam van de samengevoegde klant');
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM relations WHERE name = ?', 'Oude naam van de samengevoegde klant')).toBe(0);
    // een creditnota hoort bij de klant van het origineel: een andere klant wordt afgewezen
    const andere = randomUUID();
    expect(o.sync.verwerk(APPARAAT, BRON, { entiteit: 'klant', uuid: andere, revisie: 1, tijd: Date.now() - DAG, velden: { naam: 'Andere klant' } })).toMatchObject({ uitkomst: 'toegepast' });
    const voor = telling(o.db);
    const credit = (klant: string, volgnr: number) => velden(klant, [{ ...HOOG, hoeveelheid: -2 }], { nummer: nummer(volgnr), creditnota_van: uuid });
    expect(o.factuur(credit(andere, 2))).toMatchObject({ status: 200, uitkomst: 'afgewezen', fout: 'factuur-geweigerd' });
    expect(telling(o.db).invoices).toBe(voor.invoices);
    expect(o.factuur(credit(alias, 3))).toMatchObject({ status: 200, uitkomst: 'toegepast' });
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM invoices WHERE credit_of_invoice_id = ? AND relation_id = ?', rij.id, doel)).toBe(1);
  });

  it('FACT-09 gearchiveerde klant: de factuur wordt gewoon overgenomen', () => {
    const o = omgeving();
    o.db.prepare('UPDATE relations SET archived = 1 WHERE uuid = ?').run(o.klantUuid);
    const uuid = randomUUID();
    expect(o.factuur(velden(o.klantUuid), { uuid })).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(factuurRij(o.db, uuid)).toMatchObject({ number: nummer(1), status: 'verzonden' });
    expect(n(o.db, 'SELECT archived AS n FROM relations WHERE uuid = ?', o.klantUuid)).toBe(1);
    // een onbekende klant en een leverancier wachten sinds s12b in de wachtrij: geen factuur, geen registerrij
    const voor = telling(o.db);
    expect(o.factuur(velden(randomUUID(), [HOOG], { nummer: nummer(2) }))).toMatchObject({ status: 200, uitkomst: 'wacht' });
    const leverancier = randomUUID();
    o.db.prepare(`INSERT INTO relations (type, name, uuid) VALUES ('leverancier', 'Groothandel', ?)`).run(leverancier);
    expect(o.factuur(velden(leverancier, [HOOG], { nummer: nummer(3) }))).toMatchObject({ status: 200, uitkomst: 'wacht' });
    expect(telling(o.db)).toEqual({ ...voor, sync_wachtrij: voor.sync_wachtrij + 2 });
  });

  it('FACT-10 pc-teller en register: de waarde van counter:factuur:<jaar> is voor en na gelijk, en per verwerkte factuur staat er een registerrij in dezelfde transactie', () => {
    const o = omgeving();
    const pc = o.s.invoices.finalize(o.s.invoices.createDraft({ relationId: o.klant.id, invoiceDate: DATUM, lines: [{ description: 'Pc-werk', quantity: 1, unitPrice: 1000, vatCode: 'hoog' }] }).id);
    expect(pc.number).toBeTruthy();
    const sleutel = counterKey('factuur', o.s.settings.get().invoiceNumberFormat, DATUM);
    const tellers = () => o.db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'counter:%' ORDER BY key`).all();
    const voor = o.s.settings.peekCounter(sleutel);
    const voorAlles = tellers();
    expect(voor).toBe(1);
    expect(voorAlles.map((x) => (x as { key: string }).key)).toContain(`counter:factuur:${JAAR}`);
    const uuids = [randomUUID(), randomUUID(), randomUUID()];
    uuids.forEach((uuid, i) => expect(o.factuur(velden(o.klantUuid, [HOOG], { nummer: nummer(i + 1) }), { uuid })).toMatchObject({ uitkomst: 'toegepast' }));
    expect(o.s.settings.peekCounter(sleutel)).toBe(voor);
    expect(tellers()).toEqual(voorAlles);
    for (const uuid of uuids) expect(register(o.db, uuid)).toEqual([{ uitkomst: 'toegepast', fout: null, route: 'netwerk' }]);
    expect(n(o.db, `SELECT COUNT(*) AS n FROM sync_ontvangen WHERE entiteit = 'factuur'`)).toBe(3);
  });

  it('FACT-11 halve rijen: een geforceerde fout midden in de transactie geeft 500 opslaan-mislukt en nul rijen in invoices, invoice_lines, journal_entries en sync_ontvangen', () => {
    const o = omgeving();
    const voor = telling(o.db);
    const totaalVoor = n(o.db, 'SELECT COUNT(*) AS n FROM sync_ontvangen');
    const regelsVoor = n(o.db, 'SELECT COUNT(*) AS n FROM journal_lines');
    // de registerrij is de laatste stap: de factuur, de regels en de boeking staan dan al in de transactie
    o.db.exec(`CREATE TRIGGER forceer_fout BEFORE INSERT ON sync_ontvangen WHEN NEW.entiteit = 'factuur' BEGIN SELECT RAISE(ABORT, 'geforceerde fout'); END`);
    const uuid = randomUUID();
    expect(o.factuur(velden(o.klantUuid), { uuid })).toEqual({ status: 500, fout: 'opslaan-mislukt' });
    expect(telling(o.db)).toEqual(voor);
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM sync_ontvangen')).toBe(totaalVoor);
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM journal_lines')).toBe(regelsVoor);
    expect(o.db.inTransaction).toBe(false);
    // zonder de fout wordt dezelfde wijziging daarna gewoon toegepast
    o.db.exec('DROP TRIGGER forceer_fout');
    expect(o.factuur(velden(o.klantUuid), { uuid })).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(telling(o.db).invoices).toBe(voor.invoices + 1);

    // uitbreiding (boekhouderskopie): een meegegeven InvoiceService met een writeGuard laat de factuur niet boeken;
    // de afhandeling is die van een periode-weigering: 200 wacht, geen factuurrijen, geen registerrij, wel een wachtrijrij
    const g = setup();
    const gesloten = new SyncOntvangst(g.db, new RelationsService(g.db), { now: () => Date.now(), invoices: g.s.invoices });
    const klant = randomUUID();
    expect(gesloten.verwerk(APPARAAT, BRON, { entiteit: 'klant', uuid: klant, revisie: 1, tijd: Date.now() - 5 * DAG, velden: { naam: KLANT.name } })).toMatchObject({ uitkomst: 'toegepast' });
    g.s.ledger.setWriteGuard(() => 'In de kopie voor de boekhouder kun je alleen correctieboekingen maken.');
    const geweigerdUuid = randomUUID();
    const guardVoor = telling(g.db);
    const uitslag = gesloten.verwerk(APPARAAT, BRON, { entiteit: 'factuur', uuid: geweigerdUuid, revisie: 1, tijd: Date.now() - DAG, velden: velden(klant) }, 'netwerk');
    expect(uitslag).toMatchObject({ status: 200, uitkomst: 'wacht' });
    expect(telling(g.db)).toEqual({ ...guardVoor, sync_wachtrij: guardVoor.sync_wachtrij + 1 });
    expect(n(g.db, 'SELECT COUNT(*) AS n FROM invoices')).toBe(0);
    expect(register(g.db, geweigerdUuid)).toEqual([]);
    // zonder meegegeven factuurdienst (geen guard-bewuste Ledger) wordt er nooit geboekt: factuur blijft niet-ondersteund
    const zonder = new SyncOntvangst(g.db, new RelationsService(g.db), { now: () => Date.now() });
    const zonderVoor = telling(g.db);
    expect(zonder.verwerk(APPARAAT, BRON, { entiteit: 'factuur', uuid: randomUUID(), revisie: 1, tijd: Date.now() - DAG, velden: velden(klant, [HOOG], { nummer: nummer(9) }) })).toEqual({ status: 200, uitkomst: 'niet-ondersteund' });
    expect(telling(g.db)).toEqual(zonderVoor);
  });

  // ---------------------------------------------------------------------------------------------
  // s12b: wachten in de wachtrij en hervatten
  // ---------------------------------------------------------------------------------------------

  it('FACT-12 wacht onbekende klant: uitkomst wacht, een wachtrijrij met wacht_op_entiteit klant, reden klant-onbekend en nummer gevuld, geen factuur en geen registerrij', () => {
    const o = omgeving();
    const klant = randomUUID();
    const uuid = randomUUID();
    const voor = telling(o.db);
    expect(o.factuur(velden(klant), { uuid })).toEqual({ status: 200, uitkomst: 'wacht' });
    const rijen = wachtrij(o.db, uuid);
    expect(rijen).toHaveLength(1);
    expect(rijen[0]).toMatchObject({ apparaat_id: APPARAAT, bron: BRON, entiteit: 'factuur', uuid, revisie: 1, wacht_op_entiteit: 'klant', wacht_op_uuid: klant, reden: 'klant-onbekend', nummer: nummer(1), verwerkt_op: null, verwerkt_uitkomst: null });
    expect(factuurRij(o.db, uuid)).toBeUndefined();
    expect(register(o.db, uuid)).toEqual([]);
    expect(telling(o.db)).toEqual({ ...voor, sync_wachtrij: voor.sync_wachtrij + 1 });
    // dezelfde wijziging nog eens: nog steeds een rij, de inhoud van de eerste keer blijft leidend
    expect(o.factuur(velden(klant), { uuid })).toEqual({ status: 200, uitkomst: 'wacht' });
    expect(telling(o.db)).toEqual({ ...voor, sync_wachtrij: voor.sync_wachtrij + 1 });
  });

  it('FACT-13 wachtrij vol: bij 1000 niet-verwerkte rijen van het apparaat geeft de volgende geldige factuur 503 wachtrij-vol zonder nieuwe rij', () => {
    const o = omgeving();
    const vul = o.db.prepare(
      `INSERT INTO sync_wachtrij (apparaat_id, bron, entiteit, uuid, revisie, tijd, wijziging, wacht_op_entiteit, wacht_op_uuid, reden, ontvangen_op) VALUES (?, 'M1', 'bon', ?, 1, 0, '{}', 'klant', ?, 'klant-onbekend', 0)`,
    );
    o.db.transaction(() => {
      for (let i = 0; i < 1000; i++) vul.run(APPARAAT, randomUUID(), randomUUID());
    })();
    const voor = telling(o.db);
    const uuid = randomUUID();
    const r = o.factuur(velden(randomUUID()), { uuid });
    expect(r).toEqual({ status: 503, fout: 'wachtrij-vol' });
    expect(telling(o.db)).toEqual(voor);
    expect(register(o.db, uuid)).toEqual([]);
    expect(wachtrij(o.db, uuid)).toEqual([]);
    // een factuur die wel kan wordt niet geweigerd om een volle wachtrij; een ander apparaat heeft een eigen wachtrij
    expect(o.factuur(velden(o.klantUuid, [HOOG], { nummer: nummer(2) }))).toEqual({ status: 200, uitkomst: 'toegepast' });
    const ander = o.sync.verwerk('apparaat-2', 'M2', { entiteit: 'factuur', uuid: randomUUID(), revisie: 1, tijd: Date.now() - DAG, velden: velden(randomUUID(), [HOOG], { nummer: nummer(1, 'M2') }) });
    expect(ander).toEqual({ status: 200, uitkomst: 'wacht' });
    // alleen onverwerkte rijen tellen mee: een afgehandelde rij maakt weer plek
    o.db.prepare(`UPDATE sync_wachtrij SET verwerkt_op = 1, verwerkt_uitkomst = 'overgeslagen' WHERE id = (SELECT MIN(id) FROM sync_wachtrij WHERE apparaat_id = ?)`).run(APPARAAT);
    expect(o.factuur(velden(randomUUID(), [HOOG], { nummer: nummer(3) }), { uuid })).toEqual({ status: 200, uitkomst: 'wacht' });
    expect(wachtrij(o.db, uuid)).toHaveLength(1);
  });

  it('FACT-14 klant komt binnen: de factuur wordt in dezelfde verwerking overgenomen en de wachtrijrij heeft verwerkt_op en verwerkt_uitkomst toegepast (de rij bestaat nog)', () => {
    const o = omgeving();
    const klant = randomUUID();
    const uuid = randomUUID();
    expect(o.factuur(velden(klant), { uuid })).toMatchObject({ uitkomst: 'wacht' });
    const voor = telling(o.db);
    expect(klantWijz(o, klant)).toEqual({ status: 200, uitkomst: 'toegepast' });
    const rij = factuurRij(o.db, uuid)!;
    expect(rij).toMatchObject({ number: nummer(1), status: 'verzonden', apparaat_code: BRON, job_id: null });
    expect(rij.relation_id).toBe(o.db.prepare('SELECT id FROM relations WHERE uuid = ?').pluck().get(klant));
    expect(rij.journal_entry_id).not.toBeNull();
    const rijen = wachtrij(o.db, uuid);
    expect(rijen).toHaveLength(1);
    expect(rijen[0]).toMatchObject({ verwerkt_uitkomst: 'toegepast', verwerkt_reden: null });
    expect(rijen[0]!.verwerkt_op).toEqual(expect.any(Number));
    expect(register(o.db, uuid)).toEqual([{ uitkomst: 'toegepast', fout: null, route: 'netwerk' }]);
    expect(telling(o.db)).toEqual({ ...voor, invoices: voor.invoices + 1, invoice_lines: voor.invoice_lines + 2, journal_entries: voor.journal_entries + 1, sync_ontvangen: voor.sync_ontvangen + 1 });
  });

  it('FACT-15 creditnota wacht op origineel: wacht_op_entiteit factuur, reden origineel-onbekend; komt het origineel, dan wordt de creditnota opgepakt en verrekend, en een creditnota met een origineel van een andere klant wordt afgewezen', () => {
    const o = omgeving();
    const origineel = randomUUID();
    const creditUuid = randomUUID();
    const credit = (klant: string, orig: string, volgnr: number) => velden(klant, [{ ...HOOG, hoeveelheid: -2 }], { nummer: nummer(volgnr), creditnota_van: orig });
    expect(o.factuur(credit(o.klantUuid, origineel, 2), { uuid: creditUuid })).toEqual({ status: 200, uitkomst: 'wacht' });
    expect(wachtrij(o.db, creditUuid)[0]).toMatchObject({ wacht_op_entiteit: 'factuur', wacht_op_uuid: origineel, reden: 'origineel-onbekend', nummer: nummer(2) });
    expect(factuurRij(o.db, creditUuid)).toBeUndefined();
    // het origineel komt: beide staan er, de creditnota is verrekend met het origineel
    expect(o.factuur(velden(o.klantUuid, [HOOG], { nummer: nummer(1) }), { uuid: origineel })).toEqual({ status: 200, uitkomst: 'toegepast' });
    const orig = factuurRij(o.db, origineel)!;
    const cr = factuurRij(o.db, creditUuid)!;
    expect(cr).toMatchObject({ number: nummer(2), credit_of_invoice_id: orig.id, relation_id: orig.relation_id });
    expect(cr.total).toBe(-(orig.total as number));
    expect(factuurRij(o.db, origineel)).toMatchObject({ amount_paid: orig.total, status: 'betaald' });
    expect(wachtrij(o.db, creditUuid)[0]).toMatchObject({ verwerkt_uitkomst: 'toegepast' });
    expect(register(o.db, creditUuid)).toEqual([{ uitkomst: 'toegepast', fout: null, route: 'netwerk' }]);

    // een creditnota die wacht op een origineel van een andere klant wordt bij het verwerken afgewezen en blijft niet hangen
    const andere = randomUUID();
    expect(klantWijz(o, andere, 'Andere klant')).toMatchObject({ uitkomst: 'toegepast' });
    const orig2 = randomUUID();
    const credit2 = randomUUID();
    expect(o.factuur(credit(o.klantUuid, orig2, 4), { uuid: credit2 })).toEqual({ status: 200, uitkomst: 'wacht' });
    const voor = telling(o.db);
    expect(o.factuur(velden(andere, [HOOG], { nummer: nummer(3) }), { uuid: orig2 })).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(factuurRij(o.db, credit2)).toBeUndefined();
    expect(wachtrij(o.db, credit2)[0]).toMatchObject({ verwerkt_uitkomst: 'afgewezen', verwerkt_reden: 'factuur-geweigerd' });
    expect(register(o.db, credit2)).toEqual([{ uitkomst: 'afgewezen', fout: 'factuur-geweigerd', route: 'netwerk' }]);
    expect(telling(o.db)).toEqual({ ...voor, invoices: voor.invoices + 1, invoice_lines: voor.invoice_lines + 1, journal_entries: voor.journal_entries + 1, sync_ontvangen: voor.sync_ontvangen + 2 });
    // een herhaling van de afgewezen creditnota geeft dezelfde afwijzing
    expect(o.factuur(credit(o.klantUuid, orig2, 4), { uuid: credit2 })).toMatchObject({ status: 200, uitkomst: 'afgewezen', fout: 'factuur-geweigerd' });
  });

  it('FACT-16 cascade: een creditnota wacht op een factuur die op een klant wacht; komt de klant, dan zijn beide overgenomen', () => {
    const o = omgeving();
    const klant = randomUUID();
    const origineel = randomUUID();
    const creditUuid = randomUUID();
    expect(o.factuur(velden(klant, [HOOG], { nummer: nummer(1) }), { uuid: origineel })).toEqual({ status: 200, uitkomst: 'wacht' });
    expect(o.factuur(velden(klant, [{ ...HOOG, hoeveelheid: -2 }], { nummer: nummer(2), creditnota_van: origineel }), { uuid: creditUuid })).toEqual({ status: 200, uitkomst: 'wacht' });
    expect(wachtrij(o.db, origineel)[0]).toMatchObject({ wacht_op_entiteit: 'klant', wacht_op_uuid: klant });
    expect(wachtrij(o.db, creditUuid)[0]).toMatchObject({ wacht_op_entiteit: 'factuur', wacht_op_uuid: origineel });
    expect(telling(o.db).invoices).toBe(0);
    expect(klantWijz(o, klant)).toMatchObject({ status: 200, uitkomst: 'toegepast' });
    const orig = factuurRij(o.db, origineel)!;
    expect(orig).toMatchObject({ number: nummer(1), status: 'betaald' });
    expect(factuurRij(o.db, creditUuid)).toMatchObject({ number: nummer(2), credit_of_invoice_id: orig.id, relation_id: orig.relation_id });
    expect(telling(o.db).invoices).toBe(2);
    expect(telling(o.db).journal_entries).toBe(2);
    for (const u of [origineel, creditUuid]) {
      expect(wachtrij(o.db, u)[0]).toMatchObject({ verwerkt_uitkomst: 'toegepast' });
      expect(register(o.db, u)).toEqual([{ uitkomst: 'toegepast', fout: null, route: 'netwerk' }]);
    }
  });

  it('FACT-17 volgorde: factuur, project en klant in omgekeerde volgorde aangeboden geeft dezelfde eindtoestand als de goede volgorde', () => {
    const klant = randomUUID();
    const project = randomUUID();
    const uuid = randomUUID();
    const eind = (o: Omg) => ({
      factuur: o.db.prepare(`SELECT i.number, i.status, i.total, i.vat_total, r.name AS klant, j.title AS project FROM invoices i JOIN relations r ON r.id = i.relation_id LEFT JOIN jobs j ON j.id = i.job_id WHERE i.uuid = ?`).get(uuid),
      aantallen: telling(o.db),
      boeking: o.db.prepare('SELECT e.entry_date, e.description FROM journal_entries e JOIN invoices i ON i.journal_entry_id = e.id WHERE i.uuid = ?').get(uuid),
      register: o.db.prepare(`SELECT entiteit, uitkomst, fout FROM sync_ontvangen WHERE uuid IN (?, ?, ?) ORDER BY entiteit`).all(uuid, klant, project),
      projecten: n(o.db, 'SELECT COUNT(*) AS n FROM jobs WHERE uuid = ?', project),
    });
    const goed = omgeving();
    expect(klantWijz(goed, klant, 'Volgorde BV')).toMatchObject({ uitkomst: 'toegepast' });
    expect(projectWijz(goed, project, klant)).toMatchObject({ uitkomst: 'toegepast' });
    expect(goed.factuur(velden(klant, [HOOG, LAAG], { project_uuid: project }), { uuid })).toEqual({ status: 200, uitkomst: 'toegepast' });

    const om = omgeving();
    expect(om.factuur(velden(klant, [HOOG, LAAG], { project_uuid: project }), { uuid })).toEqual({ status: 200, uitkomst: 'wacht' });
    expect(projectWijz(om, project, klant)).toEqual({ status: 200, uitkomst: 'wacht' });
    expect(factuurRij(om.db, uuid)).toBeUndefined();
    expect(klantWijz(om, klant, 'Volgorde BV')).toMatchObject({ uitkomst: 'toegepast' });

    const resultaat = eind(om);
    expect(resultaat.factuur).toMatchObject({ number: nummer(1), status: 'verzonden', klant: 'Volgorde BV', project: 'Klus' });
    expect(resultaat.projecten).toBe(1);
    // de omgekeerde volgorde heeft alleen extra wachtrijrijen, die allemaal zijn afgehandeld; de rest is gelijk
    expect({ ...resultaat, aantallen: { ...resultaat.aantallen, sync_wachtrij: 0 } }).toEqual({ ...eind(goed), aantallen: { ...eind(goed).aantallen, sync_wachtrij: 0 } });
    expect(n(om.db, 'SELECT COUNT(*) AS n FROM sync_wachtrij WHERE verwerkt_op IS NULL')).toBe(0);
    expect(n(om.db, 'SELECT COUNT(*) AS n FROM sync_wachtrij')).toBe(2);
    expect(n(goed.db, 'SELECT COUNT(*) AS n FROM sync_wachtrij')).toBe(0);
  });

  it('FACT-18 afgesloten periode: wacht met wacht_op_entiteit periode en reden periode, geen factuur, geen halve rijen', () => {
    const o = omgeving();
    sluitPeriode(o);
    const voor = telling(o.db);
    const regelsVoor = n(o.db, 'SELECT COUNT(*) AS n FROM journal_lines');
    const uuid = randomUUID();
    expect(o.factuur(velden(o.klantUuid), { uuid })).toEqual({ status: 200, uitkomst: 'wacht' });
    const rijen = wachtrij(o.db, uuid);
    expect(rijen).toHaveLength(1);
    expect(rijen[0]).toMatchObject({ wacht_op_entiteit: 'periode', reden: 'periode', nummer: nummer(1), verwerkt_op: null });
    expect(rijen[0]!.wacht_op_uuid).toBe('');
    expect(factuurRij(o.db, uuid)).toBeUndefined();
    expect(register(o.db, uuid)).toEqual([]);
    expect(telling(o.db)).toEqual({ ...voor, sync_wachtrij: voor.sync_wachtrij + 1 });
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM journal_lines')).toBe(regelsVoor);
    // het nummer is niet in beslag genomen
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM invoices WHERE number = ?', nummer(1))).toBe(0);
  });

  it('FACT-19 heropend: na heropenen van de periode wordt de wachtende factuur bij de volgende wijziging van hetzelfde apparaat overgenomen, en ook bij het opnieuw starten van de receiver', async () => {
    const o = omgeving();
    sluitPeriode(o);
    const eerste = randomUUID();
    expect(o.factuur(velden(o.klantUuid, [HOOG], { nummer: nummer(1) }), { uuid: eerste })).toMatchObject({ uitkomst: 'wacht' });
    // zolang de periode dicht is, blijft de factuur wachten, ook na een volgende wijziging
    const trigger = () => o.factuur(velden(randomUUID(), [HOOG], { nummer: nummer(50) }), { uuid: randomUUID() });
    expect(trigger()).toMatchObject({ uitkomst: 'wacht' });
    expect(factuurRij(o.db, eerste)).toBeUndefined();
    expect(wachtrij(o.db, eerste)[0]).toMatchObject({ verwerkt_op: null, wacht_op_entiteit: 'periode' });
    o.s.periods.abortExchange();
    // de volgende wijziging van hetzelfde apparaat (hier zelf een wachtende) hervat de wachtrij
    expect(trigger()).toMatchObject({ uitkomst: 'wacht' });
    expect(factuurRij(o.db, eerste)).toMatchObject({ number: nummer(1), status: 'verzonden' });
    expect(wachtrij(o.db, eerste)[0]).toMatchObject({ verwerkt_uitkomst: 'toegepast' });
    expect(register(o.db, eerste)).toEqual([{ uitkomst: 'toegepast', fout: null, route: 'netwerk' }]);

    // dezelfde periode nog eens dicht: een factuur wacht, de periode gaat open en de receiver start opnieuw
    sluitPeriode(o, 8);
    const tweede = randomUUID();
    expect(o.factuur(velden(o.klantUuid, [HOOG], { nummer: nummer(2) }), { uuid: tweede })).toMatchObject({ uitkomst: 'wacht' });
    o.s.periods.abortExchange();
    expect(factuurRij(o.db, tweede)).toBeUndefined();
    await metReceiver(o, async (scanner) => {
      await scanner.start();
      expect(factuurRij(o.db, tweede)).toMatchObject({ number: nummer(2), status: 'verzonden' });
    });
    expect(wachtrij(o.db, tweede)[0]).toMatchObject({ verwerkt_uitkomst: 'toegepast' });
  });

  it('FACT-20 ontkoppeld na wachten: de factuur wacht, het apparaat wordt ontkoppeld, de klant komt binnen en de factuur wordt alsnog overgenomen', () => {
    const o = omgeving();
    const pairing = new ScannerPairing(o.db, o.secrets);
    const koppel = () => {
      const { deviceId } = pairing.begin();
      pairing.seen(deviceId);
      return { deviceId, code: pairing.code(deviceId)! };
    };
    const a = koppel();
    const b = koppel();
    expect([a.code, b.code]).toEqual(['M1', 'M2']);
    const klant = randomUUID();
    const uuid = randomUUID();
    const w = { entiteit: 'factuur', uuid, revisie: 1, tijd: Date.now() - DAG, velden: velden(klant, [HOOG], { nummer: nummer(1, a.code) }) };
    expect(o.sync.verwerk(a.deviceId, a.code, w)).toEqual({ status: 200, uitkomst: 'wacht' });
    pairing.unpair(a.deviceId);
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM scanner_devices WHERE id = ?', a.deviceId)).toBe(0);
    expect(o.db.prepare('SELECT afgesloten_op FROM scanner_device_codes WHERE device_id = ?').pluck().get(a.deviceId)).not.toBeNull();
    // de klant komt via het andere apparaat binnen
    expect(o.sync.verwerk(b.deviceId, b.code, { entiteit: 'klant', uuid: klant, revisie: 1, tijd: Date.now() - DAG, velden: { naam: 'Na ontkoppelen BV' } })).toMatchObject({ uitkomst: 'toegepast' });
    expect(factuurRij(o.db, uuid)).toMatchObject({ number: nummer(1, a.code), apparaat_code: a.code, status: 'verzonden' });
    expect(wachtrij(o.db, uuid)[0]).toMatchObject({ apparaat_id: a.deviceId, bron: a.code, verwerkt_uitkomst: 'toegepast' });
    expect(o.db.prepare('SELECT apparaat_id, uitkomst FROM sync_ontvangen WHERE uuid = ?').all(uuid)).toEqual([{ apparaat_id: a.deviceId, uitkomst: 'toegepast' }]);
  });

  it('FACT-21 project: bekend project van dezelfde klant geeft invoices.job_id; onbekend project wacht (wacht_op_entiteit project, reden project-onbekend) en wordt na het project overgenomen met job_id; bekend project van een andere klant geeft een overgenomen factuur zonder job_id', () => {
    const o = omgeving();
    const jobId = (uuid: string) => o.db.prepare('SELECT id FROM jobs WHERE uuid = ?').pluck().get(uuid) as number;
    // bekend project van dezelfde klant
    const p1 = randomUUID();
    expect(projectWijz(o, p1, o.klantUuid)).toMatchObject({ uitkomst: 'toegepast' });
    const f1 = randomUUID();
    expect(o.factuur(velden(o.klantUuid, [HOOG], { nummer: nummer(1), project_uuid: p1 }), { uuid: f1 })).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(factuurRij(o.db, f1)!.job_id).toBe(jobId(p1));
    // onbekend project: wacht, daarna overgenomen met job_id
    const p2 = randomUUID();
    const f2 = randomUUID();
    expect(o.factuur(velden(o.klantUuid, [HOOG], { nummer: nummer(2), project_uuid: p2 }), { uuid: f2 })).toEqual({ status: 200, uitkomst: 'wacht' });
    expect(wachtrij(o.db, f2)[0]).toMatchObject({ wacht_op_entiteit: 'project', wacht_op_uuid: p2, reden: 'project-onbekend' });
    expect(factuurRij(o.db, f2)).toBeUndefined();
    expect(projectWijz(o, p2, o.klantUuid)).toMatchObject({ uitkomst: 'toegepast' });
    expect(factuurRij(o.db, f2)!.job_id).toBe(jobId(p2));
    expect(wachtrij(o.db, f2)[0]).toMatchObject({ verwerkt_uitkomst: 'toegepast' });
    // bekend project van een andere klant: wel overgenomen, zonder job_id, en het project blijft bij zijn eigen klant
    const andere = randomUUID();
    expect(klantWijz(o, andere, 'Andere klant')).toMatchObject({ uitkomst: 'toegepast' });
    const p3 = randomUUID();
    expect(projectWijz(o, p3, andere)).toMatchObject({ uitkomst: 'toegepast' });
    const f3 = randomUUID();
    expect(o.factuur(velden(o.klantUuid, [HOOG], { nummer: nummer(3), project_uuid: p3 }), { uuid: f3 })).toEqual({ status: 200, uitkomst: 'toegepast' });
    expect(factuurRij(o.db, f3)!.job_id).toBeNull();
    expect(o.db.prepare('SELECT relation_id FROM jobs WHERE uuid = ?').pluck().get(p3)).toBe(o.db.prepare('SELECT id FROM relations WHERE uuid = ?').pluck().get(andere));
    expect(wachtrij(o.db, f3)).toEqual([]);
  });

  it('FACT-22 hervatten is idempotent: tweemaal hervatten geeft geen dubbele factuur, geen dubbele boeking en geen tweede registerrij', () => {
    const o = omgeving();
    const klant = randomUUID();
    const uuid = randomUUID();
    expect(o.factuur(velden(klant), { uuid })).toMatchObject({ uitkomst: 'wacht' });
    expect(klantWijz(o, klant)).toMatchObject({ uitkomst: 'toegepast' });
    const na = telling(o.db);
    const rij = wachtrij(o.db, uuid)[0]!;
    expect(na).toMatchObject({ invoices: 1, journal_entries: 1, invoice_lines: 2 });
    // nog eens hervatten, ook met dezelfde klant opnieuw: er verandert niets
    o.sync.verwerkWachtrij();
    o.sync.verwerkWachtrij();
    expect(klantWijz(o, klant)).toMatchObject({ uitkomst: 'overgeslagen' });
    expect(telling(o.db)).toEqual(na);
    expect(wachtrij(o.db, uuid)).toEqual([rij]);
    // een onderbreking tussen overnemen en afhandelen (de rij staat nog open terwijl de factuur er is): hervatten boekt niet opnieuw
    o.db.prepare('UPDATE sync_wachtrij SET verwerkt_op = NULL, verwerkt_uitkomst = NULL WHERE id = ?').run(rij.id);
    o.sync.verwerkWachtrij();
    o.sync.verwerkWachtrij();
    expect(telling(o.db)).toEqual(na);
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM invoices WHERE uuid = ?', uuid)).toBe(1);
    expect(register(o.db, uuid)).toEqual([{ uitkomst: 'toegepast', fout: null, route: 'netwerk' }]);
    expect(wachtrij(o.db, uuid)[0]).toMatchObject({ id: rij.id, verwerkt_uitkomst: 'overgeslagen' });
    expect(wachtrij(o.db, uuid)[0]!.verwerkt_op).toEqual(expect.any(Number));
  });

  it('FACT-23 herstart: na het starten van de receiver worden alle wachtende facturen opnieuw geprobeerd en een wachtrijrij wordt nooit verwijderd', async () => {
    const o = omgeving();
    const klant = randomUUID();
    const nog = randomUUID();
    const uuids = [randomUUID(), randomUUID(), randomUUID()];
    uuids.forEach((uuid, i) => expect(o.factuur(velden(klant, [HOOG], { nummer: nummer(i + 1) }), { uuid })).toMatchObject({ uitkomst: 'wacht' }));
    const onbekend = randomUUID();
    expect(o.factuur(velden(nog, [HOOG], { nummer: nummer(4) }), { uuid: onbekend })).toMatchObject({ uitkomst: 'wacht' });
    // de klant komt buiten de ontvangst om in de administratie (bv. door de gebruiker aangemaakt): niets weet het nog
    o.db.prepare(`INSERT INTO relations (type, name, uuid) VALUES ('klant', 'Handmatig BV', ?)`).run(klant);
    expect(telling(o.db).invoices).toBe(0);
    const ids = o.db.prepare('SELECT id FROM sync_wachtrij ORDER BY id').all();
    expect(ids).toHaveLength(4);
    // de tweede factuur mislukt (geforceerde fout): de andere gaan door en er blijft niets half achter
    o.db.exec(`CREATE TRIGGER forceer_fout BEFORE INSERT ON invoices WHEN NEW.number = '${nummer(2)}' BEGIN SELECT RAISE(ABORT, 'geforceerde fout'); END`);
    await metReceiver(o, async (scanner) => {
      await scanner.start();
    });
    expect(factuurRij(o.db, uuids[0]!)).toMatchObject({ number: nummer(1) });
    expect(factuurRij(o.db, uuids[1]!)).toBeUndefined();
    expect(factuurRij(o.db, uuids[2]!)).toMatchObject({ number: nummer(3) });
    expect(telling(o.db)).toMatchObject({ invoices: 2, invoice_lines: 2, journal_entries: 2, sync_ontvangen: 2 });
    expect(wachtrij(o.db, uuids[1]!)[0]).toMatchObject({ verwerkt_op: null });
    expect(wachtrij(o.db, onbekend)[0]).toMatchObject({ verwerkt_op: null, wacht_op_uuid: nog });
    // de fout weg: de volgende hervatting neemt de rest over; geen enkele wachtrijrij is verdwenen
    o.db.exec('DROP TRIGGER forceer_fout');
    o.sync.verwerkWachtrij();
    expect(factuurRij(o.db, uuids[1]!)).toMatchObject({ number: nummer(2) });
    expect(telling(o.db)).toMatchObject({ invoices: 3, journal_entries: 3 });
    expect(o.db.prepare('SELECT id FROM sync_wachtrij ORDER BY id').all()).toEqual(ids);
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM sync_wachtrij WHERE verwerkt_op IS NOT NULL')).toBe(3);
    expect(wachtrij(o.db, onbekend)[0]).toMatchObject({ verwerkt_op: null });
  });
});

// ---------------------------------------------------------------------------------------------
// hulpfuncties voor de wachtstanden
// ---------------------------------------------------------------------------------------------

const wachtrij = (db: Database.Database, uuid: string) => db.prepare(`SELECT * FROM sync_wachtrij WHERE entiteit = 'factuur' AND uuid = ? ORDER BY id`).all(uuid) as Record<string, unknown>[];

/** Een klantwijziging van het apparaat; de klant krijgt een naam. */
function klantWijz(o: Omg, uuid: string, naam = 'Nieuwe klant') {
  return o.sync.verwerk(APPARAAT, BRON, { entiteit: 'klant', uuid, revisie: 1, tijd: Date.now() - 2 * DAG, velden: { naam } });
}

/** Een projectwijziging van het apparaat voor een klant (uuid). */
function projectWijz(o: Omg, uuid: string, klant: string) {
  return o.sync.verwerk(APPARAAT, BRON, { entiteit: 'project', uuid, revisie: 1, tijd: Date.now() - 2 * DAG, velden: { titel: 'Klus', klant } });
}

/** De periode tot twee dagen geleden gaat naar de boekhouder (nooit tot en met 31 december: dan vraagt de service om een bevestiging). */
function sluitPeriode(o: Omg, uitwisseling = 7) {
  let tot = Date.now() - 2 * DAG;
  while (iso(tot).slice(5) === '12-31') tot -= DAG;
  o.s.periods.startExchange(iso(tot), uitwisseling, [], iso(Date.now()));
}

/** Een Bonnenscanner op dezelfde databank en factuurdienst, zoals bij het starten van de app; stopt altijd weer. */
async function metReceiver(o: Omg, fn: (scanner: Bonnenscanner) => Promise<void>): Promise<void> {
  const spoolDir = mkdtempSync(join(tmpdir(), 'bvn-sync-facturen-'));
  const scanner = new Bonnenscanner({ db: o.db, secrets: o.secrets, intake: o.s.intake, settings: o.s.settings, spoolDir, interfaces: () => [], now: () => Date.now(), invoices: o.s.invoices });
  try {
    await fn(scanner);
  } finally {
    await scanner.stop();
    rmSync(spoolDir, { recursive: true, force: true });
  }
}
