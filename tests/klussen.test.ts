import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { makeJpegWithGps, readJpegGps, distanceMeters } from '../src/intake/exif';
import type { OcrProvider } from '../src/intake/ocr';

const items = (lines: string[]) => lines.map((text, i) => ({ text, page: 1, bbox: [10, 20 + i * 20, 300, 34 + i * 20] as [number, number, number, number], confidence: 0.97 }));
const ocrFor = (lines: string[]): OcrProvider => ({ id: 't', label: 'T', available: async () => true, recognize: async () => ({ items: items(lines) }) });

describe('klussen als dossier (#32)', () => {
  it('met één actieve klus is die het voorstel voor een nieuwe materiaalbon, ook als taak op Vandaag', () => {
    const { s, klant } = setup();
    s.settings.update({ onboardingDone: true });
    const job = s.jobs.create({ relationId: klant.id, title: 'Badkamer', startDate: '2026-09-01' });
    s.jobs.setStatus(job.id, 'bezig');
    const [best, ...rest] = s.jobs.suggest({ date: '2026-09-12', supplier: 'Gamma' });
    expect(best!.job.id).toBe(job.id);
    expect(rest).toHaveLength(0);
    const p = s.purchases.create({ invoiceDate: '2026-09-12', description: 'Tegellijm', lines: [{ account: ACCOUNTS.inkoopMaterialen, netAmount: 15207, vatCode: 'hoog' }] });
    const task = s.inbox.tasks('2026-09-15').find((t) => t.kind === 'job-link')!;
    expect(task.question).toBe('Was dit voor de klus bij Familie Jansen (Badkamer)?');
    expect(task.ref).toMatchObject({ purchaseId: p.id, jobId: job.id });
    s.inbox.skipTask(task.key, 'algemeen');
    expect(s.inbox.tasks('2026-09-15').some((t) => t.kind === 'job-link')).toBe(false);
  });

  it('het klusresultaat klopt met de onderliggende boekingen', () => {
    const { s, db, klant } = setup();
    const job = s.jobs.create({ relationId: klant.id, title: 'Badkamer' });
    s.purchases.create({ invoiceDate: '2026-09-02', description: 'Gips', jobId: job.id, lines: [{ account: ACCOUNTS.inkoopMaterialen, netAmount: 20000, vatCode: 'hoog' }] });
    const tegelzetter = s.purchases.create({ invoiceDate: '2026-09-03', description: 'Tegelzetter', lines: [{ account: ACCOUNTS.uitbesteedWerk, netAmount: 50000, vatCode: 'verlegd' }] });
    s.jobs.linkPurchase(tegelzetter.id, job.id);
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-04', amount: -12100, description: 'Pin', counterName: 'Praxis' }] });
    const t = s.bank.list({ status: 'nieuw' })[0]!;
    s.bank.bookToAccount(t.id, { account: ACCOUNTS.inkoopMaterialen, vatCode: 'hoog' });
    s.jobs.linkBankTransaction(t.id, job.id);
    s.purchases.create({ invoiceDate: '2026-09-05', description: 'Niet voor deze klus', lines: [{ account: ACCOUNTS.inkoopMaterialen, netAmount: 99900, vatCode: 'hoog' }] });
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-09-20', lines: [{ description: 'Badkamer', quantity: 1, unitPrice: 150000, vatCode: 'hoog' }] }).id);
    s.jobs.makeInvoice(job.id, [{ description: 'Badkamer', quantity: 1, unitPrice: 150000, vatCode: 'hoog' }]);
    const r = s.jobs.result(job.id);
    expect(r.invoiced).toBe(150000);
    expect(r.costs).toEqual([{ label: 'Materiaal', amount: 20000 + 10000 }, { label: 'Uitbesteed werk', amount: 50000 }]);
    expect(r.margin).toBe(150000 - 80000);
    expect(r.marginPct).toBe(46.7);
    // onafhankelijk nagerekend uit de journaalregels
    const fromLedger = (db.prepare(`SELECT SUM(l.debit) - SUM(l.credit) AS c FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN events ev ON ev.id = e.event_id JOIN chart_of_accounts a ON a.id = l.account_id WHERE ev.job_id = ? AND a.category = 'kosten'`).get(job.id) as { c: number }).c;
    expect(r.totalCosts).toBe(fromLedger);
    // een andere categorie kiezen (tegenboeking + nieuwe post) houdt de klus vast
    s.bank.reclassify(t.id, { account: 'WBedAlkGer', vatCode: 'hoog' }, 'was gereedschap');
    expect(s.jobs.result(job.id).costs).toEqual([{ label: 'Materiaal', amount: 20000 }, { label: 'Uitbesteed werk', amount: 50000 }, { label: 'Overige kosten', amount: 10000 }]);
    expect(s.jobs.results()[0]!.jobId).toBe(job.id);
  });

  it('werkbon vult de factuurregels', () => {
    const { s, klant } = setup();
    const job = s.jobs.create({ relationId: klant.id, title: 'Plafond' });
    s.jobs.addWorkItem(job.id, { date: '2026-09-10', description: 'Stucwerk plafond', quantity: 6, unit: 'uur', unitPrice: 4800, vatCode: 'laag' });
    s.jobs.addWorkItem(job.id, { date: '2026-09-10', description: 'Materiaal', quantity: 1, unitPrice: 8500, vatCode: 'hoog' });
    const inv = s.jobs.makeInvoice(job.id);
    expect(inv.lines.map((l) => [l.description, l.quantity, l.unit_price])).toEqual([['Stucwerk plafond (2026-09-10)', 6, 4800], ['Materiaal (2026-09-10)', 1, 8500]]);
    expect(s.jobs.workItems(job.id).every((w) => w.invoice_id === inv.id)).toBe(true);
    expect(() => s.jobs.removeWorkItem(s.jobs.workItems(job.id)[0]!.id)).toThrow(/al gefactureerd/);
  });

  it('locatie: standaard uit; na opt-in wordt een foto op de kluslocatie herkend', async () => {
    const photo = makeJpegWithGps(52.0907, 5.1214);
    expect(readJpegGps(photo)).toMatchObject({ lat: expect.closeTo(52.0907, 4), lon: expect.closeTo(5.1214, 4) });
    const lines = ['BOUWMAAT UTRECHT', 'Datum: 12-09-2026', 'Gips 100,00', 'BTW 21% 100,00 21,00', 'Totaal 121,00'];
    const { s, db, klant, aannemer } = setup({ ocr: ocrFor(lines) });
    const badkamer = s.jobs.create({ relationId: klant.id, title: 'Badkamer' });
    const keuken = s.jobs.create({ relationId: aannemer.id, title: 'Keuken' });
    // uit: geen locatie opgeslagen
    const d0 = await s.intake.add('a.jpg', photo, '2026-09-25');
    expect((db.prepare('SELECT gps_lat FROM documents WHERE id = ?').get(d0.id) as { gps_lat: number | null }).gps_lat).toBeNull();
    // aan: eerste bon aan de badkamer koppelen legt de kluslocatie vast
    s.settings.update({ jobLocation: true });
    const d1 = await s.intake.add('b.jpg', makeJpegWithGps(52.0908, 5.1215), '2026-09-25');
    s.intake.confirm(d1.id, { supplier: 'Bouwmaat', date: '2026-09-12', total: 12100, categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'kas', jobId: badkamer.id });
    expect(s.jobs.get(badkamer.id).lat).not.toBeNull();
    // volgende foto vlakbij → badkamer bovenaan, met de reden
    const gps = readJpegGps(makeJpegWithGps(52.0909, 5.1213))!;
    expect(distanceMeters(gps, { lat: 52.0908, lon: 5.1215 })).toBeLessThan(50);
    const [best] = s.jobs.suggest({ date: '2026-09-13', supplier: 'Bouwmaat', gps });
    expect(best!.job.id).toBe(badkamer.id);
    expect(best!.reason).toContain('kluslocatie');
    const far = s.jobs.suggest({ date: '2026-09-13', gps: { lat: 51.9, lon: 4.4 } });
    expect(far.find((x) => x.job.id === badkamer.id)!.reason).not.toContain('kluslocatie');
    void keuken;
  });

  it('review #43: werkbon na factureren dicht, geen negatieve prijs, concept verwijderen geeft regels vrij', () => {
    const { s, klant } = setup();
    const job = s.jobs.create({ relationId: klant.id, title: 'Plafond' });
    expect(() => s.jobs.addWorkItem(job.id, { date: '2026-09-10', description: 'Korting', quantity: 1, unitPrice: -500, vatCode: 'hoog' })).toThrow(/negatief/);
    s.jobs.addWorkItem(job.id, { date: '2026-09-10', description: 'Stucwerk', quantity: 2, unitPrice: 4800, vatCode: 'hoog' });
    const inv = s.jobs.makeInvoice(job.id);
    expect(s.jobs.get(job.id).status).toBe('gefactureerd');
    expect(() => s.jobs.addWorkItem(job.id, { date: '2026-09-11', description: 'Nog iets', quantity: 1, unitPrice: 100, vatCode: 'hoog' })).toThrow(/gefactureerd/);
    s.invoices.deleteDraft(inv.id);
    expect(s.jobs.workItems(job.id).every((w) => w.invoice_id === null)).toBe(true);
    expect(s.jobs.get(job.id).status).toBe('klaar');
    expect(() => s.jobs.linkPurchase(99999, job.id)).toThrow(/bestaat niet/);
    // zonder offerte of werkbon: een concept dat wél aan de klus hangt
    const leeg = s.jobs.create({ relationId: klant.id, title: 'Losse klus' });
    const inv2 = s.jobs.makeInvoice(leeg.id, [{ description: 'Losse klus', quantity: 1, unitPrice: 0, vatCode: 'hoog' }]);
    expect(s.jobs.get(leeg.id).invoices.map((i) => i.id)).toEqual([inv2.id]);
  });

  it('review #43: kapotte EXIF (segment van lengte 0) en onmogelijke GPS-waarden', () => {
    expect(readJpegGps(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x00, 0xff, 0xd9]))).toBeNull();
    expect(readJpegGps(makeJpegWithGps(95, 5))).toBeNull();
    expect(readJpegGps(makeJpegWithGps(52.09, 5.12))).not.toBeNull();
  });
});
