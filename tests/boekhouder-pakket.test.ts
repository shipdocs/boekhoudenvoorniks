import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { createZip } from '../src/shared/zip';
import { createXlsx } from '../src/shared/xlsx';
import { readXlsx } from '../src/import/xlsx';

/** Leest een ZIP terug via de centrale directory (onafhankelijk van de schrijver). */
function unzip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThan(0);
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(dataStart, dataStart + size);
    out.set(name, method === 8 ? inflateRawSync(body) : Buffer.from(body));
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

const csv = (b: Buffer) => b.toString('utf8').replace(/^﻿/, '').trim().split('\r\n').map((l) => l.split(';'));
const cents = (s: string | undefined) => (s ? Math.round(Number(s.replace(',', '.')) * 100) : 0);

/** Twee jaar: 2025 met winst en een open factuur, 2026 met factuur, inkoop (met en zonder bon) en bank. */
function scenario() {
  const { s, klant } = setup();
  const v2025 = s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2025-11-10', lines: [{ description: 'Stucwerk', quantity: 1, unitPrice: 50000, vatCode: 'hoog' }] }).id);
  const inv = s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-02-10', lines: [{ description: 'Plafond', quantity: 1, unitPrice: 100000, vatCode: 'hoog' }] }).id);
  s.invoices.registerPayment(inv.id, { amount: 121000, date: '2026-03-05' });
  s.invoices.registerPayment(v2025.id, { amount: 30000, date: '2026-01-15' }); // deels betaald: 30.500 blijft open
  const gamma = s.relations.findOrCreateSupplier('Gamma');
  s.purchases.create({ relationId: gamma.id, supplierReference: 'G-778', invoiceDate: '2026-04-02', description: 'Materiaal', lines: [{ account: 'WKprInkMat', netAmount: 20000, vatCode: 'hoog' }], attachmentPath: '/bijlagen/gamma.pdf' });
  const kpn = s.relations.findOrCreateSupplier('KPN');
  s.purchases.create({ relationId: kpn.id, invoiceDate: '2026-05-01', description: 'Telefoon', lines: [{ account: 'WBedKanTel', netAmount: 3000, vatCode: 'hoog' }] });
  const files = new Map([['/bijlagen/gamma.pdf', Buffer.from('%PDF-1.4 gamma')]]);
  return { s, klant, readAttachment: (p: string) => files.get(p) ?? null };
}

describe('zip', () => {
  it('schrijft een geldig archief met UTF-8-namen', () => {
    const zip = createZip([{ path: 'lees-mij.txt', data: 'hallo'.repeat(100) }, { path: 'documenten/café.pdf', data: Buffer.from([1, 2, 3]) }]);
    const files = unzip(zip);
    expect(files.get('lees-mij.txt')!.toString()).toBe('hallo'.repeat(100));
    expect([...files.get('documenten/café.pdf')!]).toEqual([1, 2, 3]);
    expect(() => createZip([{ path: '../x', data: '' }])).toThrow();
  });

  const hasUnzip = spawnSync('unzip', ['-v']).status === 0;
  it.skipIf(!hasUnzip)('het archief is leesbaar voor unzip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zip-'));
    writeFileSync(join(dir, 'a.zip'), createZip([{ path: 'map/bestand.csv', data: 'a;b\r\n' }, { path: 'Café De Hoek.pdf', data: 'x' }]));
    expect(execFileSync('unzip', ['-t', join(dir, 'a.zip')], { encoding: 'utf8' })).toMatch(/No errors/);
    // UTF-8-namen blijven leesbaar (niet als DOS-codetabel)
    expect(execFileSync('unzip', ['-l', join(dir, 'a.zip')], { encoding: 'utf8' })).toContain('Café De Hoek.pdf');
  });
});

describe('pakket voor mijn boekhouder', () => {
  it('bevat XAF, rapporten, brugstaat, documenten en lees-mij', async () => {
    const { s, readAttachment } = scenario();
    const r = await s.accountantPackage.build(2026, { softwareVersion: '9.9.9', readAttachment });
    const files = unzip(r.zip);
    for (const f of ['auditfile-2026-xaf32.xaf', 'rapporten-2026.xlsx', 'kolommenbalans.csv', 'grootboekkaarten.csv', 'journaalposten.csv', 'openstaande-debiteuren.csv', 'openstaande-crediteuren.csv', 'rgs-brugstaat.csv', 'btw-overzicht.csv', 'relaties.csv', 'documenten/index.csv', 'LEES-MIJ.pdf', 'lees-mij.txt']) {
      expect(files.has(f), f).toBe(true);
    }
    expect(r.filename).toBe('overdracht-boekhouder-stukadoorsbedrijf-piet-2026.zip');
    expect([...files.keys()][0]).toMatch(/lees-mij/i);
    // verkoopfactuur als PDF, inkoopbon als origineel bestand
    expect([...files.keys()].filter((f) => f.startsWith('documenten/verkoopfacturen/'))).toHaveLength(1);
    expect(files.get([...files.keys()].find((f) => f.startsWith('documenten/inkoop/'))!)!.toString()).toBe('%PDF-1.4 gamma');
    const readme = files.get('lees-mij.txt')!.toString();
    expect(readme).toMatch(/geen back-up/);
    expect(readme).toMatch(/XAF 3\.2/);
    expect(readme).toMatch(/Caseware/);
  });

  it('kolommenbalans sluit aan: beginbalans + mutaties = eindsaldo, en gelijk aan het grootboek', async () => {
    const { s, readAttachment } = scenario();
    const r = await s.accountantPackage.build(2026, { softwareVersion: '9.9.9', readAttachment });
    const rows = csv(unzip(r.zip).get('kolommenbalans.csv')!);
    const header = rows[0]!;
    const col = (n: string) => header.indexOf(n);
    const accounts = rows.slice(1).filter((x) => x[0]);
    for (const a of accounts) expect(cents(a[col('Beginbalans')]) + cents(a[col('Mutaties debet')]) - cents(a[col('Mutaties credit')])).toBe(cents(a[col('Eindsaldo')]));
    expect(accounts.reduce((t, a) => t + cents(a[col('Beginbalans')]), 0)).toBe(0);
    expect(accounts.reduce((t, a) => t + cents(a[col('Eindsaldo')]), 0)).toBe(0);
    // het resultaat van 2025 (500 omzet) zit in de beginbalans van het eigen vermogen, niet in de W&V van 2026
    const omzet = accounts.find((a) => a[col('RGS-code')]?.startsWith('WOmz'))!;
    expect(cents(omzet[col('Beginbalans')])).toBe(0);
    expect(cents(omzet[col('Eindsaldo')])).toBe(-100000);
    // debiteuren: 605 uit 2025 − 300 betaald = 305 open
    const deb = accounts.find((a) => a[col('Omschrijving')] === s.ledger.getAccount('BVorDebHad').name)!;
    expect(cents(deb[col('Beginbalans')])).toBe(60500);
    expect(cents(deb[col('Eindsaldo')])).toBe(30500);
    expect(r.summary.totals.result).toBe(100000 - 20000 - 3000);
    expect(r.summary.checks.filter((c) => !c.ok).map((c) => c.label)).toEqual(['Bij elke inkoop zit een bon of factuur', 'Btw-aangiftes van afgelopen periodes zijn ingediend']);
  });

  it('privé-opnamen en -stortingen van vorig jaar gaan naar het eigen vermogen; de privérekeningen beginnen bij nul', async () => {
    const { s, readAttachment } = scenario();
    const privé = (date: string, account: string, amount: number) =>
      s.ledger.post({ date, description: 'Privé', source: 'handmatig', lines: account === ACCOUNTS.priveOpnamen ? [{ account, debit: amount }, { account: ACCOUNTS.bank, credit: amount }] : [{ account: ACCOUNTS.bank, debit: amount }, { account, credit: amount }] });
    privé('2025-12-01', ACCOUNTS.priveOpnamen, 20000);
    privé('2025-12-15', ACCOUNTS.priveStortingen, 5000);
    privé('2026-06-01', ACCOUNTS.priveOpnamen, 7000);
    const opname = s.ledger.getAccount(ACCOUNTS.priveOpnamen).code;
    const storting = s.ledger.getAccount(ACCOUNTS.priveStortingen).code;
    const equity = s.ledger.getAccount(ACCOUNTS.eigenVermogen).code;

    const opening = new Map(s.exports.openingBalance('2026-01-01').map((o) => [o.code, o.amount]));
    expect(opening.has(opname)).toBe(false);
    expect(opening.has(storting)).toBe(false);
    // resultaat 2025 (500 omzet, credit) plus 200 opname (debet) min 50 storting (credit)
    expect(opening.get(equity)).toBe(-50000 + 20000 - 5000);
    expect([...opening.values()].reduce((t, a) => t + a, 0)).toBe(0);

    const r = await s.accountantPackage.build(2026, { softwareVersion: '9.9.9', readAttachment });
    const files = unzip(r.zip);
    const rows = csv(files.get('kolommenbalans.csv')!);
    const col = (n: string) => rows[0]!.indexOf(n);
    const row = (code: string) => rows.slice(1).find((x) => x[0] === code);
    // de opname van 2026 blijft als mutatie op de privérekening staan
    expect(cents(row(opname)![col('Beginbalans')])).toBe(0);
    expect(cents(row(opname)![col('Eindsaldo')])).toBe(7000);
    expect(row(storting)).toBeUndefined();

    const xaf = new XMLParser({ parseTagValue: false, isArray: (name) => ['obLine'].includes(name) }).parse(files.get('auditfile-2026-xaf32.xaf')!.toString());
    const obAccounts = xaf.auditfile.company.openingBalance.obLine.map((ob: { accID: string | number }) => String(ob.accID));
    expect(obAccounts).not.toContain(opname);
    expect(obAccounts).not.toContain(storting);
  });

  it('auditfile in het pakket: beginbalans + mutaties per rekening = eindsaldo in de kolommenbalans', async () => {
    const { s, readAttachment } = scenario();
    const r = await s.accountantPackage.build(2026, { softwareVersion: '9.9.9', readAttachment });
    const files = unzip(r.zip);
    const xaf = new XMLParser({ parseTagValue: false, isArray: (name) => ['obLine', 'journal', 'transaction', 'trLine'].includes(name) }).parse(files.get('auditfile-2026-xaf32.xaf')!.toString());
    const c = xaf.auditfile.company;
    const saldo = new Map<string, number>();
    const add = (acc: string | number, amnt: number | string, tp: string) => saldo.set(String(acc), (saldo.get(String(acc)) ?? 0) + Math.round(Number(amnt) * 100) * (tp === 'D' ? 1 : -1));
    for (const ob of c.openingBalance.obLine) add(ob.accID, ob.amnt, ob.amntTp);
    for (const j of c.transactions.journal) for (const t of j.transaction) for (const l of t.trLine) add(l.accID, l.amnt, l.amntTp);
    const rows = csv(files.get('kolommenbalans.csv')!).slice(1).filter((x) => x[0]);
    for (const row of rows) expect(saldo.get(row[0]!) ?? 0, row[1]).toBe(cents(row[8]));
    // en dezelfde boekstukken in journaalposten.csv
    const journal = csv(files.get('journaalposten.csv')!).slice(1);
    expect(journal).toHaveLength(Number(c.transactions.linesCount));
  });

  it('openstaande posten per factuur sluiten aan op debiteuren en crediteuren', async () => {
    const { s, readAttachment } = scenario();
    const r = await s.accountantPackage.build(2026, { softwareVersion: '9.9.9', readAttachment });
    const files = unzip(r.zip);
    const deb = csv(files.get('openstaande-debiteuren.csv')!);
    expect(deb.slice(1)).toHaveLength(1);
    expect(deb[1]![1]).toBe('Familie Jansen');
    expect(deb[1]![3]).toBe('2025-11-10');
    expect(cents(deb[1]![7])).toBe(30500);
    const cred = csv(files.get('openstaande-crediteuren.csv')!).slice(1);
    expect(cred.map((x) => x[2]).sort()).toEqual(['G-778', expect.stringMatching(/inkoop/)].sort());
    expect(cred.reduce((t, x) => t + cents(x[7]), 0)).toBe(24200 + 3630);
    expect(r.summary.openPayables).toBe(24200 + 3630);
  });

  it('documentindex koppelt bestanden aan boekstukken en noemt wat ontbreekt', async () => {
    const { s, readAttachment } = scenario();
    const r = await s.accountantPackage.build(2026, { softwareVersion: '9.9.9', readAttachment });
    const files = unzip(r.zip);
    const index = csv(files.get('documenten/index.csv')!);
    const gamma = index.find((x) => x[1] === 'Inkoopfactuur' && x[0])!;
    expect(gamma[2]).toBe('G-778');
    const entry = Number(gamma[6]);
    expect(entry).toBeGreaterThan(0);
    // hetzelfde boekstuk verwijst in het journaal naar het document
    const journal = csv(files.get('journaalposten.csv')!);
    expect(journal.filter((x) => Number(x[0]) === entry).every((x) => x[14] === `documenten/${gamma[0]}`)).toBe(true);
    const missing = index.filter((x) => x[7]?.startsWith('ONTBREEKT'));
    expect(missing).toHaveLength(1);
    expect(missing[0]![7]).toMatch(/Telefoon/);
  });

  it('rgs-brugstaat: elke gebruikte rekening gekoppeld aan een officiële RGS-code', async () => {
    const { s, readAttachment } = scenario();
    const r = await s.accountantPackage.build(2026, { softwareVersion: '9.9.9', readAttachment });
    const rows = csv(unzip(r.zip).get('rgs-brugstaat.csv')!);
    const used = rows.slice(1).filter((x) => x[7] === 'ja');
    expect(used.length).toBeGreaterThan(4);
    expect(used.every((x) => x[9] === 'gekoppeld' && x[5])).toBe(true);
    expect(r.summary.missingRgs).toEqual([]);
  });

  it('preview toont dezelfde controles zonder bestanden te maken', () => {
    const { s } = scenario();
    const p = s.accountantPackage.preview(2026, '9.9.9');
    expect(p.missingDocuments).toHaveLength(1);
    expect(p.totals.openingDebit).toBe(p.totals.openingCredit);
    expect(p.vat).toHaveLength(4);
    expect(() => s.accountantPackage.preview(1800)).toThrow();
  });

  it('zonder PDF-motor komt de lees-mij als HTML mee', async () => {
    const { s, readAttachment } = scenario();
    const pkg = new (s.accountantPackage.constructor as never as new (...a: unknown[]) => typeof s.accountantPackage)(
      s.db, s.ledger, s.exports, s.invoices, s.vat, s.settings, async () => { throw new Error('geen pdf'); },
    );
    const r = await pkg.build(2026, { softwareVersion: '9.9.9', readAttachment });
    const files = unzip(r.zip);
    expect(files.has('LEES-MIJ.html')).toBe(true);
    // en de verkoopfactuur staat als ontbrekend in de index
    expect(r.summary.missingDocuments.some((m) => m.kind === 'verkoop')).toBe(true);
  });

  const hasXmllint = spawnSync('xmllint', ['--version']).status !== null;
  it.skipIf(!hasXmllint)('de auditfile in het pakket valideert tegen het XAF 3.2-schema', async () => {
    const { s, readAttachment } = scenario();
    const r = await s.accountantPackage.build(2026, { softwareVersion: '9.9.9', readAttachment });
    const dir = mkdtempSync(join(tmpdir(), 'pakket-'));
    const file = join(dir, 'a.xaf');
    writeFileSync(file, unzip(r.zip).get('auditfile-2026-xaf32.xaf')!);
    execFileSync('xmllint', ['--noout', '--schema', join(__dirname, 'fixtures', 'XmlAuditfileFinancieel3.2.xsd'), file], { stdio: 'pipe' });
  });
});

describe('excel-werkmap', () => {
  it('één tabblad per overzicht, zelfde inhoud als de CSV', async () => {
    const { s, readAttachment } = scenario();
    const r = await s.accountantPackage.build(2026, { softwareVersion: '9.9.9', readAttachment });
    const files = unzip(r.zip);
    const wb = readXlsx(files.get('rapporten-2026.xlsx')!);
    expect(wb.sheets.map((x) => x.name)).toEqual(['Kolommenbalans', 'Grootboekkaarten', 'Journaalposten', 'Openstaande debiteuren', 'Openstaande crediteuren', 'RGS-brugstaat', 'Btw', 'Relaties']);
    const tb = wb.sheets[0]!.rows;
    const fromCsv = csv(files.get('kolommenbalans.csv')!);
    expect(tb[0]).toEqual(fromCsv[0]);
    expect(tb.length).toBe(fromCsv.length);
    // bedragen zijn getallen (geen tekst), zelfde waarde als in de CSV
    const deb = tb.findIndex((x) => x[1] === s.ledger.getAccount('BVorDebHad').name);
    expect(Math.round(Number(tb[deb]![8]) * 100)).toBe(cents(fromCsv[deb]![8]));
  });

  it('bijzondere tekens en lege cellen', () => {
    const buf = createXlsx([{ name: 'A/B: test', header: ['Naam', 'Bedrag', 'Datum'], rows: [['Café <&> "x"', { cents: -123456 }, '2026-02-28'], [null, 5, '']] }]);
    const wb = readXlsx(buf);
    expect(wb.sheets[0]!.name).toBe('A-B- test');
    expect(wb.sheets[0]!.rows[1]![0]).toBe('Café <&> "x"');
    expect(Number(wb.sheets[0]!.rows[1]![1])).toBe(-1234.56);
    // 28-02-2026 als Excel-datum
    expect(Number(wb.sheets[0]!.rows[1]![2])).toBe(46081);
  });

  const hasSoffice = spawnSync('soffice', ['--version']).status === 0;
  it.skipIf(!hasSoffice)('LibreOffice opent de werkmap (onafhankelijke controle)', async () => {
    const { s, readAttachment } = scenario();
    const r = await s.accountantPackage.build(2026, { softwareVersion: '9.9.9', readAttachment });
    const dir = mkdtempSync(join(tmpdir(), 'xlsx-'));
    writeFileSync(join(dir, 'r.xlsx'), unzip(r.zip).get('rapporten-2026.xlsx')!);
    execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profiel`, '--headless', '--convert-to', 'csv:Text - txt - csv (StarCalc):59,34,76,1,,1043', '--outdir', dir, join(dir, 'r.xlsx')], { stdio: 'pipe', timeout: 120_000 });
    const out = readFileSync(join(dir, 'r.csv'), 'utf8');
    expect(out).toContain('Rekening;Omschrijving;RGS-code');
    // bedragen als getal (notatie hangt af van de taalinstelling van LibreOffice)
    expect(out).toMatch(/;Debiteuren;BVorDebHad;.*;305[.,]00;305[.,]00;/);
  }, 150_000);
});

describe('importprofielen', () => {
  async function pkg() {
    const { s, readAttachment } = scenario();
    const r = await s.accountantPackage.build(2026, { softwareVersion: '9.9.9', readAttachment });
    const files = unzip(r.zip);
    const closing = new Map(csv(files.get('kolommenbalans.csv')!).slice(1).filter((x) => x[0]).map((x) => [x[0]!, cents(x[8])]));
    return { s, files, closing };
  }

  it('SnelStart: Fld-koppen, dd-mm-jjjj, elke boeking in evenwicht, beginbalans + boekingen = eindsaldo', async () => {
    const { files, closing } = await pkg();
    const sheet = readXlsx(files.get('importprofielen/snelstart/boekingen.xlsx')!).sheets[0]!.rows;
    expect(sheet[0]).toEqual(['FldDagboek', 'FldBoekingcode', 'FldDatum', 'FldGrootboeknummer', 'FldDebet', 'FldCredit', 'FldOmschrijving', 'FldBoekstuk']);
    const rows = sheet.slice(1);
    expect(rows.every((r) => /^\d{2}-\d{2}-\d{4}$/.test(r[2]!) && /^\d+$/.test(r[3]!) && /^\d+$/.test(r[0]!) && /^\d+$/.test(r[1]!))).toBe(true);
    const amt = (v: string | undefined) => Math.round(Number(v || 0) * 100);
    const perBoeking = new Map<string, number>();
    const perRekening = new Map<string, number>();
    for (const r of rows) {
      perBoeking.set(r[1]!, (perBoeking.get(r[1]!) ?? 0) + amt(r[4]) - amt(r[5]));
      perRekening.set(r[3]!, (perRekening.get(r[3]!) ?? 0) + amt(r[4]) - amt(r[5]));
    }
    expect([...perBoeking.values()].every((v) => v === 0)).toBe(true);
    for (const [code, c] of closing) expect(perRekening.get(code) ?? 0, code).toBe(c);
    // beginbalans als boeking op 1 januari
    expect(rows.some((r) => r[2] === '01-01-2026' && r[7] === 'BEGINBALANS')).toBe(true);
    const klanten = readXlsx(files.get('importprofielen/snelstart/klanten.xlsx')!).sheets[0]!.rows;
    expect(klanten[0]!.slice(0, 2)).toEqual(['FldRelatiecode', 'FldNaam']);
    expect(klanten.slice(1).map((r) => r[1])).toContain('Familie Jansen');
    const lev = readXlsx(files.get('importprofielen/snelstart/leveranciers.xlsx')!).sheets[0]!.rows;
    expect(lev.slice(1).map((r) => r[1])).toEqual(expect.arrayContaining(['Gamma', 'KPN']));
  });

  it('Yuki: 8 kolommen zonder kopregel; mutaties per rekening = mutaties in de kolommenbalans; 10 kolommen openstaande posten', async () => {
    const { files } = await pkg();
    const raw = files.get('importprofielen/yuki/historische-mutaties.csv')!.toString('utf8');
    expect(raw.charCodeAt(0)).not.toBe(0xfeff);
    const rows = raw.trim().split('\r\n').map((l) => l.split(';'));
    expect(rows.every((r) => r.length === 8 && /^\d{2}-\d{2}-\d{4}$/.test(r[2]!))).toBe(true);
    const tb = csv(files.get('kolommenbalans.csv')!).slice(1).filter((x) => x[0]);
    for (const a of tb) {
      const sum = rows.filter((r) => r[0] === a[0]).reduce((t, r) => t + cents(r[4]), 0);
      expect(sum, a[1]).toBe(cents(a[6]) - cents(a[7]));
    }
    const open = files.get('importprofielen/yuki/openstaande-posten.csv')!.toString('utf8').trim().split('\r\n').map((l) => l.split(';'));
    expect(open.every((r) => r.length === 10)).toBe(true);
    expect(open.map((r) => cents(r[3])).sort((a, b) => a - b)).toEqual([-24200, -3630, 30500]);
  });

  it('AFAS: saldibalans met cumulatief debet/credit zonder beginbalans en saldo met beginbalans', async () => {
    const { files, closing } = await pkg();
    const rows = csv(files.get('importprofielen/afas/saldibalans.csv')!);
    expect(rows[0]).toEqual(['Grootboekrekening', 'Cumulatief debet', 'Cumulatief credit', 'Saldo']);
    for (const r of rows.slice(1)) expect(cents(r[3])).toBe(closing.get(r[0]!));
    expect(files.get('importprofielen/LEES-MIJ.txt')!.toString()).toMatch(/FldDagboek staat op 90/);
  });
});
