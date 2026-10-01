import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db/database';
import { migrations } from '../src/db/migrations';
import { createServices, MemorySecretStore } from '../src/services';

describe('migraties', () => {
  it('vult de importperiodes aan voor afschriften die vóór migratie 4 zijn ingelezen', () => {
    const db = new Database(':memory:');
    for (const m of migrations.slice(0, 3)) db.exec(m);
    db.pragma('user_version = 3');
    db.exec(`INSERT INTO chart_of_accounts (id, rgs_code, code, name, category) VALUES (1, 'BLiqBanRba', '1100', 'Bank', 'activa');
      INSERT INTO bank_accounts (id, name, account_id) VALUES (1, 'Zakelijk', 1);
      INSERT INTO import_batches (id, filename, source) VALUES (7, 'oud.csv', 'csv');
      INSERT INTO bank_transactions (bank_account_id, transaction_date, amount, source, import_batch_id, dedup_hash) VALUES
        (1, '2026-03-02', 100, 'csv', 7, 'a'), (1, '2026-03-28', 200, 'csv', 7, 'b');`);
    migrate(db);
    expect(db.prepare('SELECT * FROM import_batch_accounts').all()).toEqual([
      { batch_id: 7, bank_account_id: 1, period_from: '2026-03-02', period_to: '2026-03-28', transactions: 2, imported: 2, duplicates: 0, closing_balance: null, closing_date: null },
    ]);
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
  });
});

describe('migratie: bewijs als echte koppeling (#179)', () => {
  /** de migratie die document_links maakt; welk nummer hij heeft doet er niet toe */
  const index = migrations.findIndex((m) => m.includes('CREATE TABLE IF NOT EXISTS document_links'));
  const tables = ['journal_entries', 'journal_lines', 'events', 'event_evidence', 'purchase_invoices', 'purchase_invoice_lines', 'bank_transactions', 'vat_periods'];
  const dump = (db: Database.Database, names: string[]) => Object.fromEntries(names.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()]));
  const reasons = (text: string[]) => JSON.stringify({ categoryKey: 'overig', vatCode: 'hoog', business: true, confidence: 1, source: 'geheugen', reasons: text, automatic: true });

  /** Een administratie zoals vóór de migratie: bonnen bij betalingen staan alleen als tekst in de uitleg. */
  function oldAdministration() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    for (const m of migrations.slice(0, index)) db.exec(m);
    db.pragma(`user_version = ${index}`);
    const s = createServices(db, {
      pdf: async () => Buffer.from('PDF'),
      mailerFactory: async () => ({ send: async () => ({ messageId: '<x>' }) }),
      secrets: new MemorySecretStore(),
      fetch: async () => { throw new Error('geen netwerk in tests'); },
      storeFile: async (name) => `/tmp/${name}`,
      licensePublicKey: '',
    });
    s.bank.import({ source: 'csv', warnings: [], transactions: [
      { date: '2026-07-08', amount: -15423, description: 'TransIP', counterName: 'TRANSIP B.V.' },
      { date: '2026-07-09', amount: -6100, description: 'KPN', counterName: 'KPN' },
      { date: '2026-07-10', amount: -24200, description: 'Gamma', counterName: 'GAMMA' },
    ] });
    const [transip, kpn, gamma] = s.bank.list().sort((a, b) => a.transaction_date.localeCompare(b.transaction_date));
    s.bank.bookToAccount(transip!.id, { account: 'WBedKanSof', vatCode: 'hoog' });
    // KPN was geboekt en is daarna teruggedraaid: de betaling staat weer open
    s.bank.bookToAccount(kpn!.id, { account: 'WBedKanTel', vatCode: 'hoog' });
    s.bank.unmatch(kpn!.id, '2026-07-09');
    const doc = (name: string, status: string, classification: string | null, extra: { mime?: string; source?: string; purchase?: number | null; copyOf?: number | null } = {}) =>
      Number(db.prepare(`INSERT INTO documents (file_path, original_name, mime_type, sha256, status, extraction_source, classification, purchase_invoice_id, duplicate_of_document_id, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'HIGH')`)
        .run(`/tmp/${name}`, name, extra.mime ?? 'application/pdf', name, status, extra.source ?? 'pdf-text', classification, extra.purchase ?? null, extra.copyOf ?? null).lastInsertRowid);
    // een aankoop uit een bon, met een kopie; de betaling van Gamma hoort bij die aankoop
    const geboekt = doc('gamma.jpg', 'verwerkt', null, { mime: 'image/jpeg', source: 'ocr:test' });
    const purchase = s.purchases.create({ relationId: s.relations.findOrCreateSupplier('Gamma').id, invoiceDate: '2026-07-10', description: 'Materiaal — Gamma', attachmentPath: '/tmp/gamma.jpg', documentId: geboekt, lines: [{ account: 'WKprInkMat', netAmount: 20000, vatCode: 'hoog' }] });
    db.prepare('UPDATE documents SET purchase_invoice_id = ? WHERE id = ?').run(purchase.id, geboekt);
    s.bank.matchPurchase(gamma!.id, purchase.id);
    const ids = {
      geboekt,
      kopie: doc('gamma-kopie.pdf', 'genegeerd', null, { purchase: purchase.id, copyOf: geboekt }),
      goed: doc('transip.xml', 'verwerkt', reasons([`bewijsstuk bij banktransactie #${transip!.id}`]), { mime: 'application/xml', source: 'ubl' }),
      goed2: doc('transip.pdf', 'verwerkt', reasons(['eerder bevestigd', `bewijsstuk bij banktransactie #${transip!.id}`])),
      onleesbaar: doc('onleesbaar.pdf', 'verwerkt', reasons(['bewijsstuk bij banktransactie #12a'])),
      weg: doc('weg.pdf', 'verwerkt', reasons(['bewijsstuk bij banktransactie #999'])),
      teruggedraaid: doc('kpn.pdf', 'verwerkt', reasons([`bewijsstuk bij banktransactie #${kpn!.id}`])),
      bijAankoop: doc('gamma-betaling.pdf', 'verwerkt', reasons([`bewijsstuk bij banktransactie #${gamma!.id}`])),
      twee: doc('twee.pdf', 'verwerkt', reasons([`bewijsstuk bij banktransactie #${transip!.id}`, `bewijsstuk bij banktransactie #${kpn!.id}`])),
      alWeggelegd: doc('weggelegd.pdf', 'genegeerd', reasons([`bewijsstuk bij banktransactie #${transip!.id}`])),
      kapot: doc('kapot.pdf', 'verwerkt', '{geen json'),
      gewoon: doc('los.pdf', 'controle', reasons(['je Gamma eerder als materiaal hebt bevestigd'])),
    };
    return { db, s, ids, transip: transip!, kpn: kpn!, gamma: gamma!, purchase };
  }

  it('zet alleen ondubbelzinnige tekstkoppelingen om; de rest komt op controle; de boekhouding blijft gelijk', () => {
    const { db, s, ids, transip, purchase } = oldAdministration();
    const before = { ...dump(db, tables), balances: s.ledger.balances(), vat: s.vat.calculate('2026-Q3') };
    const documentsBefore = db.prepare('SELECT * FROM documents ORDER BY id').all() as { id: number }[];
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
    // journaal, gebeurtenissen, aankopen (ook hun bijlage), bank en btw: niets veranderd
    expect({ ...dump(db, tables), balances: s.ledger.balances(), vat: s.vat.calculate('2026-Q3') }).toEqual(before);

    const links = db.prepare('SELECT document_id, purchase_invoice_id, bank_transaction_id, is_primary, origin, provenance FROM document_links ORDER BY document_id').all();
    expect(links).toEqual([
      { document_id: ids.geboekt, purchase_invoice_id: purchase.id, bank_transaction_id: null, is_primary: 1, origin: 'geboekt', provenance: 'migratie' },
      { document_id: ids.kopie, purchase_invoice_id: purchase.id, bank_transaction_id: null, is_primary: 0, origin: 'dubbel', provenance: 'migratie' },
      // twee bonnen bij dezelfde betaling: de leesbare PDF is het hoofdbewijsstuk, de losse e-factuur blijft erbij
      { document_id: ids.goed, purchase_invoice_id: null, bank_transaction_id: transip.id, is_primary: 0, origin: 'bewijs', provenance: 'migratie' },
      { document_id: ids.goed2, purchase_invoice_id: null, bank_transaction_id: transip.id, is_primary: 1, origin: 'bewijs', provenance: 'migratie' },
    ]);
    const report = Object.fromEntries((db.prepare('SELECT document_id, result, detail FROM document_link_migration').all() as { document_id: number; result: string; detail: string }[]).map((r) => [r.document_id, [r.result, r.detail]]));
    expect(report).toEqual({
      [ids.goed]: ['gemigreerd', 'gekoppeld aan de betaling'],
      [ids.goed2]: ['gemigreerd', 'gekoppeld aan de betaling'],
      [ids.onleesbaar]: ['onzeker', 'het nummer van de betaling is niet te lezen'],
      [ids.weg]: ['onzeker', 'de betaling bestaat niet meer'],
      [ids.teruggedraaid]: ['onzeker', 'de betaling is niet (meer) geboekt'],
      [ids.bijAankoop]: ['conflict', 'de betaling hoort intussen bij een aankoop of factuur'],
      [ids.twee]: ['conflict', 'er worden meerdere betalingen genoemd'],
      [ids.alWeggelegd]: ['onzeker', 'de bon stond niet (meer) op verwerkt'],
    });

    const after = new Map((db.prepare('SELECT * FROM documents ORDER BY id').all() as { id: number; status: string; issues: string }[]).map((d) => [d.id, d]));
    const review = [ids.onleesbaar, ids.weg, ids.teruggedraaid, ids.bijAankoop, ids.twee];
    for (const d of documentsBefore) {
      if (review.includes(d.id)) {
        // onzeker of tegenstrijdig: nergens aan gekoppeld, op controle, met uitleg; verder ongewijzigd
        expect(after.get(d.id)).toEqual({ ...d, status: 'controle', issues: expect.stringContaining('Aan je boekhouding is niets veranderd') });
      } else {
        expect(after.get(d.id), `document ${d.id} is niet aangeraakt`).toEqual(d);
      }
    }
    // zichtbaar: elk onzeker geval is een vraag op Vandaag
    s.settings.update({ onboardingDone: true });
    const tasks = s.inbox.tasks('2026-07-20').filter((t) => t.kind === 'document-review');
    expect(tasks.map((t) => t.ref.documentId).sort()).toEqual([...review, ids.gewoon].sort());
    expect(tasks.find((t) => t.ref.documentId === ids.weg)!.question).toMatch(/stond als bewijs bij een betaling/);
    // en de koppeling werkt meteen overal: de betaling van TransIP heeft een bon, die van KPN niet
    expect(s.search.infoFor(`bank:${transip.id}`)?.evidence).toBe(true);
    expect(s.intake.get(ids.goed2)).toMatchObject({ outcome: 'bewijs-gekoppeld', link: { target: { kind: 'bank', id: transip.id }, is_primary: true } });
    expect(s.intake.get(ids.kopie).outcome).toBe('dubbel');
  });

  it('is veilig om nog een keer te draaien: er verandert dan niets meer', () => {
    const { db } = oldAdministration();
    migrate(db);
    const state = ['documents', 'document_links', 'document_link_migration', 'document_notices', 'document_proposal_rejections', ...tables];
    const once = dump(db, state);
    db.exec(migrations[index]!);
    db.exec(migrations[index]!);
    expect(dump(db, state)).toEqual(once);
  });

  it('een lege en een nieuwe administratie migreren zonder fout', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM document_links').get()).toEqual({ n: 0 });
  });
});
