import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, NEWER_DATABASE_MESSAGE, openDatabase } from '../src/db/database';
import { migrations } from '../src/db/migrations';
import { createServices, MemorySecretStore } from '../src/services';
import { createApi, type HostContext } from '../src/main/api';

describe('migraties', () => {
  it('opent een database van een nieuwere app niet en wijzigt geen enkel byte', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'gb-nieuwere-db-')), 'boekhouding.sqlite');
    const newer = openDatabase(file);
    newer.pragma(`user_version = ${migrations.length + 1}`);
    newer.close();
    const before = readFileSync(file);

    expect(() => openDatabase(file)).toThrow(NEWER_DATABASE_MESSAGE);
    expect(readFileSync(file)).toEqual(before);
  });

  it('migrate weigert een hogere user_version voordat een migratie draait', () => {
    const db = new Database(':memory:');
    db.pragma(`user_version = ${migrations.length + 7}`);
    expect(() => migrate(db)).toThrow(NEWER_DATABASE_MESSAGE);
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length + 7);
    db.close();
  });

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
  // een latere migratie (verzamelbetalingen, #184) geeft elke bankregel drie lege kolommen erbij; verder moet alles gelijk blijven
  // en een latere (#239) twee lege kolommen bij elke aankoop: "al via je bank betaald"
  const withLaterColumns = <T extends Record<string, unknown>>(snap: T): T => ({
    ...snap,
    bank_transactions: (snap.bank_transactions as object[]).map((r) => ({ ...r, batch_ref: null, batch_total: null, duplicate_of: null })),
    purchase_invoices: (snap.purchase_invoices as object[]).map((r) => ({ ...r, expected_on_bank_account_id: null, expected_on_bank_since: null })),
  });
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
    // de betalingen zoals de app ze toen wegschreef (het inlezen van nu kent kolommen die er toen nog niet waren)
    const account = s.bank.listAccounts()[0]!.id;
    db.prepare(`INSERT INTO import_batches (id, source, kind, imported_count) VALUES (1, 'csv', 'csv', 3)`).run();
    db.prepare(`INSERT INTO import_batch_accounts (batch_id, bank_account_id, period_from, period_to, transactions, imported, duplicates) VALUES (1, ?, '2026-07-08', '2026-07-10', 3, 3, 0)`).run(account);
    const row = db.prepare(`INSERT INTO bank_transactions (bank_account_id, transaction_date, amount, counter_name, description, source, import_batch_id, dedup_hash) VALUES (?, ?, ?, ?, ?, 'csv', 1, ?)`);
    row.run(account, '2026-07-08', -15423, 'TRANSIP B.V.', 'TransIP', 'oud-1');
    row.run(account, '2026-07-09', -6100, 'KPN', 'KPN', 'oud-2');
    row.run(account, '2026-07-10', -24200, 'GAMMA', 'Gamma', 'oud-3');
    const [transip, kpn, gamma] = s.bank.list().sort((a, b) => a.transaction_date.localeCompare(b.transaction_date));
    s.bank.bookToAccount(transip!.id, { account: 'WBedKanSof', vatCode: 'hoog' });
    // KPN was geboekt en is daarna teruggedraaid: de betaling staat weer open
    s.bank.bookToAccount(kpn!.id, { account: 'WBedKanTel', vatCode: 'hoog' });
    s.bank.unmatch(kpn!.id, '2026-07-09');
    const doc = (name: string, status: string, classification: string | null, extra: { mime?: string; source?: string; purchase?: number | null; copyOf?: number | null; result?: unknown } = {}) =>
      Number(db.prepare(`INSERT INTO documents (file_path, original_name, mime_type, sha256, status, extraction_source, classification, purchase_invoice_id, duplicate_of_document_id, confidence, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'HIGH', ?)`)
        .run(`/tmp/${name}`, name, extra.mime ?? 'application/pdf', name, status, extra.source ?? 'pdf-text', classification, extra.purchase ?? null, extra.copyOf ?? null, extra.result ? JSON.stringify(extra.result) : null).lastInsertRowid);
    const f = <T>(value: T) => ({ value, confidence: 1, source: 'pdf-text' });
    /** zoals gelezen van de factuur van Gamma: zelfde leverancier, bedrag, nummer en datum als de aankoop */
    const gammaInvoice = { documentType: f('purchase_invoice'), supplier: f('Gamma'), supplierVatNumber: null, supplierIban: null, invoiceNumber: f('G-2026-7'), invoiceDate: f('2026-07-10'), dueDate: null, currency: f('EUR'), subtotal: null, vat: f([]), total: f(24200), lineDescriptions: [], reverseCharge: false, rawText: '' };
    // een aankoop uit een bon, met een kopie; de betaling van Gamma hoort bij die aankoop
    const geboekt = doc('gamma.jpg', 'verwerkt', null, { mime: 'image/jpeg', source: 'ocr:test' });
    // de leverancier rechtstreeks in de oude toestand van relations: de service schrijft al de kolommen van een latere migratie
    const gammaId = Number(db.prepare(`INSERT INTO relations (type, name) VALUES ('leverancier', 'Gamma')`).run().lastInsertRowid);
    const purchase = s.purchases.create({ relationId: gammaId, supplierReference: 'G-2026-7', invoiceDate: '2026-07-10', description: 'Materiaal — Gamma', attachmentPath: '/tmp/gamma.jpg', documentId: geboekt, lines: [{ account: 'WKprInkMat', netAmount: 20000, vatCode: 'hoog' }] });
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
      // zeker dezelfde factuur als de aankoop van Gamma, maar de genoemde betaling bestaat niet meer
      zekereKopie: doc('gamma-factuur.pdf', 'verwerkt', reasons(['bewijsstuk bij banktransactie #998']), { result: gammaInvoice }),
      alWeggelegd: doc('weggelegd.pdf', 'genegeerd', reasons([`bewijsstuk bij banktransactie #${transip!.id}`])),
      kapot: doc('kapot.pdf', 'verwerkt', '{geen json'),
      gewoon: doc('los.pdf', 'controle', reasons(['je Gamma eerder als materiaal hebt bevestigd'])),
    };
    return { db, s, ids, transip: transip!, kpn: kpn!, gamma: gamma!, purchase };
  }

  it('zet alleen ondubbelzinnige tekstkoppelingen om; de rest komt op controle; de boekhouding blijft gelijk', () => {
    const { db, s, ids, transip, purchase } = oldAdministration();
    const before = withLaterColumns({ ...dump(db, tables), balances: s.ledger.balances(), vat: s.vat.calculate('2026-Q3') });
    // een latere migratie (bonnenscanner, #48) geeft elk document twee lege kolommen erbij; verder moet alles gelijk blijven
    const documentsBefore = (db.prepare('SELECT * FROM documents ORDER BY id').all() as { id: number }[]).map((d) => ({ ...d, note: null, proposed_paid_with: null }));
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
      [ids.zekereKopie]: ['onzeker', 'de betaling bestaat niet meer'],
      [ids.alWeggelegd]: ['onzeker', 'de bon stond niet (meer) op verwerkt'],
    });

    const after = new Map((db.prepare('SELECT * FROM documents ORDER BY id').all() as { id: number; status: string; issues: string }[]).map((d) => [d.id, d]));
    const review = [ids.onleesbaar, ids.weg, ids.teruggedraaid, ids.bijAankoop, ids.twee, ids.zekereKopie];
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

  it('een bon die zo op controle kwam wordt opnieuw beoordeeld: eerst de vraag, tot dan niet te boeken; de boekhouding blijft gelijk', async () => {
    const { db, s, ids, transip, purchase } = oldAdministration();
    const fin = () => ({ ...dump(db, tables), balances: s.ledger.balances(), vat: s.vat.calculate('2026-Q3') });
    const before = withLaterColumns(fin());
    migrate(db);
    // 'twee' noemde twee betalingen (daarom niet omgezet); die van TransIP staat nog gewoon als kosten geboekt
    const asPurchase = { supplier: 'TransIP', date: '2026-07-08', total: 15423, categoryKey: 'software', vatCode: 'hoog' as const, business: true, paidWith: 'later' as const };
    const gamma = { ...asPurchase, supplier: 'Gamma', date: '2026-07-10', total: 24200, categoryKey: 'materiaal' };
    // direct na het bijwerken is hij nog niet opnieuw bekeken: boeken als nieuwe aankoop kan niet
    for (const id of [ids.twee, ids.bijAankoop, ids.weg]) expect(() => s.intake.confirm(id, asPurchase)).toThrow(/stond eerder als bewijs bij een betaling/);
    expect(fin()).toEqual(before);

    // opnieuw beoordelen (gebeurt bij het openen van Vandaag, de bonnenlijst of de bon): niets geboekt, niets gekoppeld
    const linksAfterMigration = dump(db, ['document_links']);
    expect(await s.intake.reassessMigrated('2026-07-20')).toBe(6);
    expect(fin()).toEqual(before);
    expect(dump(db, ['document_links'])).toEqual(linksAfterMigration);

    // de betaling staat al als kosten geboekt: de gewone vraag, en boeken blijft geweigerd tot er een antwoord is
    const twee = s.intake.get(ids.twee);
    expect(twee).toMatchObject({ status: 'controle', outcome: 'controle', link: null, purchase_invoice_id: null });
    expect(twee.issues.map((i) => [i.field, i.severity])).toEqual([['evidence-migration', 'fout'], ['evidence', 'fout']]);
    expect(twee.issues[1]!.message).toBe('Deze betaling is al geboekt. Wil je deze bon alleen als bewijsstuk koppelen?');
    expect(s.intake.pending(twee)).toMatchObject({ kind: 'evidence', candidate: `bank:${transip.id}`, target: { kind: 'bank', supplier: 'TRANSIP B.V.', amount: 15423 } });
    expect(() => s.intake.confirm(ids.twee, asPurchase)).toThrow(/Kies eerst/);
    // de betaling van Gamma hoort intussen bij een aankoop: die aankoop staat er dus al
    const bijAankoop = s.intake.get(ids.bijAankoop);
    expect(s.intake.pending(bijAankoop)).toMatchObject({ kind: 'duplicate', candidate: `aankoop:${purchase.id}`, target: { kind: 'aankoop', supplier: 'Gamma', amount: 24200 } });
    expect(bijAankoop.issues.find((i) => i.field === 'duplicate')?.message).toMatch(/hoort nu bij de aankoop bij Gamma.*Is dit dezelfde aankoop\?/);
    expect(() => s.intake.confirm(ids.bijAankoop, gamma)).toThrow(/Kies eerst/);
    // zeker dezelfde factuur als een aankoop die er al staat: bij een nieuwe bon zou de app die vanzelf als kopie
    // erbij leggen; hier gebeurt niets vanzelf, het is een vraag
    const kopie = s.intake.get(ids.zekereKopie);
    expect(kopie).toMatchObject({ status: 'controle', link: null, duplicate_of_document_id: null });
    expect(kopie.issues.find((i) => i.field === 'duplicate')?.suggestion).toMatchObject({ strength: 'zeker', purchaseId: purchase.id });
    expect(() => s.intake.confirm(ids.zekereKopie, gamma)).toThrow(/Kies eerst/);
    // op Vandaag staat de vraag met ja en nee, geen knop om te boeken
    s.settings.update({ onboardingDone: true });
    const tasks = s.inbox.tasks('2026-07-20');
    expect(tasks.find((t) => t.ref.documentId === ids.twee)!.actions.map((a) => a.id)).toEqual(['bewijs', 'nee', 'open']);
    expect(tasks.find((t) => t.ref.documentId === ids.bijAankoop)!.actions.map((a) => a.id)).toEqual(['dubbel', 'nee', 'open']);
    // geen betaling meer om naar te vragen (weg, onleesbaar, teruggedraaid): gewone controle, met de uitleg erbij
    for (const id of [ids.weg, ids.onleesbaar, ids.teruggedraaid]) {
      const d = s.intake.get(id);
      expect(s.intake.pending(d)).toBeNull();
      expect(s.intake.awaitsReassessment(d)).toBe(false);
      expect(d.issues.some((i) => i.field === 'evidence-migration')).toBe(true);
    }

    // nog een keer beoordelen doet niets meer
    const state = ['documents', 'document_links', 'document_link_migration', 'document_proposal_rejections'];
    const once = dump(db, state);
    expect(await s.intake.reassessMigrated('2026-07-21')).toBe(0);
    await s.intake.decide(ids.twee, 'later');
    expect(dump(db, state)).toEqual(once);

    // Ja: alleen het bewijs komt bij de betaling; Nee: de vraag is weg en komt niet terug. De boekhouding blijft gelijk.
    expect(await s.intake.decide(ids.twee, 'ja')).toMatchObject({ status: 'verwerkt', outcome: 'bewijs-gekoppeld', issues: [], link: { target: { kind: 'bank', id: transip.id }, origin: 'bewijs', provenance: 'gebruiker' } });
    const nee = await s.intake.decide(ids.bijAankoop, 'nee');
    expect(nee).toMatchObject({ status: 'controle', link: null });
    expect(s.intake.pending(nee)).toBeNull();
    expect(s.intake.pending(await s.intake.evaluate(ids.bijAankoop, [], '2026-07-22', { autoConfirm: false }))).toBeNull();
    expect(fin()).toEqual(before);
    expect(s.purchases.list()).toHaveLength(1);
  });

  it('het opnieuw beoordelen gebeurt vanzelf bij het openen van de bon, de bonnenlijst en Vandaag', async () => {
    for (const via of ['open', 'list', 'home'] as const) {
      const { db, s, ids, transip } = oldAdministration();
      migrate(db);
      s.settings.update({ onboardingDone: true });
      const api = createApi(s, { appVersion: () => '0.0.0', hasSmtpPassword: () => false } as unknown as HostContext);
      expect(s.intake.awaitsReassessment(s.intake.get(ids.twee))).toBe(true);
      if (via === 'open') expect(s.intake.pending(await api.documents.open(ids.twee))).toMatchObject({ kind: 'evidence', candidate: `bank:${transip.id}` });
      else if (via === 'list') expect((await api.documents.list('controle')).find((d) => d.id === ids.twee)!.issues.map((i) => i.field)).toContain('evidence');
      else expect((await api.home.get()).tasks.find((t) => t.ref.documentId === ids.twee)!.actions[0]).toMatchObject({ id: 'bewijs', label: 'Ja, alleen als bewijs' });
      expect(s.intake.awaitsReassessment(s.intake.get(ids.twee)), via).toBe(false);
      expect(db.prepare('SELECT COUNT(*) AS n FROM purchase_invoices').get()).toEqual({ n: 1 });
    }
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
