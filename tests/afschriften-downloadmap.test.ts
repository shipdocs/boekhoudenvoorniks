import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { createApi, type HostContext } from '../src/main/api';
import { folderAccess } from '../src/main/statement-files';
import { StatementWatch } from '../src/main/statement-watch';
import { sanitizeForExchange } from '../src/exchange/exchange';
import { LOOK_BACK_DAYS, MAX_STATEMENT_BYTES, type FolderAccess } from '../src/import/statement-folder';
import { bankOfIban, GENERAL_STATEMENT_HELP, statementHelp } from '../src/shared/bank-statement-help';
import type { Task } from '../src/inbox/inbox';
import { addDays, today } from '../src/shared/dates';

/**
 * Afschriften uit je downloadmap (#184, deel 2), met een echte (tijdelijke) map. De app kijkt alleen na
 * aanzetten, alleen in die map, opent alleen bestanden met de afgesproken extensies, zet niets vanzelf
 * in de boeken en verandert niets in de map.
 */
const OWN = 'NL91ABNA0417164300';
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function camt(iban: string, entries: { ref: string; date: string; amount: number; name: string }[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt><Id>1</Id><Acct><Id><IBAN>${iban}</IBAN></Id></Acct>
    ${entries.map((e) => `<Ntry><Amt Ccy="EUR">${Math.abs(e.amount).toFixed(2)}</Amt><CdtDbtInd>${e.amount < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>${e.date}</Dt></BookgDt><AcctSvcrRef>${e.ref}</AcctSvcrRef>
      <NtryDtls><TxDtls><RltdPties><Cdtr><Nm>${e.name}</Nm></Cdtr></RltdPties><RmtInf><Ustrd>betaling ${e.name}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`).join('')}
  </Stmt></BkToCstmrStmt></Document>`;
}
const SEPTEMBER = camt(OWN, [{ ref: 'S1', date: '2026-09-01', amount: -15, name: 'KPN' }, { ref: 'S2', date: '2026-09-29', amount: -65, name: 'Shell' }]);

/** Het tijdstip van "nu" in de test; bestanden zijn een minuut eerder klaar met downloaden. */
const NOW = new Date('2026-10-01T10:00:00Z');
const TODAY = '2026-10-01';

function start(opts: { enable?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bvn-downloads-'));
  dirs.push(dir);
  // telt hoe vaak de app een bestand opent: niet vaker dan nodig, en nooit de verkeerde
  const opened: string[] = [];
  const files: FolderAccess = { ...folderAccess, read: (d, name, max) => (opened.push(name), folderAccess.read(d, name, max)) };
  const ctx = setup({ statementFiles: files });
  ctx.s.bank.updateAccount(ctx.s.bank.listAccounts()[0]!.id, { name: 'Knab zakelijk', iban: OWN });
  ctx.s.settings.update({ onboardingDone: true });
  const put = (name: string, content: string | Buffer, minutesAgo = 1) => {
    writeFileSync(join(dir, name), content);
    const t = new Date(NOW.getTime() - minutesAgo * 60_000);
    utimesSync(join(dir, name), t, t);
  };
  // de wijzigingstijd die we zetten telt: ctime is in de test altijd "nu"
  const access: FolderAccess = { ...files, list: (d) => files.list(d).map((f) => ({ ...f, changedMs: f.mtimeMs })) };
  const s = setup({ db: ctx.db, statementFiles: access }).s;
  if (opts.enable !== false) s.statementFolder.enable(dir, NOW);
  const questions = (asOf = TODAY) => s.inbox.tasks(asOf).filter((t) => t.kind === 'bank-statement');
  const rows = () => ctx.db.prepare('SELECT status, filename, present FROM statement_files ORDER BY id').all() as { status: string; filename: string | null; present: number }[];
  return { ...ctx, s, dir, put, opened, questions, rows, scan: (now = NOW) => s.statementFolder.scan(now) };
}

function api(s: ReturnType<typeof setup>['s'], dir: string) {
  return createApi(s, { appVersion: () => 'test', statementFolder: { defaultPath: () => dir, choose: async () => null, reconfigure: () => {} } } as unknown as HostContext);
}

describe('de map zelf: alleen lezen, alleen gewone bestanden direct in de map', () => {
  it('geen submappen en geen snelkoppelingen; lezen buiten de map of van een te groot bestand wordt geweigerd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bvn-map-'));
    const outside = mkdtempSync(join(tmpdir(), 'bvn-buiten-'));
    dirs.push(dir, outside);
    writeFileSync(join(dir, 'afschrift.csv'), 'a;b');
    writeFileSync(join(outside, 'geheim.csv'), 'geheim');
    mkdirSync(join(dir, 'submap'));
    writeFileSync(join(dir, 'submap', 'diep.csv'), 'x');
    symlinkSync(join(outside, 'geheim.csv'), join(dir, 'link.csv'));
    expect(folderAccess.list(dir).map((f) => f.name)).toEqual(['afschrift.csv']);
    expect(folderAccess.read(dir, 'afschrift.csv', 100).toString()).toBe('a;b');
    for (const name of ['../' + outside.split('/').pop() + '/geheim.csv', join(outside, 'geheim.csv'), 'submap/diep.csv', 'link.csv', 'submap', '']) {
      expect(() => folderAccess.read(dir, name, 100), name).toThrow();
    }
    expect(() => folderAccess.read(dir, 'afschrift.csv', 2)).toThrow('te groot');
    expect(folderAccess.isDirectory(dir)).toBe(true);
    expect(folderAccess.isDirectory(join(dir, 'afschrift.csv'))).toBe(false);
    expect(folderAccess.isDirectory('relatief')).toBe(false);
  });
});

describe('afschriften uit de downloadmap', () => {
  it('staat standaard uit: de app kijkt nergens en vraagt niets', async () => {
    const t = start({ enable: false });
    t.put('afschrift.xml', SEPTEMBER);
    expect(t.s.statementFolder.config()).toEqual({ enabled: false, path: '', since: null });
    expect(await t.scan()).toEqual({ found: 0, waiting: false });
    expect(t.opened).toEqual([]);
    expect(t.rows()).toEqual([]);
    expect(t.questions()).toEqual([]);
  });

  it('aanzetten kan alleen voor een bestaande map, en kijkt 14 dagen terug', async () => {
    const t = start({ enable: false });
    expect(() => t.s.statementFolder.enable(join(t.dir, 'bestaat-niet'), NOW)).toThrow('bestaat niet');
    expect(t.s.statementFolder.config().enabled).toBe(false);
    t.put('nieuw.xml', SEPTEMBER, 60);
    t.put('oud.xml', camt(OWN, [{ ref: 'O1', date: '2026-08-01', amount: -10, name: 'Oud' }]), (LOOK_BACK_DAYS + 1) * 24 * 60);
    expect(t.s.statementFolder.enable(t.dir, NOW)).toEqual({ enabled: true, path: t.dir, since: '2026-09-17T10:00:00.000Z' });
    expect(await t.scan()).toEqual({ found: 1, waiting: false });
    // het oude bestand is niet eens geopend
    expect(t.opened).toEqual(['nieuw.xml']);
  });

  it('herkent CAMT, MT940 en een CSV van een bekende bank van een rekening in de administratie', async () => {
    const t = start();
    t.put('camt.xml', SEPTEMBER);
    t.put('mt940.sta', fixture('statement.sta'));
    t.put('ing.csv', fixture('ing.csv'));
    expect(await t.scan()).toEqual({ found: 3, waiting: false });
    expect(t.questions().map((q) => [q.title, q.question])).toEqual([
      ['Nieuw afschrift gevonden: Knab zakelijk, 1 september 2026 t/m 29 september 2026', 'camt.xml staat in je downloadmap, met 2 betalingen. Inlezen?'],
      ['Nieuw afschrift gevonden: Knab zakelijk, 1 september 2026 t/m 2 september 2026', 'mt940.sta staat in je downloadmap, met 2 betalingen. Inlezen?'],
      ['Nieuw afschrift gevonden: Knab zakelijk, 15 september 2026 t/m 16 september 2026', 'ing.csv staat in je downloadmap, met 3 betalingen. Inlezen?'],
    ]);
    expect(t.questions()[0]!.actions.map((a) => a.label)).toEqual(['Inlezen', 'Niet nu']);
    // niets ging vanzelf de boeken in
    expect(t.s.bank.list()).toEqual([]);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM import_batches').get()).toEqual({ n: 0 });
  });

  it('negeert zonder melding: vreemd bestand, andere IBAN, onbekende CSV, andere extensie, te groot, leeg, nog aan het downloaden', async () => {
    const t = start();
    t.put('notities.txt', 'boodschappen: melk, brood');
    t.put('factuur.xml', fixture('ubl-invoice.xml'));
    t.put('ander.xml', camt('NL20INGB0001234567', [{ ref: 'A1', date: '2026-09-05', amount: -10, name: 'Iemand' }]));
    t.put('klanten.csv', 'naam;datum;bedrag\nJan;01-09-2026;12,50\n');
    t.put('afschrift.pdf', SEPTEMBER);
    t.put('afschrift.xml.crdownload', SEPTEMBER);
    t.put('afschrift.xml.part', SEPTEMBER);
    t.put('leeg.csv', '');
    expect(await t.scan()).toEqual({ found: 0, waiting: false });
    expect(t.questions()).toEqual([]);
    // alleen bestanden met een van de extensies zijn geopend
    expect(t.opened.sort()).toEqual(['ander.xml', 'factuur.xml', 'klanten.csv', 'notities.txt']);
    // en van die bestanden is alleen onthouden dát ze bekeken zijn: geen naam, geen inhoud
    expect(t.rows()).toEqual(Array(4).fill({ status: 'geen', filename: null, present: 1 }));
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM statement_files WHERE content_hash IS NOT NULL OR accounts IS NOT NULL').get()).toEqual({ n: 0 });

    // te groot: wordt niet geopend
    const big: FolderAccess = { ...folderAccess, list: () => [{ name: 'groot.xml', size: MAX_STATEMENT_BYTES, mtimeMs: NOW.getTime() - 60_000, changedMs: NOW.getTime() - 60_000 }], read: () => { throw new Error('mag niet geopend worden'); } };
    const other = setup({ statementFiles: big });
    other.s.statementFolder.enable(t.dir, NOW);
    expect(await other.s.statementFolder.scan(NOW)).toEqual({ found: 0, waiting: false });
    expect(other.db.prepare('SELECT COUNT(*) AS n FROM statement_files').get()).toEqual({ n: 0 });
  });

  it('een CSV met kolommen die de gebruiker eerder aanwees telt mee; Revolut alleen als die rekening er al is', async () => {
    const t = start();
    const custom = `boekdatum;eigen rekening;bedrag;omschrijving\n02-09-2026;${OWN};-12,50;Koffie\n`;
    t.put('eigen.csv', custom);
    t.put('revolut.csv', fixture('revolut.csv'));
    expect(await t.scan()).toEqual({ found: 0, waiting: false });
    // de gebruiker wijst de kolommen één keer aan (door het bestand in de app te slepen) en maakt een rekening Revolut
    const a = api(t.s, t.dir);
    await a.bank.importFile('eerder.csv', custom.replace('Koffie', 'Thee'), { date: 'boekdatum', amount: 'bedrag', ownIban: 'eigen rekening', description: ['omschrijving'], dateFormat: 'DD-MM-YYYY' });
    t.s.bank.addAccount('Revolut', null, { pot: false });
    t.put('eigen-2.csv', custom, 2);
    t.put('revolut-2.csv', fixture('revolut.csv'), 2);
    expect(await t.scan()).toEqual({ found: 2, waiting: false });
    expect(t.questions().map((q) => q.title)).toEqual(['Nieuw afschrift gevonden: Revolut, 2 januari 2026 t/m 5 januari 2026', 'Nieuw afschrift gevonden: Knab zakelijk, 2 september 2026']);
  });

  it('wat al bekeken is, leest de app niet opnieuw; de vraag komt één keer', async () => {
    const t = start();
    t.put('afschrift.xml', SEPTEMBER);
    t.put('notities.txt', 'niets');
    expect(await t.scan()).toEqual({ found: 1, waiting: false });
    expect(t.opened).toHaveLength(2);
    for (let i = 0; i < 3; i++) expect(await t.scan(new Date(NOW.getTime() + i * 300_000))).toEqual({ found: 0, waiting: false });
    expect(t.opened).toHaveLength(2);
    expect(t.questions()).toHaveLength(1);
    // twee keer tegelijk kijken (nieuw bestand én de controle van elke paar minuten) is één keer kijken
    t.put('tweede.xml', camt(OWN, [{ ref: 'T1', date: '2026-09-30', amount: -5, name: 'Bakker' }]));
    const [a, b] = await Promise.all([t.scan(), t.scan()]);
    expect(a).toBe(b);
    expect(t.questions()).toHaveLength(2);
    // een bestand dat opnieuw gedownload is (zelfde naam, andere inhoud) is een nieuw bestand
    t.put('notities.txt', SEPTEMBER.replace('S2', 'S9'), 0.5);
    expect(await t.scan()).toEqual({ found: 1, waiting: false });
  });

  it('een bestand dat nog aan het downloaden is, wacht tot het klaar is', async () => {
    const t = start();
    t.put('afschrift.xml', SEPTEMBER.slice(0, 300), 0);
    // net geschreven: nog niet openen
    expect(await t.scan(new Date(NOW.getTime() + 1000))).toEqual({ found: 0, waiting: true });
    expect(t.opened).toEqual([]);
    expect(t.rows()).toEqual([]);
    // de download is klaar
    t.put('afschrift.xml', SEPTEMBER, 0);
    expect(await t.scan(new Date(NOW.getTime() + 2000))).toEqual({ found: 0, waiting: true });
    expect(await t.scan(new Date(NOW.getTime() + 60_000))).toEqual({ found: 1, waiting: false });
    expect(t.questions()).toHaveLength(1);
  });

  it('een half bestand dat toch geopend is, telt niet voor het hele bestand dat erna komt', async () => {
    const t = start();
    t.put('afschrift.xml', SEPTEMBER.slice(0, 300), 3);
    expect(await t.scan()).toEqual({ found: 0, waiting: false });
    expect(t.rows()).toEqual([{ status: 'geen', filename: null, present: 1 }]);
    t.put('afschrift.xml', SEPTEMBER, 1);
    expect(await t.scan()).toEqual({ found: 1, waiting: false });
    // het halve bestand is vergeten
    expect(t.rows()).toEqual([{ status: 'gevonden', filename: 'afschrift.xml', present: 1 }]);
  });

  it('hetzelfde afschrift onder een andere naam: één vraag', async () => {
    const t = start();
    t.put('afschrift.xml', SEPTEMBER, 5);
    t.put('afschrift (1).xml', SEPTEMBER, 2);
    expect(await t.scan()).toEqual({ found: 1, waiting: false });
    expect(t.questions()).toHaveLength(1);
    expect(t.rows().map((r) => r.status).sort()).toEqual(['dubbel', 'gevonden']);
    // het origineel gaat weg: de vraag gaat verder over de kopie, nog steeds één keer
    rmSync(join(t.dir, 'afschrift.xml'));
    await t.scan();
    expect(t.questions().map((q) => q.question)).toEqual(['afschrift (1).xml staat in je downloadmap, met 2 betalingen. Inlezen?']);
    // en na het inlezen vraagt een nieuwe kopie niets meer
    await api(t.s, t.dir).home.act(t.questions()[0]!, 'inlezen');
    t.put('afschrift (2).xml', SEPTEMBER, 2);
    expect(await t.scan()).toEqual({ found: 0, waiting: false });
    expect(t.questions()).toEqual([]);
    expect(t.s.bank.list()).toHaveLength(2);
  });

  it('Niet nu: morgen opnieuw, na drie keer niet meer voor dat bestand', async () => {
    const t = start();
    t.put('afschrift.xml', SEPTEMBER);
    await t.scan();
    const [q] = t.questions();
    const a = api(t.s, t.dir);
    // de knop op Vandaag rekent met de datum van vandaag: de vraag komt morgen terug
    await a.home.act(q!, 'niet-nu');
    expect(t.questions(today())).toEqual([]);
    expect(t.questions(addDays(today(), 1))).toHaveLength(1);
    await a.home.act(q!, 'niet-nu');
    t.s.statementFolder.notNow(q!.ref.statementId!, '2026-10-03');
    expect(t.rows()).toEqual([{ status: 'afgewezen', filename: 'afschrift.xml', present: 1 }]);
    expect(t.questions('2026-12-31')).toEqual([]);
    // ook opnieuw kijken brengt de vraag niet terug; het bestand staat er nog
    await t.scan(new Date('2026-10-04T10:00:00Z'));
    expect(t.questions('2026-12-31')).toEqual([]);
    expect(readdirSync(t.dir)).toEqual(['afschrift.xml']);
    expect(t.s.bank.list()).toEqual([]);
  });

  it('Inlezen gaat via dezelfde route als slepen, en laat het bestand staan zoals het was', async () => {
    const t = start();
    t.put('afschrift.xml', SEPTEMBER);
    const before = statSync(join(t.dir, 'afschrift.xml'));
    await t.scan();
    const a = api(t.s, t.dir);
    const [q] = t.questions();
    const r = (await a.home.act(q!, 'inlezen')) as unknown as { navigate: { screen: string; extra: { imported: { imported: number; duplicates: number; batchId: number } } } };
    expect(r.navigate).toMatchObject({ screen: 'bank', extra: { imported: { imported: 2, duplicates: 0 } } });
    expect(t.s.bank.list().map((x) => [x.transaction_date, x.amount, x.source, x.bank_id])).toEqual([['2026-09-29', -6500, 'camt', 'S2'], ['2026-09-01', -1500, 'camt', 'S1']]);
    expect(t.db.prepare('SELECT filename, source FROM import_batches').all()).toEqual([{ filename: 'afschrift.xml', source: 'camt' }]);
    expect(t.questions()).toEqual([]);
    expect(t.rows()).toEqual([{ status: 'ingelezen', filename: 'afschrift.xml', present: 1 }]);
    // het bestand is niet verplaatst, gewijzigd of weggehaald
    const after = statSync(join(t.dir, 'afschrift.xml'));
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
    expect(readFileSync(join(t.dir, 'afschrift.xml'), 'utf8')).toBe(SEPTEMBER);
    // nog een keer kijken of klikken: geen tweede keer
    await t.scan(new Date(NOW.getTime() + 600_000));
    expect(t.questions()).toEqual([]);
    await expect(a.home.act(q!, 'inlezen')).rejects.toThrow('al ingelezen');
    expect(t.s.bank.list()).toHaveLength(2);
  });

  it('de regel uit deel 1 geldt ook hier: een afschrift van een ander soort over dezelfde dagen geeft niets dubbel', async () => {
    const t = start();
    t.s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-01', amount: -1500, description: 'KPN', ownIban: OWN }, { date: '2026-09-29', amount: -6500, description: 'Shell', ownIban: OWN }] });
    t.put('afschrift.xml', SEPTEMBER);
    await t.scan();
    const r = (await api(t.s, t.dir).home.act(t.questions()[0]!, 'inlezen')) as unknown as { navigate: { extra: { imported: { imported: number; skipped: number } } } };
    expect(r.navigate.extra.imported).toMatchObject({ imported: 0, skipped: 2 });
    expect(t.s.bank.list()).toHaveLength(2);
  });

  it('al ingelezen door het in de app te slepen: de app vraagt er niet (meer) naar', async () => {
    const t = start();
    const a = api(t.s, t.dir);
    // eerst gevonden, dan gesleept: de vraag vervalt
    t.put('afschrift.xml', SEPTEMBER);
    await t.scan();
    expect(t.questions()).toHaveLength(1);
    await a.bank.importFile('afschrift.xml', SEPTEMBER);
    expect(t.questions()).toEqual([]);
    // eerst gesleept, dan pas in de map gezien: geen vraag
    const october = camt(OWN, [{ ref: 'X1', date: '2026-09-30', amount: -20, name: 'Gamma' }]);
    await a.bank.importFile('oktober.xml', october);
    t.put('oktober.xml', october);
    expect(await t.scan()).toEqual({ found: 0, waiting: false });
    expect(t.questions()).toEqual([]);
    expect(t.rows().map((r) => r.status)).toEqual(['ingelezen', 'ingelezen']);
  });

  it('een bestand dat uit de map is gehaald: de vraag vervalt, en Inlezen op een oude vraag geeft een duidelijke melding', async () => {
    const t = start();
    t.put('afschrift.xml', SEPTEMBER);
    t.put('notities.txt', 'niets');
    await t.scan();
    const [q] = t.questions();
    rmSync(join(t.dir, 'afschrift.xml'));
    rmSync(join(t.dir, 'notities.txt'));
    await expect(api(t.s, t.dir).home.act(q!, 'inlezen')).rejects.toThrow('Dit bestand staat niet meer in de map');
    expect(t.questions()).toEqual([]);
    await t.scan();
    // van het andere bestand is ook de hash vergeten
    expect(t.rows()).toEqual([{ status: 'gevonden', filename: 'afschrift.xml', present: 0 }]);
    expect(t.s.bank.list()).toEqual([]);
  });

  it('uitzetten: geen vragen meer en niet meer kijken; de map blijft onthouden', async () => {
    const t = start();
    t.put('afschrift.xml', SEPTEMBER);
    await t.scan();
    expect(t.questions()).toHaveLength(1);
    t.s.statementFolder.disable();
    expect(t.s.statementFolder.config()).toEqual({ enabled: false, path: t.dir, since: null });
    expect(t.questions()).toEqual([]);
    t.put('tweede.xml', camt(OWN, [{ ref: 'T1', date: '2026-09-30', amount: -5, name: 'Bakker' }]));
    const opened = t.opened.length;
    expect(await t.scan()).toEqual({ found: 0, waiting: false });
    expect(t.opened).toHaveLength(opened);
  });

  it('de app verandert niets in de map, wat hij ook doet', async () => {
    const t = start();
    t.put('afschrift.xml', SEPTEMBER);
    t.put('ing.csv', fixture('ing.csv'));
    t.put('notities.txt', 'niets');
    const snapshot = () => readdirSync(t.dir).sort().map((n) => [n, statSync(join(t.dir, n)).size, statSync(join(t.dir, n)).mtimeMs, readFileSync(join(t.dir, n), 'hex')]);
    const before = snapshot();
    await t.scan();
    const a = api(t.s, t.dir);
    const [first, second] = t.questions();
    await a.home.act(first!, 'inlezen');
    await a.home.act(second!, 'niet-nu');
    await t.scan(new Date(NOW.getTime() + 600_000));
    t.s.statementFolder.disable();
    expect(snapshot()).toEqual(before);
  });

  it('in de kopie bij de boekhouder kijkt de app nergens, en de instelling gaat niet mee', async () => {
    const t = start();
    t.put('afschrift.xml', SEPTEMBER);
    await t.scan();
    expect(t.rows()).toHaveLength(1);
    const copy = new Database(':memory:');
    copy.exec(`CREATE TABLE secrets (k); CREATE TABLE bank_feed_accounts (id); CREATE TABLE integrations (enabled, config); CREATE TABLE settings (key, value); CREATE TABLE statement_files (id);
      CREATE TABLE scanner_devices (id); CREATE TABLE scanner_nonces (id); CREATE TABLE scanner_documents (id);
      INSERT INTO settings VALUES ('statementFolder', '{"enabled":true,"path":"/home/piet/Downloads"}'), ('company', '{}'); INSERT INTO statement_files VALUES (1);`);
    sanitizeForExchange(copy);
    expect(copy.prepare('SELECT key FROM settings').all()).toEqual([{ key: 'company' }]);
    expect(copy.prepare('SELECT COUNT(*) AS n FROM statement_files').get()).toEqual({ n: 0 });
    // en een kopie waar de instelling toch in staat, doet er niets mee
    t.s.settings.markOfficeCopy({ office: 'Kantoor', exchange: 1 } as never);
    t.put('tweede.xml', camt(OWN, [{ ref: 'T1', date: '2026-09-30', amount: -5, name: 'Bakker' }]));
    const opened = t.opened.length;
    expect(await t.scan()).toEqual({ found: 0, waiting: false });
    expect(t.opened).toHaveLength(opened);
    expect(t.s.statementFolder.pending(TODAY)).toEqual([]);
    expect(() => t.s.statementFolder.enable(t.dir)).toThrow('kopie van een klant');
  });
});

describe('aan- en uitzetten vanuit het scherm', () => {
  it('alleen de Downloads-map of een map die de gebruiker net zelf koos; aanzetten kijkt meteen', async () => {
    const t = start({ enable: false });
    t.put('afschrift.xml', SEPTEMBER);
    const chosen = mkdtempSync(join(tmpdir(), 'bvn-gekozen-'));
    dirs.push(chosen);
    let reconfigured = 0;
    const a = createApi(t.s, { appVersion: () => 'test', statementFolder: { defaultPath: () => t.dir, choose: async () => chosen, reconfigure: () => reconfigured++ } } as unknown as HostContext);
    expect(a.bank.statementFolder()).toEqual({ available: true, enabled: false, path: t.dir, defaultPath: t.dir });
    await expect(a.bank.setStatementFolder(true, tmpdir())).rejects.toThrow('Andere map kiezen');
    expect(t.s.statementFolder.config().enabled).toBe(false);
    // de datum van het bestand ligt in de test in het verleden: het telt als "van de afgelopen 14 dagen"
    writeFileSync(join(t.dir, 'afschrift.xml'), SEPTEMBER);
    utimesSync(join(t.dir, 'afschrift.xml'), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    expect(await a.bank.setStatementFolder(true, t.dir)).toMatchObject({ enabled: true, path: t.dir, found: 1 });
    expect(reconfigured).toBe(1);
    expect(await a.bank.chooseStatementFolder()).toBe(chosen);
    expect(await a.bank.setStatementFolder(true, chosen)).toMatchObject({ enabled: true, path: chosen, found: 0 });
    expect(await a.bank.setStatementFolder(false)).toMatchObject({ enabled: false, path: chosen });
    expect(reconfigured).toBe(3);
  });

  it('zonder toegang tot mappen (buiten de app zelf) is de functie er niet', async () => {
    const { s } = setup();
    const a = createApi(s, { appVersion: () => 'test' } as unknown as HostContext);
    expect(a.bank.statementFolder()).toMatchObject({ available: false, enabled: false });
    await expect(a.bank.setStatementFolder(true, tmpdir())).rejects.toThrow('alleen in de app zelf');
    expect(() => s.statementFolder.enable(tmpdir())).toThrow('alleen in de app zelf');
    expect(await s.statementFolder.scan()).toEqual({ found: 0, waiting: false });
  });
});

describe('de vraag "download een nieuw afschrift"', () => {
  it('herkent de bank aan het rekeningnummer', () => {
    expect([OWN, 'NL20INGB0001234567', 'NL44RABO0123456789', 'NL52KNAB0775908274', 'NL12 BUNQ 0123 4567 89', 'NL39TRIO0123456789', 'NL21REVO0123456789'].map(bankOfIban)).toEqual(['ABN AMRO', 'ING', 'Rabobank', 'Knab', 'bunq', 'Triodos', 'Revolut']);
    expect([null, '', 'DE89370400440532013000', 'NL00XXXX0123456789'].map(bankOfIban)).toEqual([null, null, null, null]);
    // zolang de uitleg per bank niet is nagelopen: de algemene uitleg
    expect(statementHelp(OWN)).toBe(GENERAL_STATEMENT_HELP);
  });

  it('zegt welk soort afschrift, en dat de app het zelf ziet als de downloadmap aanstaat', () => {
    const t = start({ enable: false });
    const stale = (): Task => t.s.inbox.tasks(TODAY).find((x) => x.kind === 'bank-stale')!;
    expect(stale().question).toBe(`Lees een afschrift in, dan koppelen we betalingen automatisch aan je facturen en bonnetjes. ${GENERAL_STATEMENT_HELP}`);
    t.s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-01', amount: -1500, description: 'KPN', ownIban: OWN }] });
    expect(stale().question).toBe(`Dat is 30 dagen geleden. Download een nieuw afschrift bij je bank en sleep het in de app. Dan zoeken we uit wat bij welke factuur hoort. ${GENERAL_STATEMENT_HELP}`);
    t.s.statementFolder.enable(t.dir, NOW);
    expect(stale().question).toContain('Download een nieuw afschrift bij je bank: de app ziet het in je downloadmap en vraagt of hij het mag inlezen.');
  });
});

describe('op de map letten', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('kijkt bij het starten, bij een nieuw bestand en met vaste tussenpozen; uit = niets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bvn-letten-'));
    dirs.push(dir);
    let folder: string | null = dir;
    let scans = 0;
    const found: number[] = [];
    const watch = new StatementWatch({ folder: () => folder, scan: async () => ({ found: ++scans === 2 ? 1 : 0, waiting: false }), onFound: (n) => found.push(n), settleMs: 30, intervalMs: 100_000 });
    try {
      watch.start();
      await wait(150);
      expect(scans, 'bij het starten').toBe(1);
      writeFileSync(join(dir, 'afschrift.xml'), 'x');
      await wait(300);
      expect(scans, 'na een nieuw bestand').toBe(2);
      expect(found).toEqual([1]);
      // uitgezet: geen map, dus nergens op letten
      folder = null;
      watch.start();
      writeFileSync(join(dir, 'tweede.xml'), 'x');
      await wait(300);
      expect(scans).toBe(2);
    } finally {
      watch.stop();
    }
  });

  it('een map die niet (meer) bestaat of een fout bij het kijken houdt de app niet tegen', async () => {
    let scans = 0;
    const watch = new StatementWatch({ folder: () => join(tmpdir(), 'bvn-bestaat-niet-184'), scan: async () => { scans++; throw new Error('database dicht'); }, onFound: () => {}, settleMs: 20, intervalMs: 60 });
    try {
      expect(() => watch.start()).not.toThrow();
      await wait(250);
      // fs.watch lukt niet, de controle met vaste tussenpozen blijft over
      expect(scans).toBeGreaterThanOrEqual(2);
    } finally {
      watch.stop();
    }
  });
});
