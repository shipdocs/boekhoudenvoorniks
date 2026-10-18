import { describe, expect, it } from 'vitest';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { LedgerError, PeriodLockedError } from '../src/core-ledger/ledger';
import { setup } from './helpers';

const ASOF = '2026-10-15';

function scenario() {
  const ctx = setup();
  const { s } = ctx;
  const gamma = s.relations.findOrCreateSupplier('Gamma');
  const purchase = (date: string, net = 10000) =>
    s.purchases.create({ relationId: gamma.id, invoiceDate: date, description: 'Materiaal', lines: [{ account: 'WKprInkMat', netAmount: net, vatCode: 'hoog' }] });
  const entryOf = (id: number) => s.db.prepare('SELECT entry_date, vat_date, description, status FROM journal_entries WHERE id = ?').get(id) as { entry_date: string; vat_date: string; description: string; status: string };
  const purchaseEntry = (purchaseId: number) => (s.db.prepare('SELECT journal_entry_id AS id FROM purchase_invoices WHERE id = ?').get(purchaseId) as { id: number }).id;
  return { ...ctx, gamma, purchase, entryOf, purchaseEntry };
}

describe('periode afsluiten', () => {
  it('kiest einddatums van afgelopen kwartalen, na wat al afgesloten is', () => {
    const { s } = scenario();
    expect(s.periods.suggestedDates(ASOF).slice(0, 5)).toEqual(['2026-09-30', '2026-06-30', '2026-03-31', '2025-12-31', '2025-09-30']);
    s.periods.close('2026-03-31', [], ASOF);
    expect(s.periods.suggestedDates(ASOF)).toEqual(['2026-09-30', '2026-06-30']);
  });

  it('alleen een voorbije periode, en niet opnieuw of eerder dan wat al vast ligt', () => {
    const { s } = scenario();
    expect(() => s.periods.close('2026-10-15', [], ASOF)).toThrow(/voorbij is/);
    s.periods.close('2026-06-30', [], ASOF);
    expect(s.periods.status()).toEqual({ closedUntil: '2026-06-30', exchange: null, firstOpen: '2026-07-01' });
    expect(() => s.periods.close('2026-03-31', [], ASOF)).toThrow(/al afgesloten/);
    expect(() => s.periods.close('2026-06-30', [], ASOF)).toThrow(/al afgesloten/);
  });

  it('onverwerkte betalingen en bonnen in de periode blokkeren; na de einddatum niet', () => {
    const { s } = scenario();
    s.bank.import({ source: 'csv', warnings: [], transactions: [
      { date: '2026-09-12', amount: -6050, description: 'Pin', counterName: 'GAMMA' },
      { date: '2026-10-02', amount: -1000, description: 'Pin', counterName: 'SHELL' },
    ] });
    s.db.prepare(`INSERT INTO documents (file_path, original_name, mime_type, sha256, status, result) VALUES ('/x.pdf', 'bon.pdf', 'application/pdf', 'abc', 'controle', ?)`).run(JSON.stringify({ invoiceDate: { value: '2026-09-20' } }));
    const keys = s.periods.checks('2026-09-30').map((c) => [c.key, c.level]);
    expect(keys).toContainEqual(['bank-open', 'blokkeert']);
    expect(keys).toContainEqual(['documenten', 'blokkeert']);
    expect(() => s.periods.close('2026-09-30', [], ASOF)).toThrow(/Eerst oplossen: 1 betaling .*; 1 bon of factuur/);
    // t/m juni is er niets open
    expect(s.periods.checks('2026-06-30').filter((c) => c.level === 'blokkeert')).toEqual([]);
  });

  it('afschriften die niet t/m de einddatum lopen: eerst bevestigen', () => {
    const { s } = scenario();
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-08-20', amount: 5000, description: 'Rente' }] });
    s.bank.bookToAccount(s.bank.list()[0]!.id, { account: ACCOUNTS.bankkosten, description: 'Rente' });
    const check = s.periods.checks('2026-09-30').find((c) => c.key.startsWith('bank-afschrift-'))!;
    expect(check).toMatchObject({ level: 'bevestigen' });
    expect(check.title).toMatch(/afschriften t\/m 20 augustus 2026/);
    expect(() => s.periods.close('2026-09-30', [], ASOF)).toThrow(/Eerst bevestigen/);
    expect(s.periods.close('2026-09-30', [check.key], ASOF).closedUntil).toBe('2026-09-30');
  });

  it('een tussentijdse export van de laatste dag dekt die dag nog niet: eerst bevestigen, of een afschrift van een dag later (#226)', () => {
    const { s } = scenario();
    const lees = (at: string, transactions: { date: string; amount: number; description: string }[]) => {
      const batch = s.bank.import({ source: 'csv', warnings: [], transactions }).batchId;
      for (const t of s.bank.list({ status: 'nieuw' })) s.bank.bookToAccount(t.id, { account: ACCOUNTS.bankkosten, description: 'Rente' });
      s.db.prepare('UPDATE import_batches SET imported_at = ? WHERE id = ?').run(at, batch);
    };
    // het afschrift is op 30 september zelf gedownload en ingelezen: wat er later die dag nog bij kwam, staat er niet in
    lees('2026-09-30 10:00:00', [{ date: '2026-09-29', amount: 5000, description: 'Rente' }, { date: '2026-09-30', amount: 2500, description: 'Rente' }]);
    const check = s.periods.checks('2026-09-30').find((c) => c.key.startsWith('bank-afschrift-'))!;
    expect(check).toMatchObject({ level: 'bevestigen' });
    expect(check.title).toMatch(/compleet t\/m 29 september 2026/);
    expect(check.detail).toMatch(/op 30 september 2026 zelf/);
    expect(() => s.periods.close('2026-09-30', [], ASOF)).toThrow(/Eerst bevestigen/);
    // de volgende ochtend opnieuw gedownload: er kwam die middag nog een betaling bij, en nu is de dag compleet
    lees('2026-10-01 10:00:00', [{ date: '2026-09-30', amount: 2500, description: 'Rente' }, { date: '2026-09-30', amount: 700, description: 'Rente spaarrekening' }]);
    expect(s.periods.checks('2026-09-30')).toEqual([]);
    expect(s.periods.close('2026-09-30', [], ASOF).closedUntil).toBe('2026-09-30');
  });

  it('een later afschrift dat pas de dag erna begint, dekt de dag van de tussentijdse export niet (#226)', () => {
    const { s } = scenario();
    const lees = (at: string, transactions: { date: string; amount: number; description: string }[]) => {
      const batch = s.bank.import({ source: 'csv', warnings: [], transactions }).batchId;
      for (const t of s.bank.list({ status: 'nieuw' })) s.bank.bookToAccount(t.id, { account: ACCOUNTS.bankkosten, description: 'Rente' });
      s.db.prepare('UPDATE import_batches SET imported_at = ? WHERE id = ?').run(at, batch);
    };
    lees('2026-09-30 10:00:00', [{ date: '2026-09-29', amount: 5000, description: 'Rente' }, { date: '2026-09-30', amount: 2500, description: 'Rente' }]);
    // het volgende afschrift is een export "vanaf 1 oktober": de middag van 30 september staat in geen van beide
    lees('2026-10-10 10:00:00', [{ date: '2026-10-01', amount: 1200, description: 'Rente' }, { date: '2026-10-09', amount: 900, description: 'Rente' }]);
    expect(s.bank.importStatus()[0]).toMatchObject({ coverageTo: '2026-10-09', completeTo: '2026-09-29', gap: '2026-09-30' });
    const check = s.periods.checks('2026-09-30').find((c) => c.key.startsWith('bank-afschrift-'))!;
    expect(check).toMatchObject({ level: 'bevestigen' });
    expect(check.title).toMatch(/compleet t\/m 29 september 2026/);
    expect(check.detail).toMatch(/op 30 september 2026 zelf ingelezen.*waar 30 september 2026 ook in staat/);
    expect(() => s.periods.close('2026-09-30', [], ASOF)).toThrow(/Eerst bevestigen/);
    // een afschrift van later dat 30 september wel bevat, dicht het gat: dan telt ook oktober mee
    lees('2026-10-11 10:00:00', [{ date: '2026-09-30', amount: 2500, description: 'Rente' }, { date: '2026-10-01', amount: 1200, description: 'Rente' }]);
    expect(s.bank.importStatus()[0]).toMatchObject({ completeTo: '2026-10-09', gap: null });
    expect(s.periods.checks('2026-09-30')).toEqual([]);
  });

  it('zo\'n gat midden in de periode vraagt bij het afsluiten ook om een bevestiging, en is daarna afgedaan (#226)', () => {
    const { s } = scenario();
    const lees = (at: string, transactions: { date: string; amount: number; description: string }[]) => {
      const batch = s.bank.import({ source: 'csv', warnings: [], transactions }).batchId;
      for (const t of s.bank.list({ status: 'nieuw' })) s.bank.bookToAccount(t.id, { account: ACCOUNTS.bankkosten, description: 'Rente' });
      s.db.prepare('UPDATE import_batches SET imported_at = ? WHERE id = ?').run(at, batch);
    };
    lees('2026-09-15 10:00:00', [{ date: '2026-09-14', amount: 5000, description: 'Rente' }, { date: '2026-09-15', amount: 2500, description: 'Rente' }]);
    lees('2026-10-05 10:00:00', [{ date: '2026-09-16', amount: 1200, description: 'Rente' }, { date: '2026-10-04', amount: 900, description: 'Rente' }]);
    expect(s.bank.importStatus()[0]).toMatchObject({ completeTo: '2026-09-14', gap: '2026-09-15' });
    const check = s.periods.checks('2026-09-30').find((c) => c.key.startsWith('bank-afschrift-'))!;
    expect(check.detail).toMatch(/op 15 september 2026 zelf ingelezen/);
    expect(() => s.periods.close('2026-09-30', [], ASOF)).toThrow(/Eerst bevestigen/);
    // bevestigd dat er die dag niets meer bij kwam: afgesloten is afgesloten, de dag telt niet meer als gat
    expect(s.periods.close('2026-09-30', [check.key], ASOF).closedUntil).toBe('2026-09-30');
    expect(s.bank.importStatus()[0]).toMatchObject({ completeTo: '2026-10-04', gap: null });
  });

  it('bevestigen kan ook: na de tussentijdse export is er echt niets meer bij gekomen (#226)', () => {
    const { s } = scenario();
    const batch = s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-30', amount: 2500, description: 'Rente' }] }).batchId;
    s.bank.bookToAccount(s.bank.list()[0]!.id, { account: ACCOUNTS.bankkosten, description: 'Rente' });
    s.db.prepare(`UPDATE import_batches SET imported_at = '2026-09-30 10:00:00' WHERE id = ?`).run(batch);
    const check = s.periods.checks('2026-09-30').find((c) => c.key.startsWith('bank-afschrift-'))!;
    expect(s.periods.close('2026-09-30', [check.key], ASOF).closedUntil).toBe('2026-09-30');
  });
});

describe('bank bijgewerkt t/m (#226)', () => {
  it('de dag van de export telt pas mee als het afschrift ná die dag is ingelezen', () => {
    const { s } = scenario();
    s.settings.update({ onboardingDone: true });
    const days = [{ date: '2026-09-28', amount: 5000, description: 'Rente' }, { date: '2026-09-30', amount: 2500, description: 'Rente' }];
    const eerste = s.bank.import({ source: 'csv', warnings: [], transactions: days }).batchId;
    s.db.prepare(`UPDATE import_batches SET imported_at = '2026-09-30 10:00:00' WHERE id = ?`).run(eerste);
    // de laatste betaling is van 30 september, maar die dag is pas compleet na een import op een latere dag
    expect(s.bank.importStatus()[0]).toMatchObject({ coverageTo: '2026-09-30', completeTo: '2026-09-29' });
    expect(s.inbox.home('2026-09-30').bankUpdatedTo).toBe('2026-09-29');
    // importeren en tonen blijven direct: de betaling van vandaag staat er gewoon
    expect(s.bank.list().map((t) => t.transaction_date)).toContain('2026-09-30');
    // hetzelfde afschrift een dag later: niets nieuws, wel compleet t/m 30 september
    const tweede = s.bank.import({ source: 'csv', warnings: [], transactions: days }).batchId;
    s.db.prepare(`UPDATE import_batches SET imported_at = '2026-10-01 10:00:00' WHERE id = ?`).run(tweede);
    expect(s.bank.importStatus()[0]).toMatchObject({ coverageTo: '2026-09-30', completeTo: '2026-09-30' });
    expect(s.inbox.home('2026-10-01').bankUpdatedTo).toBe('2026-09-30');
  });

  it('een afschrift dat eerder ophoudt dan de dag van inlezen: bijgewerkt t/m de laatste dag van dat afschrift', () => {
    const { s } = scenario();
    const batch = s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-10', amount: 5000, description: 'Rente' }] }).batchId;
    s.db.prepare(`UPDATE import_batches SET imported_at = '2026-09-30 10:00:00' WHERE id = ?`).run(batch);
    expect(s.bank.importStatus()[0]).toMatchObject({ coverageTo: '2026-09-10', completeTo: '2026-09-10' });
  });

  it('een afschrift dat begint na een dag die alleen op de dag zelf is ingelezen, telt niet verder dan die dag', () => {
    const { s } = scenario();
    s.settings.update({ onboardingDone: true });
    const eerste = s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-28', amount: 5000, description: 'Rente' }, { date: '2026-09-30', amount: 2500, description: 'Rente' }] }).batchId;
    s.db.prepare(`UPDATE import_batches SET imported_at = '2026-09-30 10:00:00' WHERE id = ?`).run(eerste);
    const tweede = s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-10-01', amount: 1200, description: 'Rente' }, { date: '2026-10-04', amount: 900, description: 'Rente' }] }).batchId;
    s.db.prepare(`UPDATE import_batches SET imported_at = '2026-10-05 10:00:00' WHERE id = ?`).run(tweede);
    expect(s.bank.importStatus()[0]).toMatchObject({ coverageTo: '2026-10-04', completeTo: '2026-09-29', gap: '2026-09-30' });
    expect(s.inbox.home('2026-10-05').bankUpdatedTo).toBe('2026-09-29');
    // de melding op Vandaag zegt welk afschrift er nodig is: een nieuwer afschrift alleen helpt niet
    const stale = s.inbox.tasks('2026-10-20').find((t) => t.kind === 'bank-stale')!;
    expect(stale.title).toContain('tot 29 september 2026');
    expect(stale.question).toContain('waar 30 september 2026 ook in staat');
    // een dag zonder betalingen tussen twee afschriften is geen gat: het eerste afschrift was al compleet
    const derde = s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-30', amount: 2500, description: 'Rente' }, { date: '2026-10-04', amount: 900, description: 'Rente' }] }).batchId;
    s.db.prepare(`UPDATE import_batches SET imported_at = '2026-10-05 11:00:00' WHERE id = ?`).run(derde);
    const vierde = s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-10-08', amount: 300, description: 'Rente' }] }).batchId;
    s.db.prepare(`UPDATE import_batches SET imported_at = '2026-10-12 10:00:00' WHERE id = ?`).run(vierde);
    expect(s.bank.importStatus()[0]).toMatchObject({ completeTo: '2026-10-08', gap: null });
  });

  it('een betaling zonder afschrift maakt een dag die alleen op de dag zelf is ingelezen niet compleet', () => {
    const { s } = scenario();
    const batch = s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-29', amount: 5000, description: 'Rente' }, { date: '2026-09-30', amount: 2500, description: 'Rente' }] }).batchId;
    s.db.prepare(`UPDATE import_batches SET imported_at = '2026-09-30 10:00:00' WHERE id = ?`).run(batch);
    s.db.prepare(`INSERT INTO bank_transactions (bank_account_id, transaction_date, amount, description, source, dedup_hash, created_at) VALUES (?, '2026-09-30', 700, 'Rente spaarrekening', 'csv', 'los-1', '2026-10-05 10:00:00')`).run(s.bank.importStatus()[0]!.bankAccountId);
    expect(s.bank.importStatus()[0]).toMatchObject({ completeTo: '2026-09-29' });
    expect(s.periods.checks('2026-09-30').some((c) => c.key.startsWith('bank-afschrift-'))).toBe(true);
  });

  it('"niet bijgewerkt" op Vandaag rekent met dezelfde dag', () => {
    const { s } = scenario();
    s.settings.update({ onboardingDone: true });
    const batch = s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-10', amount: 5000, description: 'Rente' }] }).batchId;
    s.db.prepare(`UPDATE import_batches SET imported_at = '2026-09-10 10:00:00' WHERE id = ?`).run(batch);
    const stale = s.inbox.tasks('2026-09-25').find((t) => t.kind === 'bank-stale')!;
    expect(stale.title).toContain('tot 9 september 2026');
  });
});

describe('afgesloten is afgesloten', () => {
  it('een late bon komt op de eerste open dag; de btw volgt de documentdatum', () => {
    const { s, purchase, entryOf, purchaseEntry } = scenario();
    s.periods.close('2026-06-30', [], ASOF);
    const p = purchase('2026-05-20');
    const e = entryOf(purchaseEntry(p.id));
    expect(e.entry_date).toBe('2026-07-01');
    expect(e.description).toMatch(/\(documentdatum 20 mei 2026\)$/);
    // Q2 is nog niet aangegeven: de btw hoort gewoon bij Q2
    expect(e.vat_date).toBe('2026-05-20');
    // de aankoop zelf houdt zijn datum
    expect(s.purchases.get(p.id).invoice_date).toBe('2026-05-20');
    // winst: de kosten tellen in het 3e kwartaal, niet in het afgesloten 2e
    expect(s.ledger.balance('WKprInkMat', { from: '2026-04-01', to: '2026-06-30' })).toBe(0);
    expect(s.ledger.balance('WKprInkMat', { from: '2026-07-01', to: '2026-09-30' })).toBe(10000);
  });

  it('een betaling of memoriaalpost in de afgesloten periode wordt geweigerd, met een gewone melding', () => {
    const { s } = scenario();
    s.periods.close('2026-06-30', [], ASOF);
    const manual = () => s.ledger.post({ date: '2026-06-15', description: 'Correctie', source: 'handmatig', lines: [{ account: ACCOUNTS.bankkosten, debit: 100 }, { account: ACCOUNTS.bank, credit: 100 }] });
    expect(manual).toThrow(PeriodLockedError);
    expect(manual).toThrow(/afgesloten. Boek dit op of na 1 juli 2026/);
    // geen LedgerError: die wordt in de app als "er ging iets mis" getoond
    expect(manual).not.toThrow(LedgerError);
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-06-28', amount: -2500, description: 'Kosten', counterName: 'ING' }] });
    expect(() => s.bank.bookToAccount(s.bank.list()[0]!.id, { account: ACCOUNTS.bankkosten, description: 'Bankkosten' })).toThrow(/ontbrak waarschijnlijk een afschrift/);
    // op of na de eerste open dag gaat het gewoon
    expect(s.ledger.post({ date: '2026-07-01', description: 'Correctie', source: 'handmatig', lines: [{ account: ACCOUNTS.bankkosten, debit: 100 }, { account: ACCOUNTS.bank, credit: 100 }] })).toBeGreaterThan(0);
  });

  it('corrigeren van iets uit de afgesloten periode: de tegenboeking komt in de open periode', () => {
    const { s, purchase, entryOf, purchaseEntry } = scenario();
    const p = purchase('2026-05-20');
    const original = purchaseEntry(p.id);
    s.periods.close('2026-06-30', [], ASOF);
    const reversal = s.ledger.reverse(original, '2026-05-20');
    expect(entryOf(reversal).entry_date).toBe('2026-07-01');
    expect(entryOf(original).status).toBe('teruggedraaid');
    // het afgesloten kwartaal zelf verandert niet
    expect(s.ledger.balance('WKprInkMat', { from: '2026-04-01', to: '2026-06-30' })).toBe(10000);
  });

  it('de btw-aangifte van een afgesloten kwartaal kan nog', () => {
    const { s, purchase } = scenario();
    purchase('2026-05-20', 5000); // onder de grens voor een verplichte bon
    s.periods.close('2026-06-30', [], ASOF);
    expect(() => s.vat.markSubmitted('2026-Q2')).not.toThrow();
  });

  it('de database zelf weigert een post in de afgesloten periode, en het slot kan niet weg', () => {
    const { s } = scenario();
    s.periods.close('2026-06-30', [], ASOF);
    const insert = (date: string, source: string) => s.db.prepare(`INSERT INTO journal_entries (entry_date, description, source) VALUES (?, 'x', ?)`).run(date, source);
    expect(() => insert('2026-06-30', 'inkoop')).toThrow(/periode is afgesloten/);
    expect(() => insert('2026-06-30', 'btw')).not.toThrow();
    expect(() => s.db.prepare('DELETE FROM ledger_locks').run()).toThrow(/niet heropend/);
    expect(() => s.db.prepare(`UPDATE ledger_locks SET until_date = '2026-03-31'`).run()).toThrow(/niet heropend/);
    // alleen tijdens het inlezen van het antwoord van de boekhouder
    expect(() => s.periods.withoutLock(() => insert('2026-06-30', 'handmatig'))).not.toThrow();
    expect(() => insert('2026-06-29', 'handmatig')).toThrow(/periode is afgesloten/);
  });
});

describe('uitwisseling met de boekhouder', () => {
  it('de periode ligt vast: niets boeken, terugdraaien of rekeningen wijzigen; daarna gewoon door', () => {
    const { s, purchase, purchaseEntry, entryOf } = scenario();
    const p = purchase('2026-09-10');
    s.periods.startExchange('2026-09-30', 7, [], ASOF);
    expect(s.periods.status().exchange).toEqual({ until: '2026-09-30', no: 7 });
    expect(() => purchase('2026-09-20')).toThrow(/ligt bij je boekhouder/);
    expect(() => s.ledger.reverse(purchaseEntry(p.id), '2026-10-05')).toThrow(/ligt bij je boekhouder/);
    expect(entryOf(purchaseEntry(p.id)).status).toBe('definitief');
    expect(() => s.ledger.renameAccount(s.ledger.getAccount(ACCOUNTS.bankkosten).id, 'Bank')).toThrow(/geen grootboekrekeningen/);
    // na de einddatum werk je gewoon door
    expect(purchase('2026-10-02').id).toBeGreaterThan(0);
    // afsluiten of een nieuwe uitwisseling kan pas als deze klaar is
    expect(() => s.periods.close('2026-09-30', [], ASOF)).toThrow(/ligt nog bij je boekhouder/);
  });

  it('het antwoord inlezen mag in de periode boeken; daarna is hij afgesloten', () => {
    const { s } = scenario();
    s.periods.startExchange('2026-09-30', 7, [], ASOF);
    s.periods.withoutLock(() =>
      s.ledger.post({ date: '2026-09-30', description: 'Afschrijving bus', source: 'handmatig', lines: [{ account: ACCOUNTS.bankkosten, debit: 5000 }, { account: ACCOUNTS.bank, credit: 5000 }] }),
    );
    expect(() => s.periods.finishExchange(6)).toThrow(/geen uitwisseling 6/);
    expect(s.periods.finishExchange(7)).toMatchObject({ closedUntil: '2026-09-30', exchange: null });
    expect(() => s.periods.abortExchange()).not.toThrow(); // er loopt niets meer; het afgesloten slot blijft
    expect(s.periods.status().closedUntil).toBe('2026-09-30');
  });

  it('afbreken: de periode is weer open', () => {
    const { s, purchase, entryOf, purchaseEntry } = scenario();
    s.periods.startExchange('2026-09-30', 7, [], ASOF);
    s.periods.abortExchange();
    expect(s.periods.status()).toEqual({ closedUntil: null, exchange: null, firstOpen: null });
    expect(entryOf(purchaseEntry(purchase('2026-09-20').id)).entry_date).toBe('2026-09-20');
  });
});

describe('Vandaag bij een afgesloten periode', () => {
  it('een betaling in de afgesloten periode wordt een melding, geen vraag "zakelijk of privé"', () => {
    const { s } = scenario();
    s.periods.close('2026-06-30', [], ASOF);
    s.bank.import({ source: 'csv', warnings: [], transactions: [
      { date: '2026-06-28', amount: -2500, description: 'Kosten', counterName: 'BOUWMAAT' },
      { date: '2026-07-03', amount: -3000, description: 'Pin', counterName: 'PRAXIS' },
    ] });
    const tasks = s.inbox.tasks(ASOF);
    const locked = tasks.filter((t) => t.kind === 'bank-locked');
    expect(locked).toHaveLength(1);
    expect(locked[0]!.title).toMatch(/1 betaling in de afgesloten periode/);
    const bankTasks = tasks.filter((t) => t.ref?.bankTransactionId !== undefined).map((t) => t.title);
    expect(bankTasks.some((t) => /PRAXIS/.test(t))).toBe(true);
    expect(bankTasks.some((t) => /BOUWMAAT/.test(t))).toBe(false);
    // automatisch verwerken slaat hem over zonder fout
    expect(() => s.inbox.autoProcess(ASOF)).not.toThrow();
  });
});
