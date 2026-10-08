import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { computeTotals, leesFactuurVelden, type FactuurVelden, type LineInput } from '@gratis-boekhouden/kern';
import { migrate } from '../src/db/database';
import { migrations } from '../src/db/migrations';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { PeriodLockedError } from '../src/core-ledger/ledger';
import { counterKey } from '../src/documents/numbering';
import { setup } from './helpers';

// Een definitieve factuur van de telefoon overnemen op de pc (alleen serviceniveau, zonder receiver).

const ASOF = '2026-10-15';
const UUID_1 = '3f2b8c1e-9a4d-4e7b-8c3a-1d2e3f4a5b6c';
const UUID_2 = '7a1c2d3e-4b5f-4a6b-9c7d-8e9f0a1b2c3d';
const UUID_3 = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
const UUID_ONBEKEND = 'c3d4e5f6-a7b8-4c9d-8e0f-2a3b4c5d6e7f';
const KLANT_UUID = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';

type Regel = { omschrijving: string; hoeveelheid: number; prijs: number; btw_soort: string; eenheid?: string | null };
const HOOG: Regel = { omschrijving: 'Montage', hoeveelheid: 2, prijs: 4550, btw_soort: 'hoog', eenheid: 'uur' };
const LAAG: Regel = { omschrijving: 'Boeken', hoeveelheid: 3, prijs: 1000, btw_soort: 'laag' };

const KLANT = { name: 'Bakkerij De Korst', address: 'Dorpsstraat 1', city: 'Utrecht', country: 'NL', vat_number: 'NL123456789B01', kvk_number: '12345678', email: 'info@korst.example' };
const KLANT_DE = { ...KLANT, name: 'Brot GmbH', city: 'Berlin', country: 'DE', vat_number: 'DE123456789' };
const BEDRIJF = { name: 'Jansen Klus', address: 'Werfstraat 2', city: 'Zwolle', kvkNumber: '87654321', vatNumber: 'NL987654321B01', kor: false };

/** Een gecontroleerde telefoonfactuur, gebouwd en doorgerekend via de kern zelf. */
function velden(regels: Regel[] = [HOOG], over: Record<string, unknown> = {}): FactuurVelden {
  const t = computeTotals(regels.map((r): LineInput => ({ description: r.omschrijving, quantity: r.hoeveelheid, unitPrice: r.prijs, vatCode: r.btw_soort as LineInput['vatCode'] })));
  const r = leesFactuurVelden({
    nummer: 'M1-2026-0001',
    datum: '2026-03-15',
    vervaldatum: '2026-04-14',
    klant_uuid: KLANT_UUID,
    klant_momentopname: { ...KLANT },
    bedrijf_momentopname: { ...BEDRIJF },
    regels,
    totalen: { subtotaal: t.subtotal, btw: t.vatTotal, totaal: t.total },
    verzonden_op: '2026-03-15 10:30:00',
    regeltabel_versie: '2026-1',
    ...over,
  });
  if (!r.ok) throw new Error(`testfactuur ongeldig: ${r.veld}: ${r.melding}`);
  return r.factuur;
}
const inv = (uuid: string, v: FactuurVelden) => ({ uuid, velden: v });

const aantallen = (db: Database.Database) => ({
  invoices: (db.prepare('SELECT COUNT(*) AS n FROM invoices').get() as { n: number }).n,
  lines: (db.prepare('SELECT COUNT(*) AS n FROM invoice_lines').get() as { n: number }).n,
  entries: (db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as { n: number }).n,
});

/** Alles van een factuur zoals het in de database staat: de rij en de regels. */
const momentopname = (db: Database.Database, id: number) =>
  JSON.stringify({ rij: db.prepare('SELECT * FROM invoices WHERE id = ?').get(id), regels: db.prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY id').all(id) });

/** De boeking van een factuur, zonder id's, om twee facturen te vergelijken. */
function boeking(db: Database.Database, invoiceId: number) {
  const e = db.prepare(`SELECT id, vat_date, entry_date FROM journal_entries WHERE source_ref = ? AND source = 'factuur'`).get(`invoice:${invoiceId}`) as { id: number; vat_date: string; entry_date: string };
  const regels = db
    .prepare(`SELECT a.rgs_code AS rekening, l.debit, l.credit, l.vat_code AS btw FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.journal_entry_id = ? ORDER BY a.rgs_code, l.debit, l.credit`)
    .all(e.id);
  return { regels, vat_date: e.vat_date, entry_date: e.entry_date };
}

function pcFactuur(s: ReturnType<typeof setup>['s'], relationId: number, regels: LineInput[], extra: Record<string, unknown> = {}) {
  return s.invoices.finalize(s.invoices.createDraft({ relationId, invoiceDate: '2026-03-15', lines: regels, ...extra }).id);
}
const PC_REGELS: LineInput[] = [
  { description: 'Montage', quantity: 2, unit: 'uur', unitPrice: 4550, vatCode: 'hoog' },
  { description: 'Boeken', quantity: 3, unitPrice: 1000, vatCode: 'laag' },
];

describe('migratie', () => {
  const i = migrations.findIndex((m) => /ADD COLUMN apparaat_code/.test(m));

  function oudeToestand() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    for (const m of migrations.slice(0, i)) db.exec(m);
    db.pragma(`user_version = ${i}`);
    db.exec(`INSERT INTO relations (id, name, type) VALUES (1, 'Oude klant', 'klant');
      INSERT INTO invoices (id, relation_id, number, invoice_date, due_date, status) VALUES (1, 1, 'F-1', '2026-01-10', '2026-02-09', 'verzonden'), (2, 1, 'F-2', '2026-01-11', '2026-02-10', 'verzonden');`);
    return db;
  }
  const triggers = (db: Database.Database) => (db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'invoices'`).get() as { n: number }).n;

  it('er is precies een migratie met de kolommen van de telefoonfactuur', () => {
    expect(migrations.filter((m) => /ADD COLUMN apparaat_code/.test(m))).toHaveLength(1);
    expect(i).toBeGreaterThan(0);
  });

  it('voegt de kolommen toe en laat bestaande facturen op NULL staan', () => {
    const db = oudeToestand();
    const voor = db.prepare('SELECT * FROM invoices ORDER BY id').all() as Record<string, unknown>[];
    migrate(db);
    const kolommen = (db.prepare('PRAGMA table_info(invoices)').all() as { name: string }[]).map((c) => c.name);
    expect(kolommen).toEqual(expect.arrayContaining(['uuid', 'apparaat_code', 'reeks_jaar', 'reeks_volgnr', 'regeltabel_versie']));
    const na = db.prepare('SELECT * FROM invoices ORDER BY id').all() as Record<string, unknown>[];
    expect(na).toHaveLength(2);
    for (const [n, rij] of na.entries()) {
      expect(rij).toMatchObject({ uuid: null, apparaat_code: null, reeks_jaar: null, reeks_volgnr: null, regeltabel_versie: null });
      expect(rij.number).toBe(voor[n]!.number);
      expect(rij.invoice_date).toBe(voor[n]!.invoice_date);
    }
  });

  it('maakt unieke indexen op uuid en op de reeks, alleen waar die gevuld zijn', () => {
    const db = oudeToestand();
    migrate(db);
    const indexen = db.prepare(`SELECT name, "unique" AS uniek FROM pragma_index_list('invoices') WHERE name IN ('ux_invoices_uuid', 'ux_invoices_reeks')`).all() as { name: string; uniek: number }[];
    expect(indexen.map((x) => x.uniek)).toEqual([1, 1]);
    const voeg = (n: string, uuid: string, volgnr: number) =>
      db.prepare(`INSERT INTO invoices (relation_id, number, invoice_date, due_date, status, uuid, apparaat_code, reeks_jaar, reeks_volgnr) VALUES (1, ?, '2026-03-01', '2026-03-31', 'verzonden', ?, 'M1', 2026, ?)`).run(n, uuid, volgnr);
    voeg('M1-2026-0001', UUID_1, 1);
    expect(() => voeg('M1-2026-0002', UUID_1, 2)).toThrow(/UNIQUE/);
    expect(() => voeg('M1-2026-0009', UUID_2, 1)).toThrow(/UNIQUE/);
  });

  it('twee facturen zonder uuid en zonder reeks blijven toegestaan', () => {
    const db = oudeToestand();
    migrate(db);
    expect(() => db.exec(`INSERT INTO invoices (relation_id, number, invoice_date, due_date) VALUES (1, 'F-3', '2026-02-01', '2026-03-03'), (1, 'F-4', '2026-02-02', '2026-03-04')`)).not.toThrow();
    expect((db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE uuid IS NULL').get() as { n: number }).n).toBe(4);
  });

  it('voegt geen database-trigger op invoices toe', () => {
    const db = oudeToestand();
    const voor = triggers(db);
    migrate(db);
    expect(triggers(db)).toBe(voor);
  });

  it('zet user_version op het aantal migraties', () => {
    const db = oudeToestand();
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
  });
});

describe('importDefinitive', () => {
  it('(a) laat de pc-teller van de facturen ongemoeid', () => {
    const { s, db, klant } = setup();
    pcFactuur(s, klant.id, PC_REGELS);
    const teller = counterKey('factuur', s.settings.get().invoiceNumberFormat, '2026-03-15');
    const instellingen = db.prepare('SELECT key, value FROM settings ORDER BY key').all();
    const voor = s.settings.peekCounter(teller);
    expect(voor).toBe(1);
    const r = s.invoices.importDefinitive(inv(UUID_1, velden()), klant.id);
    expect(r.uitkomst).toBe('nieuw');
    expect(s.settings.peekCounter(teller)).toBe(voor);
    expect(db.prepare('SELECT key, value FROM settings ORDER BY key').all()).toEqual(instellingen);
  });

  it('(b) boekt dezelfde bedragen als finalize op een pc-concept met dezelfde regels', () => {
    const { s, db, klant } = setup();
    const pc = pcFactuur(s, klant.id, PC_REGELS);
    const r = s.invoices.importDefinitive(inv(UUID_1, velden([HOOG, LAAG])), klant.id);
    expect(r).toMatchObject({ uitkomst: 'nieuw', boekingsdatum: '2026-03-15', boekingsdatum_verschoven: false });
    const telefoon = boeking(db, r.factuurId!);
    const rekeningen = telefoon.regels.map((x) => (x as { rekening: string }).rekening);
    expect(rekeningen).toContain(ACCOUNTS.debiteuren);
    expect(telefoon.regels.length).toBeGreaterThanOrEqual(5);
    expect(telefoon).toEqual(boeking(db, pc.id));
    expect(s.invoices.get(r.factuurId!)).toMatchObject({ subtotal: pc.subtotal, vat_total: pc.vat_total, total: pc.total, status: 'verzonden' });
  });

  it('(c) dezelfde uuid met dezelfde inhoud twee keer geeft een factuur, een boeking en al_aanwezig', () => {
    const { s, db, klant } = setup();
    const eerste = s.invoices.importDefinitive(inv(UUID_1, velden([HOOG, LAAG])), klant.id);
    const na1 = aantallen(db);
    const tweede = s.invoices.importDefinitive(inv(UUID_1, velden([HOOG, LAAG])), klant.id);
    expect(tweede).toMatchObject({ uitkomst: 'al_aanwezig', factuurId: eerste.factuurId, boekingsdatum: '2026-03-15', boekingsdatum_verschoven: false });
    expect(aantallen(db)).toEqual(na1);
    expect(na1.invoices).toBe(1);
    expect(na1.entries).toBe(1);
  });

  it('(d) een bestaand nummer van een telefoonfactuur met andere uuid wordt geweigerd zonder halve rijen', () => {
    const { s, db, klant } = setup();
    s.invoices.importDefinitive(inv(UUID_1, velden()), klant.id);
    const voor = aantallen(db);
    const r = s.invoices.importDefinitive(inv(UUID_2, velden([LAAG])), klant.id);
    expect(r.uitkomst).toBe('geweigerd');
    expect(r.reden).toContain('M1-2026-0001');
    expect(r.factuurId).toBeNull();
    expect(aantallen(db)).toEqual(voor);
  });

  it('(d) een pc-factuur met gelijk nummer geeft geweigerd zonder halve rijen', () => {
    const { s, db, klant } = setup();
    const pc = pcFactuur(s, klant.id, PC_REGELS);
    db.prepare(`UPDATE invoices SET number = 'M1-2026-0001' WHERE id = ?`).run(pc.id);
    const voor = aantallen(db);
    const r = s.invoices.importDefinitive(inv(UUID_1, velden()), klant.id);
    expect(r).toMatchObject({ uitkomst: 'geweigerd', factuurId: null });
    expect(r.reden).toMatch(/bestaat al/);
    expect(aantallen(db)).toEqual(voor);
  });

  it('(e) een creditnota wordt verrekend met het origineel', () => {
    const { s, db, klant } = setup();
    const orig = s.invoices.importDefinitive(inv(UUID_1, velden([HOOG])), klant.id);
    expect(s.invoices.get(orig.factuurId!).open_amount).toBe(11011);
    const credit = s.invoices.importDefinitive(
      inv(UUID_2, velden([{ ...HOOG, hoeveelheid: -2 }], { nummer: 'M1-2026-0002', datum: '2026-03-20', vervaldatum: '2026-04-19', creditnota_van: UUID_1 })),
      klant.id,
    );
    expect(credit.uitkomst).toBe('nieuw');
    const c = s.invoices.get(credit.factuurId!);
    expect(c).toMatchObject({ credit_of_invoice_id: orig.factuurId, total: -11011, open_amount: 0, status: 'betaald' });
    expect(s.invoices.get(orig.factuurId!)).toMatchObject({ open_amount: 0, status: 'betaald' });
    expect((db.prepare('SELECT amount_paid FROM invoices WHERE id = ?').get(orig.factuurId) as { amount_paid: number }).amount_paid).toBe(11011);
  });

  it('(f) een gewoon afgesloten periode schuift de boekingsdatum naar de eerste open dag', () => {
    const { s, klant } = setup();
    s.periods.close('2026-03-31', [], ASOF);
    const r = s.invoices.importDefinitive(inv(UUID_1, velden()), klant.id);
    expect(r).toMatchObject({ uitkomst: 'nieuw', boekingsdatum_verschoven: true, boekingsdatum: '2026-04-01' });
    expect(s.invoices.get(r.factuurId!).invoice_date).toBe('2026-03-15');
    // dezelfde factuur nog eens: al_aanwezig met de werkelijke boekingsdatum
    expect(s.invoices.importDefinitive(inv(UUID_1, velden()), klant.id)).toMatchObject({ uitkomst: 'al_aanwezig', boekingsdatum: '2026-04-01', boekingsdatum_verschoven: true });
  });

  it('(f) een periode bij de boekhouder geeft geweigerd en laat alle aantallen gelijk', () => {
    const { s, db, klant } = setup();
    s.invoices.importDefinitive(inv(UUID_2, velden([LAAG], { nummer: 'M1-2026-0007', datum: '2026-05-02', vervaldatum: '2026-06-01' })), klant.id);
    s.periods.startExchange('2026-03-31', 7, [], ASOF);
    // de ledger zelf gooit PeriodLockedError bij deze periode
    expect(() => s.ledger.post({ date: '2026-03-15', description: 'x', source: 'factuur', lines: [{ account: ACCOUNTS.debiteuren, debit: 1 }, { account: 'WOmzOmzOmz', credit: 1 }] })).toThrow(PeriodLockedError);
    const voor = aantallen(db);
    const r = s.invoices.importDefinitive(inv(UUID_1, velden()), klant.id);
    expect(r.uitkomst).toBe('geweigerd');
    expect(r.reden).toContain('boekhouder');
    expect(aantallen(db)).toEqual(voor);
  });

  it('(g) neemt de momentopnamen over, vult uuid en reeks en toont ze via get()', () => {
    const { s, db, klant } = setup();
    const v = velden([HOOG], { referentie: 'Order 7', intro: 'Beste klant', opmerking: 'Bedankt', leverdatum: '2026-03-10', leverdatum_tot: '2026-03-12' });
    const r = s.invoices.importDefinitive(inv(UUID_1, v), klant.id);
    const g = s.invoices.get(r.factuurId!);
    expect(g).toMatchObject({ number: 'M1-2026-0001', uuid: UUID_1, apparaat_code: 'M1', reeks_jaar: 2026, reeks_volgnr: 1, regeltabel_versie: '2026-1', status: 'verzonden', sent_at: '2026-03-15 10:30:00', reference: 'Order 7', intro: 'Beste klant', notes: 'Bedankt', delivery_date: '2026-03-10', delivery_date_to: '2026-03-12', relation_name: 'Bakkerij De Korst' });
    expect(JSON.parse(g.relation_snapshot!)).toMatchObject(KLANT);
    expect(JSON.parse(g.company_snapshot!)).toMatchObject(BEDRIJF);
    expect(g.lines).toHaveLength(1);
    expect(g.lines[0]).toMatchObject({ description: 'Montage', quantity: 2, unit: 'uur', unit_price: 4550, vat_code: 'hoog', vat_percentage: 21 });
    const rij = db.prepare('SELECT journal_entry_id, job_id FROM invoices WHERE id = ?').get(r.factuurId) as { journal_entry_id: number | null; job_id: number | null };
    expect(rij.journal_entry_id).not.toBeNull();
    expect(s.invoices.renderHtml(r.factuurId!)).toContain('M1-2026-0001');
  });

  it('(h) toont het openstaande bedrag en een betaling werkt ongewijzigd', () => {
    const { s, klant } = setup();
    const r = s.invoices.importDefinitive(inv(UUID_1, velden([HOOG])), klant.id);
    expect(s.invoices.get(r.factuurId!, ASOF)).toMatchObject({ open_amount: 11011, display_status: 'vervallen' });
    expect(s.invoices.listOpen('2026-03-20').map((x) => x.id)).toContain(r.factuurId);
    s.invoices.registerPayment(r.factuurId!, { amount: 5000, date: '2026-03-25' });
    expect(s.invoices.get(r.factuurId!)).toMatchObject({ open_amount: 6011, status: 'verzonden' });
    s.invoices.registerPayment(r.factuurId!, { amount: 6011, date: '2026-03-26' });
    expect(s.invoices.get(r.factuurId!)).toMatchObject({ open_amount: 0, status: 'betaald' });
  });

  it('(i) dezelfde uuid met afwijkende totalen of regels geeft conflict en wijzigt niets', () => {
    const { s, db, klant } = setup();
    const eerste = s.invoices.importDefinitive(inv(UUID_1, velden([HOOG, LAAG])), klant.id);
    const voor = momentopname(db, eerste.factuurId!);
    const tellers = aantallen(db);
    const ander = s.invoices.importDefinitive(inv(UUID_1, velden([{ ...HOOG, prijs: 5000 }, LAAG])), klant.id);
    expect(ander).toMatchObject({ uitkomst: 'conflict', factuurId: eerste.factuurId });
    expect(ander.reden).toContain('M1-2026-0001');
    // zelfde totalen, andere omschrijving
    const omschrijving = s.invoices.importDefinitive(inv(UUID_1, velden([{ ...HOOG, omschrijving: 'Andere tekst' }, LAAG])), klant.id);
    expect(omschrijving.uitkomst).toBe('conflict');
    expect(momentopname(db, eerste.factuurId!)).toBe(voor);
    expect(aantallen(db)).toEqual(tellers);
  });

  it('(j) een creditnota_van met een onbekende uuid geeft geweigerd met reden en geen halve rijen', () => {
    const { s, db, klant } = setup();
    s.invoices.importDefinitive(inv(UUID_1, velden([HOOG])), klant.id);
    const voor = aantallen(db);
    const r = s.invoices.importDefinitive(inv(UUID_2, velden([{ ...HOOG, hoeveelheid: -2 }], { nummer: 'M1-2026-0002', creditnota_van: UUID_ONBEKEND })), klant.id);
    expect(r.uitkomst).toBe('geweigerd');
    expect(r.reden).toContain('creditnota');
    expect(r.factuurId).toBeNull();
    expect(aantallen(db)).toEqual(voor);
  });

  it('(k) een EU-dienst met leverdatum in een andere maand boekt met dezelfde btw-datum als finalize', () => {
    const { s, db } = setup();
    const de = s.relations.create({ name: 'Brot GmbH', address: 'Hauptstraße 1', postcode: '10115', city: 'Berlin', country: 'DE', vat_number: 'DE123456789', email: 'info@brot.example' });
    const pc = s.invoices.finalize(
      s.invoices.createDraft({ relationId: de.id, invoiceDate: '2026-04-10', deliveryDate: '2026-03-20', lines: [{ description: 'Advies', quantity: 1, unitPrice: 100000, vatCode: 'icp-dienst' }] }).id,
    );
    const dienst: Regel = { omschrijving: 'Advies', hoeveelheid: 1, prijs: 100000, btw_soort: 'icp-dienst' };
    const r = s.invoices.importDefinitive(inv(UUID_1, velden([dienst], { datum: '2026-04-10', vervaldatum: '2026-05-10', leverdatum: '2026-03-20', klant_momentopname: { ...KLANT_DE } })), de.id);
    expect(r.uitkomst).toBe('nieuw');
    expect(boeking(db, r.factuurId!).vat_date).toBe('2026-03-20');
    expect(boeking(db, r.factuurId!)).toEqual(boeking(db, pc.id));
  });

  it('(k) dezelfde EU-dienst naast andere regels in een ander btw-tijdvak wordt geweigerd met de bestaande melding', () => {
    const { s, db } = setup();
    const de = s.relations.create({ name: 'Brot GmbH', address: 'Hauptstraße 1', postcode: '10115', city: 'Berlin', country: 'DE', vat_number: 'DE123456789', email: 'info@brot.example' });
    let pcMelding = '';
    try {
      s.invoices.finalize(
        s.invoices.createDraft({
          relationId: de.id,
          invoiceDate: '2026-04-10',
          deliveryDate: '2026-03-20',
          lines: [{ description: 'Advies', quantity: 1, unitPrice: 100000, vatCode: 'icp-dienst' }, { description: 'Montage', quantity: 1, unitPrice: 5000, vatCode: 'hoog' }],
        }).id,
      );
    } catch (e) {
      pcMelding = (e as Error).message;
    }
    expect(pcMelding).toContain('ander btw-tijdvak');
    const voor = aantallen(db);
    const regels: Regel[] = [{ omschrijving: 'Advies', hoeveelheid: 1, prijs: 100000, btw_soort: 'icp-dienst' }, { omschrijving: 'Montage', hoeveelheid: 1, prijs: 5000, btw_soort: 'hoog' }];
    const r = s.invoices.importDefinitive(inv(UUID_1, velden(regels, { datum: '2026-04-10', vervaldatum: '2026-05-10', leverdatum: '2026-03-20', klant_momentopname: { ...KLANT_DE } })), de.id);
    expect(r).toMatchObject({ uitkomst: 'geweigerd', reden: pcMelding });
    expect(aantallen(db)).toEqual(voor);
  });

  it('(l) met een jobId krijgt de factuur die job_id en blijven status en einddatum van de klus; zonder jobId blijft job_id NULL', () => {
    const { s, db, klant } = setup();
    const klus = s.jobs.create({ relationId: klant.id, title: 'Badkamer' });
    const jobVoor = JSON.stringify(db.prepare('SELECT * FROM jobs WHERE id = ?').get(klus.id));
    const met = s.invoices.importDefinitive(inv(UUID_1, velden()), klant.id, klus.id);
    const zonder = s.invoices.importDefinitive(inv(UUID_2, velden([LAAG], { nummer: 'M1-2026-0002' })), klant.id);
    const jobId = (id: number | null) => (db.prepare('SELECT job_id FROM invoices WHERE id = ?').get(id) as { job_id: number | null }).job_id;
    expect(jobId(met.factuurId)).toBe(klus.id);
    expect(jobId(zonder.factuurId)).toBeNull();
    expect(JSON.stringify(db.prepare('SELECT * FROM jobs WHERE id = ?').get(klus.id))).toBe(jobVoor);
  });

  it('weigert totalen die niet bij de regels passen en laat niets achter', () => {
    const { s, db, klant } = setup();
    const kapot = { ...velden(), totalen: { subtotaal: 1, btw: 0, totaal: 1 } } as FactuurVelden;
    const voor = aantallen(db);
    expect(s.invoices.importDefinitive(inv(UUID_1, kapot), klant.id)).toMatchObject({ uitkomst: 'geweigerd', factuurId: null });
    expect(aantallen(db)).toEqual(voor);
  });

  it('weigert een onbekende klant zonder halve rijen en raakt een lopende transactie niet', () => {
    const { s, db, klant } = setup();
    s.invoices.importDefinitive(inv(UUID_1, velden()), klant.id);
    const voor = aantallen(db);
    const r = s.invoices.importDefinitive(inv(UUID_2, velden([LAAG], { nummer: 'M1-2026-0002' })), 99999);
    expect(r.uitkomst).toBe('geweigerd');
    expect(aantallen(db)).toEqual(voor);
  });
});

describe('onveranderlijk', () => {
  function met() {
    const ctx = setup();
    const r = ctx.s.invoices.importDefinitive(inv(UUID_1, velden([HOOG, LAAG])), ctx.klant.id);
    return { ...ctx, id: r.factuurId! };
  }

  it('updateDraft weigert een telefoonfactuur en laat rij en regels ongemoeid', () => {
    const { s, db, id, aannemer } = met();
    const voor = momentopname(db, id);
    expect(() => s.invoices.updateDraft(id, { relationId: aannemer.id, reference: 'anders', lines: [{ description: 'x', quantity: 1, unitPrice: 1, vatCode: 'hoog' }] })).toThrow(/niet meer aanpassen/);
    expect(momentopname(db, id)).toBe(voor);
  });

  it('deleteDraft weigert een telefoonfactuur en laat rij en regels ongemoeid', () => {
    const { s, db, id } = met();
    const voor = momentopname(db, id);
    expect(() => s.invoices.deleteDraft(id)).toThrow(/niet verwijderen/);
    expect(momentopname(db, id)).toBe(voor);
  });

  it('finalize weigert een telefoonfactuur en laat de teller ongemoeid', () => {
    const { s, db, id } = met();
    const voor = momentopname(db, id);
    const instellingen = db.prepare('SELECT key, value FROM settings ORDER BY key').all();
    expect(() => s.invoices.finalize(id)).toThrow(/al definitief/);
    expect(momentopname(db, id)).toBe(voor);
    expect(db.prepare('SELECT key, value FROM settings ORDER BY key').all()).toEqual(instellingen);
  });

  it('createCreditNote werkt en laat het origineel ongewijzigd; de creditnota krijgt bij finalize een pc-nummer', () => {
    const { s, db, id } = met();
    const voor = momentopname(db, id);
    const credit = s.invoices.createCreditNote(id);
    expect(credit).toMatchObject({ status: 'concept', credit_of_invoice_id: id, uuid: null, apparaat_code: null });
    expect(momentopname(db, id)).toBe(voor);
    const definitief = s.invoices.finalize(credit.id);
    expect(definitief.number).not.toMatch(/^M\d/);
    expect(definitief.number).toBeTruthy();
    // alleen de verrekening raakt het origineel: amount_paid, status en paid_at
    const strip = (json: string) => {
      const o = JSON.parse(json) as { rij: Record<string, unknown>; regels: unknown[] };
      for (const k of ['amount_paid', 'status', 'paid_at']) delete o.rij[k];
      return o;
    };
    expect(strip(momentopname(db, id))).toEqual(strip(voor));
    expect(s.invoices.get(id)).toMatchObject({ open_amount: 0, status: 'betaald' });
  });

  it('markSent laat een gevulde sent_at van een telefoonfactuur ongemoeid, bij een pc-factuur werkt het nog', () => {
    const { s, db, id, klant } = met();
    const voor = momentopname(db, id);
    s.invoices.markSent(id);
    expect(momentopname(db, id)).toBe(voor);
    expect(s.invoices.get(id).sent_at).toBe('2026-03-15 10:30:00');
    const pc = pcFactuur(s, klant.id, PC_REGELS);
    db.prepare(`UPDATE invoices SET sent_at = '2000-01-01 00:00:00' WHERE id = ?`).run(pc.id);
    s.invoices.markSent(pc.id);
    expect(s.invoices.get(pc.id).sent_at).not.toBe('2000-01-01 00:00:00');
  });

  it('een betaling wijzigt alleen amount_paid, status en paid_at', () => {
    const { s, db, id } = met();
    const voor = JSON.parse(momentopname(db, id)) as { rij: Record<string, unknown>; regels: unknown[] };
    s.invoices.registerPayment(id, { amount: 20000, date: '2026-03-25' });
    s.invoices.registerPayment(id, { amount: s.invoices.get(id).open_amount, date: '2026-03-26' });
    const na = JSON.parse(momentopname(db, id)) as { rij: Record<string, unknown>; regels: unknown[] };
    const verschil = Object.keys(na.rij).filter((k) => JSON.stringify(na.rij[k]) !== JSON.stringify(voor.rij[k]));
    expect(verschil.sort()).toEqual(['amount_paid', 'paid_at', 'status']);
    expect(na.rij).toMatchObject({ status: 'betaald', paid_at: '2026-03-26' });
    expect(na.regels).toEqual(voor.regels);
  });

  it('een afschrijving of verrekening laat de vaste velden van een telefoonfactuur staan', () => {
    const { s, db, id } = met();
    const voor = JSON.parse(momentopname(db, id)) as { rij: Record<string, unknown>; regels: unknown[] };
    s.invoices.writeOffBadDebt(id, '2026-06-01');
    const na = JSON.parse(momentopname(db, id)) as { rij: Record<string, unknown>; regels: unknown[] };
    for (const k of ['number', 'uuid', 'apparaat_code', 'reeks_jaar', 'reeks_volgnr', 'invoice_date', 'due_date', 'relation_snapshot', 'company_snapshot', 'subtotal', 'vat_total', 'total']) expect(na.rij[k]).toEqual(voor.rij[k]);
    expect(na.regels).toEqual(voor.regels);
  });
});

describe('dateWarnings', () => {
  it('een telefoonfactuur met een latere datum geeft geen latere-datum-waarschuwing op een nieuwe pc-factuur', () => {
    const { s, klant } = setup();
    s.invoices.importDefinitive(inv(UUID_1, velden([HOOG], { datum: '2026-05-20', vervaldatum: '2026-06-19' })), klant.id);
    expect(s.invoices.dateWarnings('2026-03-01', undefined, ASOF)).toEqual([]);
  });

  it('de waarschuwing tussen pc-facturen werkt ongewijzigd, ook met een telefoonfactuur ertussen', () => {
    const { s, klant } = setup();
    const pc = s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-05-20', lines: PC_REGELS }).id);
    s.invoices.importDefinitive(inv(UUID_1, velden([HOOG], { datum: '2026-07-01', vervaldatum: '2026-07-31' })), klant.id);
    const w = s.invoices.dateWarnings('2026-03-01', undefined, ASOF);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain(pc.number!);
    expect(w[0]).toContain('latere datum');
  });
});

describe('importDefinitive: strengere controles na review', () => {
  it('een creditnota van een andere klant op een factuur van klant A wordt geweigerd; het grootboek van A blijft staan', () => {
    const { s, db, klant, aannemer } = setup();
    const orig = s.invoices.importDefinitive(inv(UUID_1, velden([HOOG])), klant.id);
    const voor = aantallen(db);
    const origVoor = momentopname(db, orig.factuurId!);
    const r = s.invoices.importDefinitive(inv(UUID_2, velden([{ ...HOOG, hoeveelheid: -2 }], { nummer: 'M1-2026-0002', datum: '2026-03-20', vervaldatum: '2026-04-19', creditnota_van: UUID_1 })), aannemer.id);
    expect(r).toMatchObject({ uitkomst: 'geweigerd', factuurId: null });
    expect(r.reden).toMatch(/andere klant/);
    expect(aantallen(db)).toEqual(voor);
    expect(momentopname(db, orig.factuurId!)).toBe(origVoor);
    expect(s.invoices.get(orig.factuurId!).open_amount).toBe(11011);
    expect(s.invoices.overpaidCustomers()).toEqual([]);
  });

  it('een creditnota die groter is dan het origineel, of geen negatief bedrag heeft, wordt geweigerd', () => {
    const { s, db, klant } = setup();
    s.invoices.importDefinitive(inv(UUID_1, velden([HOOG])), klant.id);
    const voor = aantallen(db);
    const teGroot = s.invoices.importDefinitive(inv(UUID_2, velden([{ ...HOOG, hoeveelheid: -3 }], { nummer: 'M1-2026-0002', creditnota_van: UUID_1 })), klant.id);
    expect(teGroot).toMatchObject({ uitkomst: 'geweigerd', factuurId: null });
    expect(teGroot.reden).toMatch(/groter dan/);
    const positief = s.invoices.importDefinitive(inv(UUID_3, velden([HOOG], { nummer: 'M1-2026-0003', creditnota_van: UUID_1 })), klant.id);
    expect(positief).toMatchObject({ uitkomst: 'geweigerd', factuurId: null });
    expect(positief.reden).toMatch(/negatief/);
    expect(aantallen(db)).toEqual(voor);
  });

  it('een deelcreditnota binnen het origineel blijft mogelijk', () => {
    const { s, klant } = setup();
    const orig = s.invoices.importDefinitive(inv(UUID_1, velden([HOOG])), klant.id);
    const r = s.invoices.importDefinitive(inv(UUID_2, velden([{ ...HOOG, hoeveelheid: -1 }], { nummer: 'M1-2026-0002', creditnota_van: UUID_1 })), klant.id);
    expect(r.uitkomst).toBe('nieuw');
    expect(s.invoices.get(orig.factuurId!).open_amount).toBe(5505);
  });

  const EU_REGEL: Regel = { omschrijving: 'Advies', hoeveelheid: 1, prijs: 100000, btw_soort: 'icp-dienst' };
  const EU_OVER = { datum: '2026-04-10', vervaldatum: '2026-05-10', leverdatum: '2026-03-20', klant_momentopname: { ...KLANT_DE } };
  const eu = () => {
    const ctx = setup();
    const de = ctx.s.relations.create({ name: 'Brot GmbH', address: 'Hauptstraße 1', postcode: '10115', city: 'Berlin', country: 'DE', vat_number: 'DE123456789', email: 'info@brot.example' });
    const eerste = ctx.s.invoices.importDefinitive(inv(UUID_1, velden([EU_REGEL], EU_OVER)), de.id);
    return { ...ctx, de, eerste };
  };

  it('dezelfde uuid met een andere leverdatum is een conflict en wijzigt niets; een exacte herhaling blijft al_aanwezig', () => {
    const { s, db, de, eerste } = eu();
    expect(eerste.uitkomst).toBe('nieuw');
    const voor = momentopname(db, eerste.factuurId!);
    const tellers = aantallen(db);
    const ander = s.invoices.importDefinitive(inv(UUID_1, velden([EU_REGEL], { ...EU_OVER, leverdatum: '2026-04-10' })), de.id);
    expect(ander).toMatchObject({ uitkomst: 'conflict', factuurId: eerste.factuurId });
    expect(s.invoices.importDefinitive(inv(UUID_1, velden([EU_REGEL], EU_OVER)), de.id)).toMatchObject({ uitkomst: 'al_aanwezig', factuurId: eerste.factuurId });
    expect(momentopname(db, eerste.factuurId!)).toBe(voor);
    expect(aantallen(db)).toEqual(tellers);
  });

  it('elke afwijking in de vaste inhoud van dezelfde uuid is een conflict', () => {
    const { s, db, de, eerste } = eu();
    const ander = s.relations.create({ name: 'Andere klant', email: 'a@example.nl' });
    const voor = momentopname(db, eerste.factuurId!);
    const afwijkingen: [string, Record<string, unknown>][] = [
      ['vervaldatum', { vervaldatum: '2026-05-11' }],
      ['leverdatum_tot', { leverdatum_tot: '2026-03-25' }],
      ['referentie', { referentie: 'Order 7' }],
      ['intro', { intro: 'Hallo' }],
      ['opmerking', { opmerking: 'Let op' }],
      ['klantmomentopname', { klant_momentopname: { ...KLANT_DE, city: 'Hamburg' } }],
      ['bedrijfsmomentopname', { bedrijf_momentopname: { ...BEDRIJF, city: 'Zwolle-Zuid' } }],
      ['verzonden_op', { verzonden_op: '2026-04-10 11:00:00' }],
      ['regeltabel_versie', { regeltabel_versie: '2026-2' }],
    ];
    for (const [naam, over] of afwijkingen) {
      const r = s.invoices.importDefinitive(inv(UUID_1, velden([EU_REGEL], { ...EU_OVER, ...over })), de.id);
      expect(r.uitkomst, naam).toBe('conflict');
    }
    expect(s.invoices.importDefinitive(inv(UUID_1, velden([EU_REGEL], EU_OVER)), ander.id).uitkomst).toBe('conflict');
    expect(s.invoices.importDefinitive(inv(UUID_1, velden([{ ...EU_REGEL, eenheid: 'uur' }], EU_OVER)), de.id).uitkomst).toBe('conflict');
    expect(momentopname(db, eerste.factuurId!)).toBe(voor);
  });

  it('een herhaling met een volgorde-afwijkende momentopname maar gelijke inhoud en een ander jobId is al_aanwezig en wijzigt niets', () => {
    const { s, db, de, eerste } = eu();
    const voor = momentopname(db, eerste.factuurId!);
    const omgekeerd = Object.fromEntries(Object.entries(KLANT_DE).reverse());
    const r = s.invoices.importDefinitive(inv(UUID_1, velden([EU_REGEL], { ...EU_OVER, klant_momentopname: omgekeerd })), de.id, 12345);
    expect(r).toMatchObject({ uitkomst: 'al_aanwezig', factuurId: eerste.factuurId });
    expect(momentopname(db, eerste.factuurId!)).toBe(voor);
  });

  it('een creditnota_van die afwijkt is een conflict bij dezelfde uuid', () => {
    const { s, klant } = setup();
    s.invoices.importDefinitive(inv(UUID_1, velden([HOOG])), klant.id);
    const c = velden([{ ...HOOG, hoeveelheid: -2 }], { nummer: 'M1-2026-0002', creditnota_van: UUID_1 });
    expect(s.invoices.importDefinitive(inv(UUID_2, c), klant.id).uitkomst).toBe('nieuw');
    expect(s.invoices.importDefinitive(inv(UUID_2, c), klant.id).uitkomst).toBe('al_aanwezig');
    const zonder = velden([{ ...HOOG, hoeveelheid: -2 }], { nummer: 'M1-2026-0002' });
    expect(s.invoices.importDefinitive(inv(UUID_2, zonder), klant.id).uitkomst).toBe('conflict');
  });

  it('een hoeveelheid met meer dan drie decimalen wordt geweigerd zonder halve rijen, ook als de kern hem niet gezien heeft', () => {
    const { s, db, klant } = setup();
    const regel = { omschrijving: 'Materiaal', hoeveelheid: 1.0004, prijs: 100000, btw_soort: 'hoog', btw_percentage: 21, eenheid: null };
    const t = computeTotals([{ description: 'Materiaal', quantity: 1.0004, unitPrice: 100000, vatCode: 'hoog' }]);
    const basis = velden([HOOG]);
    const v = { ...basis, regels: [regel], totalen: { subtotaal: t.subtotal, btw: t.vatTotal, totaal: t.total } } as unknown as FactuurVelden;
    const voor = aantallen(db);
    const r = s.invoices.importDefinitive(inv(UUID_1, v), klant.id);
    expect(r).toMatchObject({ uitkomst: 'geweigerd', factuurId: null });
    expect(r.reden).toMatch(/drie decimalen/);
    expect(aantallen(db)).toEqual(voor);
  });
});

describe('sendInvoice en telefoonfacturen', () => {
  it('de pc verstuurt een telefoonfactuur nooit: geweigerd, geen mail, niets gewijzigd', async () => {
    const { s, db, sent, klant } = setup();
    const r = s.invoices.importDefinitive(inv(UUID_1, velden([HOOG])), klant.id);
    const voor = momentopname(db, r.factuurId!);
    await expect(s.sender.sendInvoice(r.factuurId!)).rejects.toThrow(/telefoon/);
    expect(sent).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM email_log').get()).toEqual({ n: 0 });
    expect(momentopname(db, r.factuurId!)).toBe(voor);
  });

  it('een betalingsherinnering voor een openstaande telefoonfactuur mag wel, zonder eigen PDF als bijlage', async () => {
    const { s, sent, klant } = setup();
    const r = s.invoices.importDefinitive(inv(UUID_1, velden([HOOG])), klant.id);
    await s.sender.sendReminder(r.factuurId!);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.attachments ?? []).toHaveLength(0);
    const pc = pcFactuur(s, klant.id, PC_REGELS);
    await s.sender.sendInvoice(pc.id);
    await s.sender.sendReminder(pc.id);
    expect(sent[sent.length - 1]!.attachments ?? []).toHaveLength(1);
  });

  it('een pc-factuur wordt nog gewoon verstuurd', async () => {
    const { s, sent, klant } = setup();
    const pc = pcFactuur(s, klant.id, PC_REGELS);
    const verstuurd = await s.sender.sendInvoice(pc.id);
    expect(sent).toHaveLength(1);
    expect(verstuurd.sent_at).not.toBeNull();
  });
});
