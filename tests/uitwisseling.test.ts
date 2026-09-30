import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database';
import { createServices, MemorySecretStore } from '../src/services';
import { createApi, type HostContext } from '../src/main/api';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { createBackupBundle, extractBundle } from '../src/main/backup';
import { generateOfficeKeys, readHeader } from '../src/exchange/crypto';
import { ExchangeService, sanitizeForExchange, type OfficeProfile } from '../src/exchange/exchange';

const VERSION = '1.0.0';
const ASOF = '2026-10-15';

const open: Database.Database[] = [];
afterAll(() => open.forEach((db) => db.open && db.close()));

function servicesAt(dir: string) {
  mkdirSync(dir, { recursive: true });
  const db = openDatabase(join(dir, 'boekhouding.sqlite'));
  open.push(db);
  const secrets = new MemorySecretStore();
  const s = createServices(db, {
    pdf: async () => Buffer.from('%PDF'),
    mailerFactory: async () => { throw new Error('geen mail in tests'); },
    secrets,
    fetch: async () => { throw new Error('geen netwerk in tests'); },
    storeFile: async (name) => join(dir, 'bijlagen', name),
    licensePublicKey: '', // licenties uit: dit test de uitwisseling zelf
  });
  return { db, s, secrets, dir };
}

/** De klant: een administratie op schijf met een kwartaal werk, gekoppeld aan het kantoor. */
function client(profile: OfficeProfile) {
  const c = servicesAt(mkdtempSync(join(tmpdir(), 'gb-klant-')));
  const { s, dir } = c;
  s.settings.update({ onboardingDone: true, company: { ...s.settings.get().company, name: 'Stukadoorsbedrijf Piet', email: 'piet@example.nl', address: 'Kalkweg 1', postcode: '1234 AB', city: 'Utrecht', kvkNumber: '12345678', vatNumber: 'NL123456789B01', iban: 'NL91ABNA0417164300' } });
  s.license.managementKey();
  s.db.prepare(`INSERT INTO secrets (key, value) VALUES ('smtp:password', x'01020304')`).run();
  s.settings.update({ smtp: { ...s.settings.get().smtp, host: 'smtp.piet.nl', user: 'piet' } });
  const klant = s.relations.create({ name: 'Familie Jansen', country: 'NL', address: 'Dorpsstraat 5', postcode: '3511 AA', city: 'Utrecht' });
  const inv = s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-08-10', lines: [{ description: 'Stucwerk', quantity: 1, unitPrice: 100000, vatCode: 'hoog' }] }).id);
  const gamma = s.relations.findOrCreateSupplier('Gamma');
  mkdirSync(join(dir, 'bijlagen', '2026'), { recursive: true });
  const bon = join(dir, 'bijlagen', '2026', 'gamma.pdf');
  writeFileSync(bon, '%PDF-1.4 gamma');
  const purchase = s.purchases.create({ relationId: gamma.id, invoiceDate: '2026-09-10', description: 'Materiaal', lines: [{ account: 'WKprInkMat', netAmount: 20000, vatCode: 'hoog' }], attachmentPath: bon });
  const purchaseEntry = (s.db.prepare('SELECT journal_entry_id AS id FROM purchase_invoices WHERE id = ?').get(purchase.id) as { id: number }).id;
  const bundle = () => createBackupBundle(s.db, dir, (copy) => {
    const d = new Database(copy);
    sanitizeForExchange(d);
    d.close();
  });
  s.exchange.link(ExchangeService.invite(profile));
  return { ...c, inv, gamma, purchaseEntry, bundle };
}

function office(): OfficeProfile {
  return { office: 'Kantoor De Vries', email: 'info@kantoordevries.nl', ...generateOfficeKeys() };
}

/** Bij de boekhouder: de export uitpakken in een eigen map en er de kopie van maken. */
function openAtOffice(profile: OfficeProfile, file: Buffer) {
  const opened = ExchangeService.openExport(profile, file, VERSION);
  const dir = mkdtempSync(join(tmpdir(), 'gb-kantoor-'));
  extractBundle(opened.bundle, dir);
  const copy = servicesAt(dir);
  copy.s.exchange.initCopy(opened.header, opened.meta, profile.office);
  return copy;
}

const trial = (s: ReturnType<typeof servicesAt>['s'], to: string) =>
  s.ledgerReports.trialBalance('2026-01-01', to).rows.map((r) => [r.code, r.opening, r.debit, r.credit, r.closing]);

describe('uitwisseling met de boekhouder: de hele cyclus', () => {
  it('export → correcties bij de boekhouder → klant werkt door → antwoord inlezen', async () => {
    const profile = office();
    const c = client(profile);
    expect(c.s.exchange.partner()).toMatchObject({ office: 'Kantoor De Vries', email: 'info@kantoordevries.nl' });

    // 1. de klant stuurt t/m 30 september
    const exp = await c.s.exchange.createExport('2026-09-30', [], VERSION, c.bundle, ASOF);
    expect(exp.exchange).toBe(1);
    expect(readHeader(exp.file)).toMatchObject({ richting: 'naar-boekhouder', administratie: c.s.settings.administrationId(), uitwisseling: 1, einddatum: '2026-09-30' });
    expect(c.s.periods.status().exchange).toEqual({ until: '2026-09-30', no: 1 });

    // 2. de klant werkt door na de einddatum; in de periode kan niets meer
    const oktober = c.s.purchases.create({ relationId: c.gamma.id, invoiceDate: '2026-10-05', description: 'Schroeven', lines: [{ account: 'WKprInkMat', netAmount: 3000, vatCode: 'hoog' }] });
    expect(() => c.s.purchases.create({ relationId: c.gamma.id, invoiceDate: '2026-09-20', description: 'Laat', lines: [{ account: 'WKprInkMat', netAmount: 1000, vatCode: 'hoog' }] })).toThrow(/ligt bij je boekhouder/);

    // 3. de boekhouder opent de export: een kopie zonder geheimen, met de bijlagen
    const o = openAtOffice(profile, exp.file);
    expect(o.s.settings.officeCopy()).toEqual({ office: 'Kantoor De Vries', exchange: 1, endDate: '2026-09-30' });
    expect(o.s.settings.administrationId()).toBe(c.s.settings.administrationId());
    expect((o.db.prepare('SELECT COUNT(*) AS n FROM secrets').get() as { n: number }).n).toBe(0);
    expect(o.db.prepare(`SELECT 1 FROM settings WHERE key = 'licenseManagementKey'`).get()).toBeUndefined();
    expect(o.s.settings.get().smtp.host).toBe('');
    const bon = (o.db.prepare('SELECT attachment_path AS p FROM purchase_invoices WHERE journal_entry_id = ?').get(c.purchaseEntry) as { p: string }).p;
    expect(bon.startsWith(o.dir)).toBe(true);
    expect(readFileSync(bon, 'utf8')).toBe('%PDF-1.4 gamma');
    // de oktoberaankoop van de klant zit er niet in: die kwam na de export
    expect(o.s.ledger.balance('WKprInkMat')).toBe(20000);

    // 4. de boekhouder corrigeert
    const vergeten = o.s.exchange.act({ kind: 'memoriaal', input: { date: '2026-09-30', description: 'Bankkosten Q3', lines: [{ account: ACCOUNTS.bankkosten, debit: 1500 }, { account: ACCOUNTS.bank, credit: 1500 }] } });
    o.s.exchange.act({ kind: 'terugdraaien', input: { entryId: c.purchaseEntry, date: '2026-09-30' } });
    o.s.exchange.act({ kind: 'memoriaal', input: { date: '2026-09-30', description: 'Materiaal Gamma zonder btw', lines: [{ account: 'WKprInkMat', debit: 24200 }, { account: ACCOUNTS.crediteuren, credit: 24200 }] } });
    // zijn eigen correctie terugdraaien: verwijst naar een boeking die bij de klant nog niet bestaat
    o.s.exchange.act({ kind: 'terugdraaien', input: { entryId: vergeten.entryIds[0]!, date: '2026-09-30' } });
    o.s.exchange.act({ kind: 'memoriaal', input: { date: '2026-09-30', description: 'Bankkosten Q3 (goed bedrag)', lines: [{ account: ACCOUNTS.bankkosten, debit: 1250 }, { account: ACCOUNTS.bank, credit: 1250 }] } });
    o.s.exchange.act({ kind: 'rekening', input: { code: '4990', rgs: 'EigenBoetes', name: 'Boetes', category: 'kosten' } });
    // buiten de periode, of iets anders dan een vastgelegde handeling: niet
    expect(() => o.s.exchange.act({ kind: 'memoriaal', input: { date: '2026-10-01', description: 'x', lines: [{ account: ACCOUNTS.bankkosten, debit: 1 }, { account: ACCOUNTS.bank, credit: 1 }] } })).toThrow(/t\/m 30 september 2026/);
    expect(() => o.s.purchases.create({ relationId: c.gamma.id, invoiceDate: '2026-09-15', description: 'x', lines: [{ account: 'WKprInkMat', netAmount: 100, vatCode: 'hoog' }] })).toThrow(/alleen correctieboekingen/);
    expect(o.s.exchange.actions().map((a) => a.kind)).toEqual(['memoriaal', 'terugdraaien', 'memoriaal', 'terugdraaien', 'memoriaal', 'rekening']);

    // 5. het antwoord
    const answer = o.s.exchange.createAnswer(VERSION);
    expect(answer.count).toBe(6);
    expect(answer.email).toBe('piet@example.nl');
    expect(readHeader(answer.file)).toMatchObject({ richting: 'naar-klant', uitwisseling: 1 });
    o.s.exchange.markAnswered();
    expect(() => o.s.exchange.act({ kind: 'rekening', input: { code: '4991', rgs: 'EigenX', name: 'X', category: 'kosten' } })).toThrow(/al gemaakt/);

    // 6. de klant leest in: andere versie eerst niet
    expect(() => c.s.exchange.readAnswer(answer.file, '1.0.1')).toThrow(/versie 1.0.0 en jij 1.0.1/);
    const r = c.s.exchange.readAnswer(answer.file, VERSION);
    expect(r).toMatchObject({ office: 'Kantoor De Vries', count: 6, closedUntil: '2026-09-30' });
    expect(r.summaries[1]).toMatch(/^Teruggedraaid: Inkoop: Materiaal/);

    // de periode is afgesloten en precies gelijk aan die van de boekhouder
    expect(c.s.periods.status()).toMatchObject({ closedUntil: '2026-09-30', exchange: null });
    expect(trial(c.s, '2026-09-30')).toEqual(trial(o.s, '2026-09-30'));
    expect(c.s.ledger.balance(ACCOUNTS.bankkosten)).toBe(1250);
    expect(c.s.ledger.getAccount('EigenBoetes').code).toBe('4990');
    // het werk van de klant na de einddatum is er nog
    expect(c.s.purchases.get(oktober.id).invoice_date).toBe('2026-10-05');
    expect(c.s.ledger.balance('WKprInkMat', { from: '2026-10-01', to: '2026-10-31' })).toBe(3000);
    expect(c.s.ledger.balance('WKprInkMat')).toBe(24200 + 3000);
    expect(c.s.ledger.checkIntegrity().balanced).toBe(true);

    // 7. nog een keer inlezen kan niet; de sleutel is weg
    expect(() => c.s.exchange.readAnswer(answer.file, VERSION)).toThrow(/Er loopt geen uitwisseling/);
    expect(c.secrets.get('exchange:key:1')).toBeNull();
    expect(c.s.exchange.lastAnswer()).toMatchObject({ exchange: 1, office: 'Kantoor De Vries', count: 6 });

    // 8. de volgende uitwisseling begint na de afgesloten periode
    expect(() => c.s.periods.startExchange('2026-09-30', 2, [], ASOF)).toThrow(/al afgesloten/);
  });
});

describe('uitwisseling: wat niet mag', () => {
  it('alleen het kantoor van de uitnodiging, en alleen met dezelfde versie', async () => {
    const profile = office();
    const c = client(profile);
    const exp = await c.s.exchange.createExport('2026-09-30', [], VERSION, c.bundle, ASOF);
    expect(() => ExchangeService.openExport(office(), exp.file, VERSION)).toThrow(/niet geopend worden/);
    expect(() => ExchangeService.openExport(profile, exp.file, '1.1.0')).toThrow(/versie 1.0.0 en jij 1.1.0/);
  });

  it('een eigen export, een antwoord voor een andere administratie of na afbreken wordt geweigerd', async () => {
    const profile = office();
    const c = client(profile);
    const exp = await c.s.exchange.createExport('2026-09-30', [], VERSION, c.bundle, ASOF);
    expect(() => c.s.exchange.readAnswer(exp.file, VERSION)).toThrow(/geen antwoord/);

    // antwoord van een andere klant van hetzelfde kantoor
    const other = client(profile);
    const otherExp = await other.s.exchange.createExport('2026-09-30', [], VERSION, other.bundle, ASOF);
    const o = openAtOffice(profile, otherExp.file);
    const answer = o.s.exchange.createAnswer(VERSION);
    expect(() => c.s.exchange.readAnswer(answer.file, VERSION)).toThrow(/andere administratie/);

    // afbreken: de periode is weer open en het antwoord past niet meer
    other.s.exchange.abort();
    expect(other.s.periods.status().exchange).toBeNull();
    expect(() => other.s.exchange.readAnswer(answer.file, VERSION)).toThrow(/Er loopt geen uitwisseling/);
    // en een nieuwe export krijgt een nieuw nummer
    const again = await other.s.exchange.createExport('2026-09-30', [], VERSION, other.bundle, ASOF);
    expect(again.exchange).toBe(2);
  });

  it('een gewijzigd antwoord opent niet, en er verandert niets', async () => {
    const profile = office();
    const c = client(profile);
    const exp = await c.s.exchange.createExport('2026-09-30', [], VERSION, c.bundle, ASOF);
    const o = openAtOffice(profile, exp.file);
    o.s.exchange.act({ kind: 'memoriaal', input: { date: '2026-09-30', description: 'Correctie', lines: [{ account: ACCOUNTS.bankkosten, debit: 500 }, { account: ACCOUNTS.bank, credit: 500 }] } });
    const answer = o.s.exchange.createAnswer(VERSION).file;
    const tampered = Buffer.from(answer);
    tampered[tampered.length - 5]! ^= 0xff;
    expect(() => c.s.exchange.readAnswer(tampered, VERSION)).toThrow(/niet geopend worden/);
    expect(c.s.ledger.balance(ACCOUNTS.bankkosten)).toBe(0);
    expect(c.s.periods.status().exchange).toEqual({ until: '2026-09-30', no: 1 });
  });

  it('koppelen en exporteren: eerst een uitnodiging, en niet tijdens een uitwisseling', async () => {
    const profile = office();
    const c = client(profile);
    expect(() => ExchangeService.readInvite(Buffer.from('{"type":"iets"}'))).toThrow(/geen uitnodiging/);
    await c.s.exchange.createExport('2026-09-30', [], VERSION, c.bundle, ASOF);
    expect(() => c.s.exchange.link(ExchangeService.invite(office()))).toThrow(/loopt nog een uitwisseling/);
    expect(() => c.s.exchange.unlink()).toThrow(/loopt nog een uitwisseling/);
    c.s.exchange.abort();
    c.s.exchange.unlink();
    await expect(c.s.exchange.createExport('2026-09-30', [], VERSION, c.bundle, ASOF)).rejects.toThrow(/uitnodiging/);
    expect(existsSync(c.dir)).toBe(true);
  });
});

describe('uitwisseling: randgevallen', () => {
  it('werk van na de einddatum dat al vóór de export bestond: de boekhouder ziet het, maar kan het niet terugdraaien', async () => {
    const profile = office();
    const c = client(profile);
    const oktober = c.s.purchases.create({ relationId: c.gamma.id, invoiceDate: '2026-10-05', description: 'Schroeven', lines: [{ account: 'WKprInkMat', netAmount: 3000, vatCode: 'hoog' }] });
    const oktoberEntry = (c.db.prepare('SELECT journal_entry_id AS id FROM purchase_invoices WHERE id = ?').get(oktober.id) as { id: number }).id;
    const exp = await c.s.exchange.createExport('2026-09-30', [], VERSION, c.bundle, ASOF);
    const o = openAtOffice(profile, exp.file);
    expect(o.s.ledger.balance('WKprInkMat', { from: '2026-10-01', to: '2026-10-31' })).toBe(3000);
    expect(() => o.s.exchange.act({ kind: 'terugdraaien', input: { entryId: oktoberEntry, date: '2026-09-30' } })).toThrow(/t\/m 30 september 2026/);
    // na het inlezen van het (lege) antwoord is de oktoberaankoop bij de klant onveranderd
    c.s.exchange.readAnswer(o.s.exchange.createAnswer(VERSION).file, VERSION);
    expect(c.s.ledger.getEntry(oktoberEntry).status).toBe('definitief');
  });

  it('een uitnodiging met een ongeldige sleutel wordt niet gekoppeld', () => {
    const invite = JSON.parse(ExchangeService.invite(office()).toString()) as Record<string, unknown>;
    const broken = Buffer.from(JSON.stringify({ ...invite, publiekeSleutel: 'abc' }));
    expect(() => ExchangeService.readInvite(broken)).toThrow(/beschadigd/);
  });

  function apiFor(c: ReturnType<typeof client>, saveFile: HostContext['saveFile']) {
    return createApi(c.s, { appVersion: () => VERSION, saveFile, exchange: { bundle: c.bundle, office: () => null, saveOffice: () => { throw new Error('x'); }, openClientExport: async () => { throw new Error('x'); } } } as unknown as HostContext);
  }

  it('export: lukt het bewaren niet (annuleren of een fout), dan gaat de periode niet op slot', async () => {
    // via de API geldt de echte datum van vandaag: een kwartaal dat zeker voorbij is
    const c = client(office());
    const cancel = apiFor(c, async () => null);
    expect(await cancel.exchange.send('2026-06-30', [], 'bestand')).toMatchObject({ exchange: null, path: null });
    expect(c.s.periods.status().exchange).toBeNull();
    const failing = apiFor(c, async () => { throw new Error('Schijf vol'); });
    await expect(failing.exchange.send('2026-06-30', [], 'bestand')).rejects.toThrow(/Schijf vol/);
    expect(c.s.periods.status().exchange).toBeNull();
    const ok = apiFor(c, async (name) => `/tmp/${name}`);
    expect(await ok.exchange.send('2026-06-30', [], 'bestand')).toMatchObject({ exchange: 3 });
    expect(c.s.periods.status().exchange).toMatchObject({ no: 3 });
  });

  it('antwoord: pas als het bestand bewaard is, telt het als gemaakt', async () => {
    const profile = office();
    const c = client(profile);
    const o = openAtOffice(profile, (await c.s.exchange.createExport('2026-09-30', [], VERSION, c.bundle, ASOF)).file);
    const correction = { kind: 'memoriaal' as const, input: { date: '2026-09-30', description: 'x', lines: [{ account: ACCOUNTS.bankkosten, debit: 100 }, { account: ACCOUNTS.bank, credit: 100 }] } };
    const failing = createApi(o.s, { appVersion: () => VERSION, saveFile: async () => { throw new Error('Schijf vol'); } } as unknown as HostContext);
    await expect(failing.exchange.answer()).rejects.toThrow(/Schijf vol/);
    expect(() => o.s.exchange.act(correction)).not.toThrow();
    const cancel = createApi(o.s, { appVersion: () => VERSION, saveFile: async () => null } as unknown as HostContext);
    expect(await cancel.exchange.answer()).toMatchObject({ path: null });
    expect(() => o.s.exchange.act(correction)).not.toThrow();
    const ok = createApi(o.s, { appVersion: () => VERSION, saveFile: async (name: string) => `/tmp/${name}` } as unknown as HostContext);
    expect(await ok.exchange.answer()).toMatchObject({ count: 2 });
    expect(() => o.s.exchange.act(correction)).toThrow(/al gemaakt/);
  });
});

describe('uitwisseling: afronden', () => {
  it('in de kopie bij de boekhouder: geen takenlijst en geen "Aan de slag" van de klant', async () => {
    const profile = office();
    const c = client(profile);
    c.s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-10-02', amount: -2500, description: 'Pin', counterName: 'SHELL' }] });
    expect(c.s.inbox.tasks(ASOF).length).toBeGreaterThan(0);
    const o = openAtOffice(profile, (await c.s.exchange.createExport('2026-09-30', [], VERSION, c.bundle, ASOF)).file);
    expect(o.s.inbox.tasks(ASOF)).toEqual([]);
    expect(o.s.checklist.items()).toEqual([]);
    expect(o.s.inbox.autoProcess(ASOF)).toEqual({ matched: 0, booked: 0 });
  });

  it('teruggedraaid terwijl er al op betaald is: een taak op Vandaag die je kunt afvinken', async () => {
    const profile = office();
    const c = client(profile);
    const exp = await c.s.exchange.createExport('2026-09-30', [], VERSION, c.bundle, ASOF);
    // de klant krijgt de factuur van augustus in oktober betaald (na de einddatum: mag)
    c.s.invoices.registerPayment(c.inv.id, { amount: 121000, date: '2026-10-03' });
    const o = openAtOffice(profile, exp.file);
    // de boekhouder draait de factuur terug (bv. dubieus), zonder de betaling te kennen
    o.s.exchange.act({ kind: 'terugdraaien', input: { entryId: c.inv.journal_entry_id!, date: '2026-08-10' } });
    const r = c.s.exchange.readAnswer(o.s.exchange.createAnswer(VERSION).file, VERSION);
    expect(r.conflicts).toEqual([{ kind: 'factuur', id: c.inv.id, label: c.inv.number, paid: 121000, exchange: 1, office: 'Kantoor De Vries' }]);
    const task = c.s.inbox.tasks(ASOF).find((t) => t.kind === 'exchange-conflict')!;
    expect(task).toMatchObject({ title: `Factuur ${c.inv.number}: teruggedraaid door Kantoor De Vries`, ref: { invoiceId: c.inv.id } });
    expect(task.question).toMatch(/€\s1\.210,00 op betaald/);
    const api = createApi(c.s, { appVersion: () => VERSION } as unknown as HostContext);
    expect(await api.home.act(task, 'open')).toEqual({ navigate: { screen: 'factuur', id: c.inv.id } });
    await api.home.act(task, 'klaar');
    expect(c.s.inbox.tasks(ASOF).some((t) => t.kind === 'exchange-conflict')).toBe(false);
  });

  it('teruggedraaid zonder betaling: geen taak', async () => {
    const profile = office();
    const c = client(profile);
    const o = openAtOffice(profile, (await c.s.exchange.createExport('2026-09-30', [], VERSION, c.bundle, ASOF)).file);
    o.s.exchange.act({ kind: 'terugdraaien', input: { entryId: c.purchaseEntry, date: '2026-09-10' } });
    expect(c.s.exchange.readAnswer(o.s.exchange.createAnswer(VERSION).file, VERSION).conflicts).toEqual([]);
  });
});
