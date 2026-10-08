import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { computeTotals, type LineInput, type Wijziging } from '@gratis-boekhouden/kern';
import { setup } from './helpers';
import { RelationsService } from '../src/relations/relations';
import { SyncOntvangst } from '../src/sync/ontvangst';
import { counterKey } from '../src/documents/numbering';
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
  const sync = new SyncOntvangst(t.db, new RelationsService(t.db), { now: () => Date.now() });
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
    // een creditnota bij een onbekend origineel is in deze stap afgewezen met origineel-onbekend
    const credit = velden(o.klantUuid, [{ ...HOOG, hoeveelheid: -2 }], { nummer: nummer(2), creditnota_van: randomUUID() });
    expect(o.factuur(credit)).toMatchObject({ status: 200, uitkomst: 'afgewezen', fout: 'origineel-onbekend' });
    expect(telling(o.db).invoices).toBe(voor.invoices);
    // een periode bij de boekhouder is afgewezen met fout periode
    o.s.periods.startExchange(iso(Date.now() - 2 * DAG), 7, [], iso(Date.now()));
    const vast = o.factuur(velden(o.klantUuid, [HOOG], { nummer: nummer(3) }));
    expect(vast).toMatchObject({ status: 200, uitkomst: 'afgewezen', fout: 'periode' });
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
    // een onbekende klant en een leverancier geven 409 klant-onbekend zonder rijen
    const voor = telling(o.db);
    expect(o.factuur(velden(randomUUID(), [HOOG], { nummer: nummer(2) }))).toMatchObject({ status: 409, fout: 'klant-onbekend' });
    const leverancier = randomUUID();
    o.db.prepare(`INSERT INTO relations (type, name, uuid) VALUES ('leverancier', 'Groothandel', ?)`).run(leverancier);
    expect(o.factuur(velden(leverancier, [HOOG], { nummer: nummer(3) }))).toMatchObject({ status: 409, fout: 'klant-onbekend' });
    expect(telling(o.db)).toEqual(voor);
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
    // de afhandeling is die van een periode-weigering: 200 afgewezen met fout periode, geen factuurrijen, wel een registerrij
    const g = setup();
    const gesloten = new SyncOntvangst(g.db, new RelationsService(g.db), { now: () => Date.now(), invoices: g.s.invoices });
    const klant = randomUUID();
    expect(gesloten.verwerk(APPARAAT, BRON, { entiteit: 'klant', uuid: klant, revisie: 1, tijd: Date.now() - 5 * DAG, velden: { naam: KLANT.name } })).toMatchObject({ uitkomst: 'toegepast' });
    g.s.ledger.setWriteGuard(() => 'In de kopie voor de boekhouder kun je alleen correctieboekingen maken.');
    const geweigerdUuid = randomUUID();
    const guardVoor = telling(g.db);
    const uitslag = gesloten.verwerk(APPARAAT, BRON, { entiteit: 'factuur', uuid: geweigerdUuid, revisie: 1, tijd: Date.now() - DAG, velden: velden(klant) }, 'netwerk');
    expect(uitslag).toMatchObject({ status: 200, uitkomst: 'afgewezen', fout: 'periode' });
    expect(telling(g.db)).toEqual({ ...guardVoor, sync_ontvangen: guardVoor.sync_ontvangen + 1 });
    expect(n(g.db, 'SELECT COUNT(*) AS n FROM invoices')).toBe(0);
    expect(register(g.db, geweigerdUuid)).toEqual([{ uitkomst: 'afgewezen', fout: 'periode', route: 'netwerk' }]);
  });
});
