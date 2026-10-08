/**
 * Schema-migraties. Elke migratie draait precies één keer, bijgehouden via PRAGMA user_version.
 * Bestaande migraties NOOIT wijzigen na een release — voeg een nieuwe toe.
 */
/**
 * Zoekindex (#26): één FTS5-tabel over documenten, facturen (incl. regels), offertes, relaties,
 * banktransacties, klussen en inkopen. Triggers houden hem bij; alles blijft in dit bestand.
 */
function searchMigration(): string {
  const sources: { kind: string; table: string; title: string; body: string; date: string; amount: string; children?: { table: string; fk: string }[] }[] = [
    {
      kind: 'document',
      table: 'documents',
      title: "COALESCE(json_extract(r.result, '$.supplier.value'), r.original_name)",
      body: "COALESCE(json_extract(r.result, '$.rawText'), '') || ' ' || COALESCE((SELECT group_concat(value, ' ') FROM json_each(COALESCE(json_extract(r.result, '$.lineDescriptions'), '[]'))), '') || ' ' || COALESCE(json_extract(r.result, '$.invoiceNumber.value'), '') || ' ' || r.original_name",
      date: "json_extract(r.result, '$.invoiceDate.value')",
      amount: "json_extract(r.result, '$.total.value')",
    },
    {
      kind: 'factuur',
      table: 'invoices',
      title: "COALESCE(r.number, 'concept') || ' ' || COALESCE((SELECT name FROM relations WHERE id = r.relation_id), '')",
      body: "COALESCE(r.reference, '') || ' ' || COALESCE(r.intro, '') || ' ' || COALESCE(r.notes, '') || ' ' || COALESCE((SELECT group_concat(description, ' ') FROM invoice_lines WHERE invoice_id = r.id), '')",
      date: 'r.invoice_date',
      amount: 'r.total',
      children: [{ table: 'invoice_lines', fk: 'invoice_id' }],
    },
    {
      kind: 'offerte',
      table: 'quotes',
      title: "COALESCE(r.number, 'concept') || ' ' || COALESCE((SELECT name FROM relations WHERE id = r.relation_id), '')",
      body: "COALESCE(r.reference, '') || ' ' || COALESCE(r.intro, '') || ' ' || COALESCE(r.notes, '') || ' ' || COALESCE((SELECT group_concat(description, ' ') FROM quote_lines WHERE quote_id = r.id), '')",
      date: 'r.quote_date',
      amount: 'NULL',
      children: [{ table: 'quote_lines', fk: 'quote_id' }],
    },
    {
      kind: 'relatie',
      table: 'relations',
      title: 'r.name',
      body: "COALESCE(r.contact_name, '') || ' ' || COALESCE(r.email, '') || ' ' || COALESCE(r.address, '') || ' ' || COALESCE(r.city, '') || ' ' || COALESCE(r.iban, '') || ' ' || COALESCE(r.vat_number, '') || ' ' || COALESCE(r.kvk_number, '')",
      date: 'NULL',
      amount: 'NULL',
    },
    {
      kind: 'bank',
      table: 'bank_transactions',
      title: "COALESCE(r.counter_name, 'Banktransactie')",
      body: "r.description || ' ' || COALESCE(r.counter_iban, '') || ' ' || COALESCE(r.reference, '')",
      date: 'r.transaction_date',
      amount: 'r.amount',
    },
    {
      kind: 'klus',
      table: 'jobs',
      title: 'r.title',
      body: "COALESCE(r.address, '') || ' ' || COALESCE(r.notes, '') || ' ' || COALESCE((SELECT name FROM relations WHERE id = r.relation_id), '')",
      date: 'r.start_date',
      amount: 'NULL',
    },
    {
      kind: 'inkoop',
      table: 'purchase_invoices',
      title: "COALESCE((SELECT name FROM relations WHERE id = r.relation_id), r.description)",
      body: "r.description || ' ' || COALESCE(r.supplier_reference, '') || ' ' || COALESCE((SELECT group_concat(description, ' ') FROM purchase_invoice_lines WHERE purchase_invoice_id = r.id), '')",
      date: 'r.invoice_date',
      amount: 'r.total',
      children: [{ table: 'purchase_invoice_lines', fk: 'purchase_invoice_id' }],
    },
  ];
  // rowid = soort * 1e9 + id: bijwerken en verwijderen via de rowid is direct, zonder de index te doorzoeken
  const code = (src: (typeof sources)[number]) => sources.indexOf(src) + 1;
  const insert = (src: (typeof sources)[number], where: string) =>
    `INSERT INTO search_index (rowid, kind, ref_id, title, body, date, amount) SELECT ${code(src)} * 1000000000 + r.id, '${src.kind}', r.id, ${src.title}, ${src.body}, ${src.date}, ${src.amount} FROM ${src.table} r WHERE ${where};`;
  const parts = [
    `CREATE VIRTUAL TABLE search_index USING fts5(kind UNINDEXED, ref_id UNINDEXED, title, body, date UNINDEXED, amount UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');`,
  ];
  for (const src of sources) {
    const refresh = (id: string) => `DELETE FROM search_index WHERE rowid = ${code(src)} * 1000000000 + ${id}; ${insert(src, `r.id = ${id}`)}`;
    parts.push(
      insert(src, '1'),
      `CREATE TRIGGER search_${src.table}_ai AFTER INSERT ON ${src.table} BEGIN ${refresh('NEW.id')} END;`,
      `CREATE TRIGGER search_${src.table}_au AFTER UPDATE ON ${src.table} BEGIN ${refresh('NEW.id')} END;`,
      `CREATE TRIGGER search_${src.table}_ad AFTER DELETE ON ${src.table} BEGIN DELETE FROM search_index WHERE rowid = ${code(src)} * 1000000000 + OLD.id; END;`,
    );
    for (const c of src.children ?? []) {
      parts.push(
        `CREATE TRIGGER search_${c.table}_ai AFTER INSERT ON ${c.table} BEGIN ${refresh(`NEW.${c.fk}`)} END;`,
        `CREATE TRIGGER search_${c.table}_ad AFTER DELETE ON ${c.table} BEGIN ${refresh(`OLD.${c.fk}`)} END;`,
      );
    }
  }
  // garantie bij gereedschap en investeringen
  parts.push('ALTER TABLE purchase_invoices ADD COLUMN warranty_months INTEGER;');
  return parts.join('\n');
}

export const migrations: string[] = [
  /* 1: kernschema */ `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE relations (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('klant','leverancier','beide')),
    name TEXT NOT NULL,
    contact_name TEXT,
    email TEXT,
    phone TEXT,
    address TEXT,
    postcode TEXT,
    city TEXT,
    country TEXT NOT NULL DEFAULT 'NL',
    vat_number TEXT,
    kvk_number TEXT,
    iban TEXT,
    payment_term_days INTEGER,
    notes TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE chart_of_accounts (
    id INTEGER PRIMARY KEY,
    rgs_code TEXT NOT NULL UNIQUE,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('activa','passiva','omzet','kosten','btw')),
    vat_code TEXT,
    is_system INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE journal_entries (
    id INTEGER PRIMARY KEY,
    entry_date TEXT NOT NULL,
    description TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('factuur','inkoop','bank','handmatig','btw','opening','integratie')),
    source_ref TEXT,
    status TEXT NOT NULL DEFAULT 'definitief' CHECK (status IN ('definitief','teruggedraaid')),
    reverses_entry_id INTEGER REFERENCES journal_entries(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_journal_entries_date ON journal_entries(entry_date);

  CREATE TABLE journal_lines (
    id INTEGER PRIMARY KEY,
    journal_entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
    account_id INTEGER NOT NULL REFERENCES chart_of_accounts(id),
    debit INTEGER NOT NULL DEFAULT 0,
    credit INTEGER NOT NULL DEFAULT 0,
    relation_id INTEGER REFERENCES relations(id),
    vat_code TEXT,
    description TEXT,
    CHECK (debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0) AND (debit + credit) > 0)
  );
  CREATE INDEX idx_journal_lines_entry ON journal_lines(journal_entry_id);
  CREATE INDEX idx_journal_lines_account ON journal_lines(account_id);

  -- Journaalposten zijn onveranderlijk: correcties gaan via een tegenboeking.
  CREATE TRIGGER journal_lines_no_update BEFORE UPDATE ON journal_lines
  BEGIN SELECT RAISE(ABORT, 'Journaalregels zijn onveranderlijk; maak een tegenboeking'); END;
  CREATE TRIGGER journal_lines_no_delete BEFORE DELETE ON journal_lines
  BEGIN SELECT RAISE(ABORT, 'Journaalregels zijn onveranderlijk; maak een tegenboeking'); END;
  CREATE TRIGGER journal_entries_no_delete BEFORE DELETE ON journal_entries
  BEGIN SELECT RAISE(ABORT, 'Journaalposten kunnen niet verwijderd worden; maak een tegenboeking'); END;
  CREATE TRIGGER journal_entries_limited_update BEFORE UPDATE ON journal_entries
  WHEN NEW.entry_date IS NOT OLD.entry_date OR NEW.description IS NOT OLD.description
    OR NEW.source IS NOT OLD.source OR NEW.source_ref IS NOT OLD.source_ref
    OR NEW.reverses_entry_id IS NOT OLD.reverses_entry_id
  BEGIN SELECT RAISE(ABORT, 'Alleen de status van een journaalpost mag wijzigen'); END;

  CREATE TABLE templates (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('factuur','offerte')),
    html_template TEXT,
    logo TEXT,
    colors TEXT NOT NULL DEFAULT '{}',
    font TEXT NOT NULL DEFAULT 'Helvetica, Arial, sans-serif',
    text_blocks TEXT NOT NULL DEFAULT '{}',
    is_default INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE quotes (
    id INTEGER PRIMARY KEY,
    relation_id INTEGER NOT NULL REFERENCES relations(id),
    number TEXT UNIQUE,
    quote_date TEXT NOT NULL,
    valid_until TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'concept' CHECK (status IN ('concept','verzonden','geaccepteerd','afgewezen','gefactureerd')),
    template_id INTEGER REFERENCES templates(id),
    reference TEXT,
    intro TEXT,
    notes TEXT,
    sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE quote_lines (
    id INTEGER PRIMARY KEY,
    quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    description TEXT NOT NULL,
    quantity REAL NOT NULL,
    unit TEXT,
    unit_price INTEGER NOT NULL,
    vat_code TEXT NOT NULL,
    vat_percentage REAL NOT NULL
  );

  CREATE TABLE invoices (
    id INTEGER PRIMARY KEY,
    relation_id INTEGER NOT NULL REFERENCES relations(id),
    quote_id INTEGER REFERENCES quotes(id),
    credit_of_invoice_id INTEGER REFERENCES invoices(id),
    number TEXT UNIQUE,
    invoice_date TEXT NOT NULL,
    due_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'concept' CHECK (status IN ('concept','verzonden','betaald')),
    template_id INTEGER REFERENCES templates(id),
    reference TEXT,
    intro TEXT,
    notes TEXT,
    subtotal INTEGER,
    vat_total INTEGER,
    total INTEGER,
    amount_paid INTEGER NOT NULL DEFAULT 0,
    relation_snapshot TEXT,
    company_snapshot TEXT,
    journal_entry_id INTEGER REFERENCES journal_entries(id),
    sent_at TEXT,
    paid_at TEXT,
    reminder_count INTEGER NOT NULL DEFAULT 0,
    last_reminder_at TEXT,
    external_source TEXT,
    external_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (external_source, external_id)
  );

  CREATE TABLE invoice_lines (
    id INTEGER PRIMARY KEY,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    description TEXT NOT NULL,
    quantity REAL NOT NULL,
    unit TEXT,
    unit_price INTEGER NOT NULL,
    vat_code TEXT NOT NULL,
    vat_percentage REAL NOT NULL
  );

  CREATE TABLE purchase_invoices (
    id INTEGER PRIMARY KEY,
    relation_id INTEGER REFERENCES relations(id),
    supplier_reference TEXT,
    invoice_date TEXT NOT NULL,
    due_date TEXT,
    description TEXT NOT NULL,
    subtotal INTEGER NOT NULL,
    vat_total INTEGER NOT NULL,
    total INTEGER NOT NULL,
    amount_paid INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','betaald')),
    journal_entry_id INTEGER REFERENCES journal_entries(id),
    attachment_path TEXT,
    external_source TEXT,
    external_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (external_source, external_id)
  );

  CREATE TABLE purchase_invoice_lines (
    id INTEGER PRIMARY KEY,
    purchase_invoice_id INTEGER NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES chart_of_accounts(id),
    description TEXT,
    net_amount INTEGER NOT NULL,
    vat_code TEXT NOT NULL,
    vat_amount INTEGER NOT NULL
  );

  CREATE TABLE bank_accounts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    iban TEXT UNIQUE,
    account_id INTEGER NOT NULL REFERENCES chart_of_accounts(id)
  );

  CREATE TABLE import_batches (
    id INTEGER PRIMARY KEY,
    filename TEXT,
    source TEXT NOT NULL,
    imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    imported_count INTEGER NOT NULL DEFAULT 0,
    duplicate_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE bank_transactions (
    id INTEGER PRIMARY KEY,
    bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
    transaction_date TEXT NOT NULL,
    amount INTEGER NOT NULL,
    counter_iban TEXT,
    counter_name TEXT,
    description TEXT NOT NULL DEFAULT '',
    reference TEXT,
    source TEXT NOT NULL CHECK (source IN ('csv','mt940','camt','openbanking','handmatig')),
    import_batch_id INTEGER REFERENCES import_batches(id),
    dedup_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'nieuw' CHECK (status IN ('nieuw','gematcht','genegeerd')),
    matched_journal_entry_id INTEGER REFERENCES journal_entries(id),
    matched_invoice_id INTEGER REFERENCES invoices(id),
    matched_purchase_invoice_id INTEGER REFERENCES purchase_invoices(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_bank_transactions_status ON bank_transactions(status);

  CREATE TABLE csv_mappings (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    header_signature TEXT NOT NULL,
    mapping TEXT NOT NULL
  );

  CREATE TABLE vat_periods (
    id INTEGER PRIMARY KEY,
    period_key TEXT NOT NULL UNIQUE,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    vat_payable INTEGER NOT NULL,
    vat_receivable INTEGER NOT NULL,
    balance INTEGER NOT NULL,
    details TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'concept' CHECK (status IN ('concept','ingediend')),
    submitted_at TEXT,
    journal_entry_id INTEGER REFERENCES journal_entries(id)
  );

  CREATE TABLE email_log (
    id INTEGER PRIMARY KEY,
    document_type TEXT NOT NULL CHECK (document_type IN ('factuur','offerte','herinnering')),
    document_id INTEGER NOT NULL,
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('verzonden','mislukt')),
    error TEXT,
    message_id TEXT,
    sent_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE integrations (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 0,
    config TEXT NOT NULL DEFAULT '{}',
    last_sync_at TEXT,
    last_error TEXT
  );

  CREATE TABLE secrets (
    key TEXT PRIMARY KEY,
    value BLOB NOT NULL
  );
  `,
  /* 2: klussen, documentinbox, leveranciersgeheugen */ `
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    relation_id INTEGER NOT NULL REFERENCES relations(id),
    quote_id INTEGER REFERENCES quotes(id),
    title TEXT NOT NULL,
    address TEXT,
    status TEXT NOT NULL DEFAULT 'gepland' CHECK (status IN ('gepland','bezig','klaar','gefactureerd','geannuleerd')),
    start_date TEXT,
    end_date TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  ALTER TABLE invoices ADD COLUMN job_id INTEGER REFERENCES jobs(id);
  ALTER TABLE purchase_invoices ADD COLUMN job_id INTEGER REFERENCES jobs(id);
  ALTER TABLE purchase_invoices ADD COLUMN document_id INTEGER;

  -- Binnengekomen documenten (bonnetjes, inkoopfacturen) en wat eruit gehaald is.
  CREATE TABLE documents (
    id INTEGER PRIMARY KEY,
    file_path TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    sha256 TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'nieuw' CHECK (status IN ('nieuw','controle','verwerkt','genegeerd')),
    extraction_source TEXT,
    result TEXT,
    classification TEXT,
    confidence TEXT CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
    issues TEXT NOT NULL DEFAULT '[]',
    purchase_invoice_id INTEGER REFERENCES purchase_invoices(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Deterministisch geheugen: wat heeft de gebruiker eerder bevestigd voor deze leverancier?
  CREATE TABLE supplier_rules (
    id INTEGER PRIMARY KEY,
    supplier_key TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    category_key TEXT NOT NULL,
    vat_code TEXT NOT NULL,
    business INTEGER NOT NULL DEFAULT 1,
    confirmations INTEGER NOT NULL DEFAULT 0,
    corrections INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  /* 3: officiële RGS-referentiecodes (RGS-taxonomie 20251210) naast de interne sleutel */ `
  ALTER TABLE chart_of_accounts ADD COLUMN rgs_ref TEXT;
  UPDATE chart_of_accounts SET rgs_ref = 'BLimKasKas' WHERE rgs_code = 'BLiqKas';
  UPDATE chart_of_accounts SET rgs_ref = 'BLimBanRba' WHERE rgs_code = 'BLiqBanRba';
  UPDATE chart_of_accounts SET rgs_ref = 'BLimKruSto' WHERE rgs_code = 'BLiqKru';
  UPDATE chart_of_accounts SET rgs_ref = 'BVorTusTonTcv' WHERE rgs_code = 'BLiqKruPsp';
  UPDATE chart_of_accounts SET rgs_ref = 'BVorDebHad' WHERE rgs_code = 'BVorDebHad';
  UPDATE chart_of_accounts SET rgs_ref = 'BMvaTevVvp' WHERE rgs_code = 'BMvaTraVrt';
  UPDATE chart_of_accounts SET rgs_ref = 'BMvaBeiVvp' WHERE rgs_code = 'BMvaBedIna';
  UPDATE chart_of_accounts SET rgs_ref = 'BEivKapOnd' WHERE rgs_code = 'BEivKap';
  UPDATE chart_of_accounts SET rgs_ref = 'BEivKapProOvp' WHERE rgs_code = 'BEivPriPrv';
  UPDATE chart_of_accounts SET rgs_ref = 'BEivKapPrsOps' WHERE rgs_code = 'BEivPriStr';
  UPDATE chart_of_accounts SET rgs_ref = 'BSchCreHac' WHERE rgs_code = 'BSchCreHac';
  UPDATE chart_of_accounts SET rgs_ref = 'BSchTusTovTvp' WHERE rgs_code = 'BSchOvsVrp';
  UPDATE chart_of_accounts SET rgs_ref = 'BSchBepBtwOla' WHERE rgs_code = 'BSchBepBtwAfdHoo';
  UPDATE chart_of_accounts SET rgs_ref = 'BSchBepBtwOlt' WHERE rgs_code = 'BSchBepBtwAfdLaa';
  UPDATE chart_of_accounts SET rgs_ref = 'BSchBepBtwOlw' WHERE rgs_code = 'BSchBepBtwAfdVer';
  UPDATE chart_of_accounts SET rgs_ref = 'BSchBepBtwVoo' WHERE rgs_code = 'BSchBepBtwVoo';
  UPDATE chart_of_accounts SET rgs_ref = 'BSchBepBtwAfo' WHERE rgs_code = 'BSchBepBtwAfr';
  UPDATE chart_of_accounts SET rgs_ref = 'WOmzNodOdh' WHERE rgs_code = 'WOmzNopOlh';
  UPDATE chart_of_accounts SET rgs_ref = 'WOmzNodOdl' WHERE rgs_code = 'WOmzNopOll';
  UPDATE chart_of_accounts SET rgs_ref = 'WOmzNodOdg' WHERE rgs_code = 'WOmzNopOln';
  UPDATE chart_of_accounts SET rgs_ref = 'WOmzNodOdg' WHERE rgs_code = 'WOmzNopOlv';
  UPDATE chart_of_accounts SET rgs_ref = 'WOmzNodNod' WHERE rgs_code = 'WOmzNopOvr';
  UPDATE chart_of_accounts SET rgs_ref = 'WKprInpInp' WHERE rgs_code = 'WKprInkMat';
  UPDATE chart_of_accounts SET rgs_ref = 'WKprKuwKuw' WHERE rgs_code = 'WKprKuwKuw';
  UPDATE chart_of_accounts SET rgs_ref = 'WBedHuiBeh' WHERE rgs_code = 'WBedHuiHur';
  UPDATE chart_of_accounts SET rgs_ref = 'WBedAutBra' WHERE rgs_code = 'WBedAutBra';
  UPDATE chart_of_accounts SET rgs_ref = 'WBedAutRoa' WHERE rgs_code = 'WBedAutOnd';
  UPDATE chart_of_accounts SET rgs_ref = 'WBedKanKan' WHERE rgs_code = 'WBedKanKan';
  UPDATE chart_of_accounts SET rgs_ref = 'WBedKanTef' WHERE rgs_code = 'WBedKanTel';
  UPDATE chart_of_accounts SET rgs_ref = 'WBedKanSof' WHERE rgs_code = 'WBedKanSof';
  UPDATE chart_of_accounts SET rgs_ref = 'WBedVkkRea' WHERE rgs_code = 'WBedVkkRec';
  UPDATE chart_of_accounts SET rgs_ref = 'WBedEemGsk' WHERE rgs_code = 'WBedAlkGer';
  UPDATE chart_of_accounts SET rgs_ref = 'WBedAssOva' WHERE rgs_code = 'WBedAlkVer';
  UPDATE chart_of_accounts SET rgs_ref = 'WBedAeaAdv' WHERE rgs_code = 'WBedAlkAdv';
  UPDATE chart_of_accounts SET rgs_ref = 'WBedOvpWkv' WHERE rgs_code = 'WBedAlkWkl';
  UPDATE chart_of_accounts SET rgs_ref = 'WBedAlkOal' WHERE rgs_code = 'WBedAlkOvr';
  UPDATE chart_of_accounts SET rgs_ref = 'WBedAdlBet' WHERE rgs_code = 'WBedAlkBev';
  UPDATE chart_of_accounts SET rgs_ref = 'WBedAdlBan' WHERE rgs_code = 'WFbeBan';
  -- extra bankrekeningen (interne sleutel BLiqBanRba2..6) → RGS 'Rekening-courant bank - Naam A..E'
  UPDATE chart_of_accounts SET rgs_ref = 'BLimBanRb' || char(96 + CAST(substr(rgs_code, 11) AS INTEGER)) WHERE rgs_code GLOB 'BLiqBanRba[2-6]';
  `,
  /* 4: per import en per bankrekening de periode die het afschrift besloeg */ `
  CREATE TABLE import_batch_accounts (
    batch_id INTEGER NOT NULL REFERENCES import_batches(id),
    bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
    period_from TEXT NOT NULL,
    period_to TEXT NOT NULL,
    transactions INTEGER NOT NULL,
    imported INTEGER NOT NULL,
    duplicates INTEGER NOT NULL,
    PRIMARY KEY (batch_id, bank_account_id)
  );
  INSERT INTO import_batch_accounts (batch_id, bank_account_id, period_from, period_to, transactions, imported, duplicates)
    SELECT import_batch_id, bank_account_id, MIN(transaction_date), MAX(transaction_date), COUNT(*), COUNT(*), 0
    FROM bank_transactions WHERE import_batch_id IS NOT NULL GROUP BY import_batch_id, bank_account_id;
  `,
  /* 5: btw-correcties naar een open periode, dubbele documenten, opt-in voor automatisch verwerken */ `
  -- Datum waarop het btw-effect van een post meetelt. Wijkt af van entry_date als de periode
  -- van entry_date al is aangegeven; vat_correction_of noemt dan die periode.
  ALTER TABLE journal_entries ADD COLUMN vat_date TEXT;
  ALTER TABLE journal_entries ADD COLUMN vat_correction_of TEXT;
  ALTER TABLE documents ADD COLUMN duplicate_of_document_id INTEGER REFERENCES documents(id);
  -- 0 = nog niet gevraagd, 1 = gebruiker wil automatisch, -1 = gebruiker wil blijven kiezen
  ALTER TABLE supplier_rules ADD COLUMN auto_approved INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE automation_log (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    kind TEXT NOT NULL,
    ref_id INTEGER,
    summary TEXT NOT NULL,
    reason TEXT NOT NULL
  );
  -- De btw-toewijzing van een post is net zo onveranderlijk als de post zelf.
  CREATE TRIGGER journal_entries_vat_no_update BEFORE UPDATE ON journal_entries
  WHEN NEW.vat_date IS NOT OLD.vat_date OR NEW.vat_correction_of IS NOT OLD.vat_correction_of
  BEGIN SELECT RAISE(ABORT, 'De btw-periode van een journaalpost ligt vast; maak een tegenboeking'); END;
  -- Ingediende suppletie-aangiftes: posten met vat_correction_of = correction_period_key en
  -- id <= max_entry_id zijn daarmee afgehandeld en tellen niet meer mee in een gewone aangifte.
  CREATE TABLE vat_suppleties (
    id INTEGER PRIMARY KEY,
    correction_period_key TEXT NOT NULL,
    btw INTEGER NOT NULL,
    max_entry_id INTEGER NOT NULL,
    journal_entry_id INTEGER REFERENCES journal_entries(id),
    submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  /* 6: autopilot, beslissingen en uitleg, controles vóór de btw-aangifte */ `
  -- actor: wie deed het (systeem/gebruiker); status: auto, done_by_user of klopt_niet;
  -- details: gestructureerde signalen en beslissingen (JSON) achter de uitleg in 'reason'
  ALTER TABLE automation_log ADD COLUMN actor TEXT NOT NULL DEFAULT 'systeem';
  ALTER TABLE automation_log ADD COLUMN status TEXT NOT NULL DEFAULT 'auto';
  ALTER TABLE automation_log ADD COLUMN details TEXT;
  ALTER TABLE automation_log ADD COLUMN corrected_at TEXT;
  -- beslissingen per veld en per keuze bij een document (#21)
  ALTER TABLE documents ADD COLUMN decisions TEXT;
  -- bewust overgeslagen taken; komen terug als de situatie (fingerprint) verandert
  CREATE TABLE task_skips (
    task_key TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- hoe vaak de gebruiker een automatische beslissing corrigeert, per soort
  CREATE TABLE decision_stats (
    kind TEXT PRIMARY KEY,
    automatic INTEGER NOT NULL DEFAULT 0,
    corrected INTEGER NOT NULL DEFAULT 0
  );
  `,
  /* 7: gebeurtenissen als bron van waarheid (#19) */ `
  -- Wat er gebeurd is, met herkomst. De boekhouding wordt er deterministisch uit gegenereerd
  -- (src/core-ledger/rules.ts). Een correctie maakt een nieuwe gebeurtenis die de oude vervangt.
  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    event_date TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'actief' CHECK (status IN ('actief','vervangen')),
    rules_version TEXT NOT NULL,
    supersedes_event_id INTEGER REFERENCES events(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE event_evidence (
    id INTEGER PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id),
    kind TEXT NOT NULL,
    ref_id INTEGER,
    note TEXT,
    confidence REAL
  );
  CREATE INDEX idx_event_evidence_event ON event_evidence(event_id);
  ALTER TABLE journal_entries ADD COLUMN event_id INTEGER REFERENCES events(id);
  ALTER TABLE journal_entries ADD COLUMN rules_version TEXT;

  -- Backfill: elke bestaande post wordt een gebeurtenis "boeking" met precies zijn eigen regels,
  -- zodat saldi niet veranderen. Tegenboekingen horen bij de gebeurtenis van het origineel.
  INSERT INTO events (id, type, event_date, payload, rules_version, created_at)
  SELECT e.id, 'boeking', e.entry_date,
         json_object('date', e.entry_date, 'description', e.description, 'source', e.source, 'sourceRef', e.source_ref,
           'lines', (SELECT json_group_array(json_object('account', a.rgs_code, 'debit', l.debit, 'credit', l.credit,
                       'relationId', l.relation_id, 'vatCode', l.vat_code, 'description', l.description))
                     FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.journal_entry_id = e.id)),
         'backfill', e.created_at
  FROM journal_entries e WHERE e.reverses_entry_id IS NULL;
  UPDATE journal_entries SET event_id = id, rules_version = 'backfill' WHERE reverses_entry_id IS NULL;
  UPDATE journal_entries SET event_id = (SELECT o.event_id FROM journal_entries o WHERE o.id = journal_entries.reverses_entry_id), rules_version = 'backfill'
   WHERE reverses_entry_id IS NOT NULL;
  INSERT INTO event_evidence (event_id, kind, ref_id, note)
  SELECT id, kind, CASE WHEN kind = 'bron' THEN NULL ELSE CAST(rest AS INTEGER) END, ref
  FROM (
    SELECT id, json_extract(payload, '$.sourceRef') AS ref,
           substr(json_extract(payload, '$.sourceRef'), instr(json_extract(payload, '$.sourceRef'), ':') + 1) AS rest,
           CASE substr(json_extract(payload, '$.sourceRef'), 1, instr(json_extract(payload, '$.sourceRef'), ':') - 1)
             WHEN 'invoice' THEN 'factuur' WHEN 'purchase' THEN 'inkoop' WHEN 'bank' THEN 'bank' ELSE 'bron' END AS kind
    FROM events WHERE json_extract(payload, '$.sourceRef') IS NOT NULL
  );

  -- De herkomst van een post ligt vast zodra hij gezet is.
  CREATE TRIGGER journal_entries_event_no_update BEFORE UPDATE ON journal_entries
  WHEN OLD.event_id IS NOT NULL AND (NEW.event_id IS NOT OLD.event_id OR NEW.rules_version IS NOT OLD.rules_version)
  BEGIN SELECT RAISE(ABORT, 'De herkomst van een journaalpost ligt vast'); END;
  `,
  /* 8: terugkerende kosten, betalen met QR, belastingpotje */ `
  -- Het IBAN waar deze inkoop naartoe betaald moet worden (van het document); voor de fraudecontrole
  ALTER TABLE purchase_invoices ADD COLUMN payee_iban TEXT;
  -- Vaste lasten en abonnementen (#30). counter_key: IBAN of genormaliseerde naam.
  CREATE TABLE recurring_series (
    id INTEGER PRIMARY KEY,
    counter_key TEXT NOT NULL UNIQUE,
    counter_name TEXT NOT NULL,
    interval TEXT NOT NULL CHECK (interval IN ('maand','kwartaal','jaar')),
    amount INTEGER NOT NULL,
    amount_min INTEGER NOT NULL,
    amount_max INTEGER NOT NULL,
    category_key TEXT,
    vat_code TEXT,
    expects_invoice INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'voorgesteld' CHECK (status IN ('voorgesteld','actief','afgewezen','gestopt')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  /* 9: zoeken (#26) */ searchMigration(),
  /* 10: klussen als dossier (#32) */ `
  -- Alles kan aan een klus hangen: via de gebeurtenis (#19), niet alleen inkoopfacturen.
  ALTER TABLE events ADD COLUMN job_id INTEGER REFERENCES jobs(id);
  UPDATE events SET job_id = (
    SELECT p.job_id FROM purchase_invoices p
    WHERE p.journal_entry_id IN (SELECT id FROM journal_entries WHERE event_id = events.id) AND p.job_id IS NOT NULL LIMIT 1
  );
  -- Werkbon: uren en materiaal op de klus, vult later de factuurregels.
  CREATE TABLE job_work_items (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    work_date TEXT NOT NULL,
    description TEXT NOT NULL,
    quantity REAL NOT NULL,
    unit TEXT,
    unit_price INTEGER NOT NULL,
    vat_code TEXT NOT NULL,
    invoice_id INTEGER REFERENCES invoices(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Locatie (alleen na toestemming, alleen lokaal): klus en foto van de bon.
  ALTER TABLE jobs ADD COLUMN lat REAL;
  ALTER TABLE jobs ADD COLUMN lon REAL;
  ALTER TABLE documents ADD COLUMN gps_lat REAL;
  ALTER TABLE documents ADD COLUMN gps_lon REAL;
  `,
  /* 11: belastingvoordelen: bedrijfsmiddelen, afschrijving, kilometers, uren */ `
  -- Bedrijfsmiddelen: afgeleid uit de journaalregels op een activarekening (elke manier van boeken).
  CREATE TABLE assets (
    id INTEGER PRIMARY KEY,
    journal_line_id INTEGER NOT NULL UNIQUE REFERENCES journal_lines(id),
    account_rgs TEXT NOT NULL,
    name TEXT NOT NULL,
    acquired_on TEXT NOT NULL,
    cost INTEGER NOT NULL,
    residual INTEGER NOT NULL DEFAULT 0,
    lifetime_months INTEGER NOT NULL DEFAULT 60,
    -- 1 = telt niet mee voor de investeringsaftrek (bv. personenauto)
    kia_excluded INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'actief' CHECK (status IN ('actief','verkocht','vervallen')),
    disposed_on TEXT,
    proceeds INTEGER,
    disposal_entry_id INTEGER REFERENCES journal_entries(id),
    -- afschrijving tot en met dit jaar is buiten de app gedaan (bestaande administratie); null = alles in de app
    booked_elsewhere_until INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Bestaande administratie: jaren vóór deze update boekt de app niet vanzelf (misschien al aangegeven,
  -- of door de boekhouder buiten de app afgeschreven). Nieuwe administraties: geen beperking.
  INSERT INTO settings (key, value) SELECT 'counter:depreciation-since', strftime('%Y', 'now') WHERE EXISTS (SELECT 1 FROM journal_entries);
  -- Geboekte afschrijving per bedrijfsmiddel per jaar (één post per jaar, of tot de verkoopdatum).
  CREATE TABLE asset_depreciation (
    asset_id INTEGER NOT NULL REFERENCES assets(id),
    year INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    journal_entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
    PRIMARY KEY (asset_id, year)
  );
  -- Zakelijke kilometers met de privéauto: € per km als kosten, tegen privé gestort.
  CREATE TABLE trips (
    id INTEGER PRIMARY KEY,
    trip_date TEXT NOT NULL,
    km REAL NOT NULL CHECK (km > 0),
    description TEXT NOT NULL,
    job_id INTEGER REFERENCES jobs(id),
    rate INTEGER NOT NULL,
    journal_entry_id INTEGER REFERENCES journal_entries(id),
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Uren voor het urencriterium die niet op een werkbon staan (administratie, offertes, reizen …).
  CREATE TABLE time_entries (
    id INTEGER PRIMARY KEY,
    entry_date TEXT NOT NULL,
    hours REAL NOT NULL CHECK (hours > 0),
    description TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  /* 12: eigen en aangepaste kostencategorieën */ `
  -- Alleen afwijkingen van de ingebouwde lijst (naam, uitleg, btw, verborgen) en eigen categorieën.
  -- Een eigen categorie boekt op de rekening van een ingebouwde categorie ("hoort bij"), zodat de
  -- grootboekrekeningen (RGS) voor de boekhouder hetzelfde blijven. Nooit verwijderen: alleen verbergen.
  CREATE TABLE expense_categories (
    key TEXT PRIMARY KEY,
    built_in INTEGER NOT NULL DEFAULT 0,
    label TEXT,
    hint TEXT,
    default_vat TEXT,
    group_key TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  /* 13: inkomende post (IMAP) */ `
  -- Per map: tot welke UID we gelezen hebben. Verandert UIDVALIDITY (map opnieuw aangemaakt), dan
  -- beginnen we opnieuw; dubbele berichten worden dan herkend aan de Message-ID.
  CREATE TABLE mail_folders (
    folder TEXT PRIMARY KEY,
    uid_validity TEXT NOT NULL,
    last_uid INTEGER NOT NULL DEFAULT 0,
    checked_at TEXT,
    -- een bericht dat niet te lezen was: later opnieuw proberen, na 3 keer overslaan
    failed_uid INTEGER,
    failed_count INTEGER NOT NULL DEFAULT 0
  );
  -- Elk bericht dat de app gezien heeft, ook als het gelezen, gearchiveerd of verplaatst is.
  CREATE TABLE mail_messages (
    id INTEGER PRIMARY KEY,
    message_key TEXT NOT NULL UNIQUE,
    folder TEXT NOT NULL,
    uid INTEGER NOT NULL,
    from_address TEXT,
    from_name TEXT,
    subject TEXT,
    received_on TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('bijlage','online-factuur','klant','eigen','overig','fout')),
    relation_id INTEGER REFERENCES relations(id),
    link_domain TEXT,
    document_ids TEXT NOT NULL DEFAULT '[]',
    note TEXT,
    moved_to TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX mail_messages_outcome ON mail_messages (outcome, created_at);
  `,
  /* 14: mail van je eigen adres opnieuw bekijken */ `
  -- Tot nu toe werd alle mail van je eigen adres overgeslagen, ook een factuur die je zelf doorstuurde.
  -- Nu alleen nog een kopie van je eigen factuur/offerte. Wat eerder als "eigen" is overgeslagen, wordt
  -- nog één keer bekeken (de rest is herkenbaar aan de Message-ID en komt niet dubbel).
  DELETE FROM mail_messages WHERE outcome = 'eigen';
  UPDATE mail_folders SET last_uid = 0, failed_uid = NULL, failed_count = 0;
  `,
  /* 15: potjes zonder eigen rekeningnummer */ `
  -- Een potje binnen je bank (bv. Knab) heeft geen IBAN, net als een gewone rekening waarvan het nummer
  -- nog niet bekend is. Dit veld houdt ze uit elkaar: een afschrift met een onbekend IBAN komt nooit op een potje.
  ALTER TABLE bank_accounts ADD COLUMN is_pot INTEGER NOT NULL DEFAULT 0;
  `,
  /* 16: vreemde valuta (#74) */ `
  -- ECB-koersen die de app ophaalde (alleen als er een bon in een andere munt was)
  CREATE TABLE fx_rates (
    currency TEXT NOT NULL,
    rate_date TEXT NOT NULL,
    rate REAL NOT NULL,
    PRIMARY KEY (currency, rate_date)
  );
  -- Een aankoop in bv. dollars: in de boekhouding in euro's, het oorspronkelijke bedrag en de koers als uitleg
  ALTER TABLE purchase_invoices ADD COLUMN currency TEXT;
  ALTER TABLE purchase_invoices ADD COLUMN foreign_total INTEGER;
  ALTER TABLE purchase_invoices ADD COLUMN fx_rate REAL;
  `,
  /* 17: overstappen met een lopende administratie */ `
  -- Wat er al was op de instapdatum (de startbalans): openstaande facturen van klanten, rekeningen die
  -- nog betaald moesten worden, bus en gereedschap, btw, leningen, en bij instappen midden in het jaar
  -- de omzet en kosten tot dan. Elke regel heeft een eigen beginbalansboeking tegen eigen vermogen.
  CREATE TABLE opening_items (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('klant','leverancier','bezit','btw','lening','vordering','schuld','resultaat','btw-periode')),
    description TEXT NOT NULL,
    -- positief = iets van jou of wat je nog krijgt; negatief = wat je nog moet betalen (bij resultaat: de winst)
    amount INTEGER NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    journal_entry_id INTEGER REFERENCES journal_entries(id),
    invoice_id INTEGER REFERENCES invoices(id),
    purchase_invoice_id INTEGER REFERENCES purchase_invoices(id),
    asset_id INTEGER REFERENCES assets(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Een factuur of rekening uit de vorige administratie: telt niet als omzet of kosten in deze app
  ALTER TABLE invoices ADD COLUMN is_opening INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE purchase_invoices ADD COLUMN is_opening INTEGER NOT NULL DEFAULT 0;
  -- Bus of gereedschap dat er al was: afschrijven vanaf de boekwaarde, geen investeringsaftrek
  ALTER TABLE assets ADD COLUMN is_opening INTEGER NOT NULL DEFAULT 0;
  -- Eindsaldo volgens het afschrift (CAMT/MT940): om te controleren of er afschriften ontbreken
  ALTER TABLE import_batch_accounts ADD COLUMN closing_balance INTEGER;
  ALTER TABLE import_batch_accounts ADD COLUMN closing_date TEXT;
  -- Bestaande administraties zijn al ingericht: de vraag "overstappen?" niet alsnog stellen
  INSERT OR IGNORE INTO settings (key, value)
    SELECT 'switchover', '{"mode":"nieuw","date":null,"status":"klaar","provisional":false,"filedElsewhere":[],"dismissed":[],"bankConfirmed":[],"bankChecks":{},"accountantEquity":null}'
    WHERE EXISTS (SELECT 1 FROM journal_entries);
  `,
  /* 18: fiscale review — ingebruikname, overbrengen naar privé, vastgelegde KIA per jaar */ `
  -- afschrijving begint bij ingebruikname (NULL = de aankoopdatum)
  ALTER TABLE assets ADD COLUMN in_use_on TEXT;
  -- 'verkocht' of 'prive' (overgebracht naar privévermogen: telt als vervreemding)
  ALTER TABLE assets ADD COLUMN disposal_kind TEXT;
  -- de KIA zoals die voor een afgesloten jaar is toegepast; basis voor de desinvesteringsbijtelling
  CREATE TABLE kia_applied (
    year INTEGER PRIMARY KEY,
    investments INTEGER NOT NULL,
    kia INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  /* 19: leverancier die je altijd privé (of contant) betaalt */ `
  -- bv. een abonnement dat van je privérekening of via je telefoonrekening gaat: nieuwe rekeningen
  -- van deze leverancier staan meteen op betaald (Crediteuren aan Privé-stortingen of Kas)
  ALTER TABLE relations ADD COLUMN paid_with TEXT CHECK (paid_with IN ('kas','prive'));
  `,
  /* 20: zakelijk deel per leverancier (gemengd gebruik) */ `
  -- bv. Dropbox 50% zakelijk: bij het boeken gaat het privédeel naar privé, zonder btw-aftrek.
  -- Geen regel = 100% zakelijk.
  CREATE TABLE supplier_business_share (
    supplier_key TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    pct INTEGER NOT NULL CHECK (pct BETWEEN 1 AND 99),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  /* 21: vaste identiteit van de administratie (uitwisseling met de boekhouder) */ `
  -- Een willekeurige UUID (versie 4), één keer per administratie. Gaat mee in back-ups en exports, zodat
  -- een pakket van de boekhouder alleen bij deze administratie past. Niet te wijzigen via de instellingen.
  INSERT OR IGNORE INTO settings (key, value) VALUES ('administrationId', '"' ||
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))) || '"');
  `,
  /* 22: periodeslot — afgewerkt is afgewerkt (docs/uitwisseling.md) */ `
  -- Alles t/m until_date ligt vast. 'afgesloten' is definitief; 'uitwisseling' loopt zolang de periode
  -- bij de boekhouder ligt en wordt 'afgesloten' als zijn antwoord is ingelezen (of vervalt bij afbreken).
  CREATE TABLE ledger_locks (
    id INTEGER PRIMARY KEY,
    until_date TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('uitwisseling','afgesloten')),
    exchange_no INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at TEXT
  );
  -- Eén rij zolang het antwoord van de boekhouder of een migratie wordt ingelezen: dan geldt het slot niet.
  CREATE TABLE ledger_lock_bypass (id INTEGER PRIMARY KEY CHECK (id = 1));

  -- Geen nieuwe posten t/m het slot. Uitzondering: de btw-aangifte (geboekt op de laatste dag van de
  -- btw-periode; correcties gaan via de btw-datum naar de volgende periode).
  CREATE TRIGGER journal_entries_period_lock BEFORE INSERT ON journal_entries
  WHEN NEW.source <> 'btw' AND NOT EXISTS (SELECT 1 FROM ledger_lock_bypass)
    AND NEW.entry_date <= (SELECT MAX(until_date) FROM ledger_locks)
  BEGIN SELECT RAISE(ABORT, 'Deze periode is afgesloten: boek dit na de afgesloten periode'); END;

  -- Zolang de periode bij de boekhouder ligt, blijft hij precies zoals de boekhouder hem kreeg: ook niets
  -- terugdraaien of vervangen. Na het afsluiten mag dat wel, met de correctie in een open periode.
  CREATE TRIGGER journal_entries_exchange_status BEFORE UPDATE OF status ON journal_entries
  WHEN OLD.source <> 'btw' AND NOT EXISTS (SELECT 1 FROM ledger_lock_bypass)
    AND OLD.entry_date <= (SELECT MAX(until_date) FROM ledger_locks WHERE kind = 'uitwisseling')
  BEGIN SELECT RAISE(ABORT, 'Deze periode ligt bij je boekhouder'); END;
  CREATE TRIGGER events_exchange_status BEFORE UPDATE OF status ON events
  WHEN NOT EXISTS (SELECT 1 FROM ledger_lock_bypass)
    AND OLD.event_date <= (SELECT MAX(until_date) FROM ledger_locks WHERE kind = 'uitwisseling')
  BEGIN SELECT RAISE(ABORT, 'Deze periode ligt bij je boekhouder'); END;

  -- Afgesloten is definitief: niet te verwijderen, te verschuiven of terug te zetten.
  CREATE TRIGGER ledger_locks_final_delete BEFORE DELETE ON ledger_locks WHEN OLD.kind = 'afgesloten'
  BEGIN SELECT RAISE(ABORT, 'Een afgesloten periode kan niet heropend worden'); END;
  CREATE TRIGGER ledger_locks_final_update BEFORE UPDATE ON ledger_locks WHEN OLD.kind = 'afgesloten'
  BEGIN SELECT RAISE(ABORT, 'Een afgesloten periode kan niet heropend worden'); END;
  `,
  /* 23: handelingen van de boekhouder in de kopie van een klant (antwoord van de uitwisseling) */ `
  -- Alleen gevuld in een kopie bij de boekhouder: wat hij deed, in volgorde. Het antwoord aan de klant
  -- is deze lijst; de app van de klant voert ze opnieuw uit. 'created' zijn de journaalposten die de
  -- handeling hier maakte, zodat een latere handeling ernaar kan verwijzen.
  CREATE TABLE exchange_actions (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    input TEXT NOT NULL,
    created TEXT NOT NULL DEFAULT '[]',
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  /* 24: wie deed het voorstel, en nam de gebruiker het over? (evaluatie van regels/AI, #132) */ `
  -- Alleen tellers per voorsteller en model: geen inhoud van documenten en niets van wat er naar een
  -- online dienst ging. Bijgewerkt als de gebruiker een bon bevestigt (niet bij automatisch verwerken).
  CREATE TABLE proposal_stats (
    proposed_by TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    accepted INTEGER NOT NULL DEFAULT 0,
    corrected INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (proposed_by, model)
  );
  `,
  /* 25: betrouwbaar inlezen (#184): een betaling die er al staat, komt er niet nog een keer in */ `
  -- De id die de bank zelf aan een betaling gaf (CAMT, MT940). Tot nu toe zat die alleen in dedup_hash.
  -- Betalingen die al waren ingelezen hebben hem niet (NULL) en tellen als "zonder bank-id"; hun
  -- dedup_hash blijft zoals hij was, zodat hetzelfde afschrift opnieuw inlezen niets dubbel geeft.
  ALTER TABLE bank_transactions ADD COLUMN bank_id TEXT;
  CREATE INDEX idx_bank_transactions_amount ON bank_transactions(bank_account_id, amount, transaction_date);
  -- Het soort afschrift van een import: de bron, en bij CSV ook de indeling (kolommen en toewijzing).
  -- Twee afschriften van hetzelfde soort geven dezelfde betaling dezelfde hash; bij een ander soort
  -- zoekt de app de betaling op bedrag, tegenrekening en datum. Oude imports: NULL (soort onbekend).
  ALTER TABLE import_batches ADD COLUMN kind TEXT;

  -- Regels uit een afschrift die niet zijn toegevoegd omdat dezelfde betaling er al stond uit een ander
  -- soort afschrift (andere hash, zelfde betaling). matched_transaction_id is de betaling die er al stond
  -- (de tegenhanger): die telt per soort afschrift maar voor één overgeslagen regel. Met "Toch toevoegen"
  -- komt de regel er alsnog in (added_transaction_id) en is de tegenhanger weer vrij.
  CREATE TABLE import_skipped (
    id INTEGER PRIMARY KEY,
    batch_id INTEGER NOT NULL REFERENCES import_batches(id),
    bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
    transaction_date TEXT NOT NULL,
    amount INTEGER NOT NULL,
    counter_iban TEXT,
    counter_name TEXT,
    description TEXT NOT NULL DEFAULT '',
    reference TEXT,
    source TEXT NOT NULL,
    bank_id TEXT,
    dedup_hash TEXT NOT NULL UNIQUE,
    matched_transaction_id INTEGER NOT NULL REFERENCES bank_transactions(id),
    added_transaction_id INTEGER REFERENCES bank_transactions(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_import_skipped_matched ON import_skipped(matched_transaction_id);
  CREATE INDEX idx_import_skipped_batch ON import_skipped(batch_id);

  -- Welke dagen een import besloeg staat sinds migratie 4 in import_batch_accounts. Mocht er van een
  -- oude import toch geen regel zijn, dan alsnog uit de betalingen zelf (bestaande regels blijven staan).
  INSERT OR IGNORE INTO import_batch_accounts (batch_id, bank_account_id, period_from, period_to, transactions, imported, duplicates)
    SELECT import_batch_id, bank_account_id, MIN(transaction_date), MAX(transaction_date), COUNT(*), COUNT(*), 0
    FROM bank_transactions WHERE import_batch_id IS NOT NULL GROUP BY import_batch_id, bank_account_id;
  `,
  /* 26: afschriften uit de downloadmap (#184): de app ziet een gedownload afschrift en vraagt "Inlezen?" */ `
  -- Welk bestand een import was (hash van de inhoud). Een afschrift dat al is ingelezen, bijvoorbeeld door
  -- het in de app te slepen, vraagt de app niet nog een keer. Oude imports: NULL.
  ALTER TABLE import_batches ADD COLUMN content_hash TEXT;

  -- Bestanden in de map die de gebruiker koos (standaard uit; de map zelf staat in settings onder
  -- 'statementFolder'). file_key is een hash van map, naam, grootte en wijzigingstijd: zo leest de app niet
  -- elke keer alles opnieuw. Van een bestand dat geen afschrift van deze administratie is ('geen'),
  -- bewaren we alleen die hash: geen naam en geen inhoud. De app verplaatst of verwijdert nooit iets.
  CREATE TABLE statement_files (
    id INTEGER PRIMARY KEY,
    file_key TEXT NOT NULL UNIQUE,
    -- geen = geen afschrift van deze administratie; gevonden = de app vraagt "Inlezen?"; ingelezen;
    -- afgewezen = drie keer "Niet nu"; dubbel = zelfde inhoud als een ander bestand
    status TEXT NOT NULL CHECK (status IN ('geen','gevonden','ingelezen','afgewezen','dubbel')),
    -- staat het bestand er nog? (bijgewerkt bij elke keer kijken)
    present INTEGER NOT NULL DEFAULT 1,
    filename TEXT,
    content_hash TEXT,
    source TEXT,
    -- de namen van de rekeningen in het afschrift, voor de vraag op Vandaag
    accounts TEXT,
    period_from TEXT,
    period_to TEXT,
    transactions INTEGER,
    -- hoe vaak "Niet nu", en vanaf welke dag de app het weer vraagt
    declined INTEGER NOT NULL DEFAULT 0,
    ask_from TEXT,
    import_batch_id INTEGER REFERENCES import_batches(id),
    seen_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_statement_files_status ON statement_files(status);
  `,
  /* 27: bewijs als echte koppeling, afgewezen voorstellen en meldingen over dubbele documenten (#179) */ `
  -- Eén document hoort bij precies één aankoop of bankbetaling; een aankoop of betaling mag meer
  -- bestanden hebben, waarvan er precies één het hoofdbewijsstuk is. Dit is de enige bron voor
  -- "welke bon hoort waarbij": de uitlegtekst bij een document wordt daar nooit meer voor gelezen.
  -- origin: 'geboekt' = de aankoop is uit dit document geboekt, 'bewijs' = alleen als bewijs erbij
  -- gezet (niets geboekt), 'dubbel' = hetzelfde document nog een keer (niets geboekt).
  CREATE TABLE IF NOT EXISTS document_links (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL UNIQUE REFERENCES documents(id),
    purchase_invoice_id INTEGER REFERENCES purchase_invoices(id) ON DELETE CASCADE,
    bank_transaction_id INTEGER REFERENCES bank_transactions(id),
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
    origin TEXT NOT NULL CHECK (origin IN ('geboekt','bewijs','dubbel')),
    provenance TEXT NOT NULL DEFAULT 'gebruiker' CHECK (provenance IN ('gebruiker','automatisch','migratie')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK ((purchase_invoice_id IS NULL) <> (bank_transaction_id IS NULL))
  );
  CREATE INDEX IF NOT EXISTS idx_document_links_purchase ON document_links(purchase_invoice_id);
  CREATE INDEX IF NOT EXISTS idx_document_links_bank ON document_links(bank_transaction_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_document_links_primary_purchase ON document_links(purchase_invoice_id) WHERE is_primary = 1 AND purchase_invoice_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_document_links_primary_bank ON document_links(bank_transaction_id) WHERE is_primary = 1 AND bank_transaction_id IS NOT NULL;

  -- "Nee, andere aankoop": dit voorstel niet opnieuw doen. Geldt zolang leverancier, datum, bedrag en
  -- nummer van het document (fingerprint) gelijk blijven. candidate: 'aankoop:5', 'bank:7' of 'document:3'.
  CREATE TABLE IF NOT EXISTS document_proposal_rejections (
    document_id INTEGER NOT NULL REFERENCES documents(id),
    candidate TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (document_id, candidate)
  );

  -- Melding op Vandaag: een document dat zonder jou binnenkwam (e-mail) stond er al in.
  CREATE TABLE IF NOT EXISTS document_notices (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('stond-er-al','dubbel')),
    original_name TEXT NOT NULL,
    source TEXT NOT NULL,
    sender TEXT,
    existing_document_id INTEGER REFERENCES documents(id),
    purchase_invoice_id INTEGER,
    seen_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Bijlagen van een mail die al binnen zijn, zolang de mail nog niet helemaal verwerkt is: bij een
  -- nieuwe poging is zo'n bijlage geen "dubbel document".
  CREATE TABLE IF NOT EXISTS mail_attachment_progress (
    message_key TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    document_id INTEGER NOT NULL,
    PRIMARY KEY (message_key, sha256)
  );

  -- Wat er met elke oude tekstkoppeling ("bewijsstuk bij banktransactie #...") gebeurd is.
  -- Een bon die hierdoor op controle komt, beoordeelt de app daarna opnieuw (IntakeService.reassessMigrated):
  -- named_payments = de betalingen die de oude tekst noemde (alleen om een vraag te kunnen stellen, nooit
  -- als koppeling); reassessed_at = wanneer dat gebeurd is. Tot dan is de bon niet te boeken.
  CREATE TABLE IF NOT EXISTS document_link_migration (
    document_id INTEGER PRIMARY KEY REFERENCES documents(id),
    result TEXT NOT NULL CHECK (result IN ('gemigreerd','onzeker','conflict')),
    bank_transaction_id INTEGER,
    detail TEXT NOT NULL,
    named_payments TEXT,
    reassessed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 1. Bonnen die al bij een aankoop horen. De aankoop zelf verandert niet.
  INSERT OR IGNORE INTO document_links (document_id, purchase_invoice_id, is_primary, origin, provenance)
  SELECT d.id, p.id, CASE WHEN p.document_id = d.id THEN 1 ELSE 0 END,
         CASE
           WHEN d.duplicate_of_document_id IS NOT NULL OR d.status = 'genegeerd' THEN 'dubbel'
           WHEN EXISTS (SELECT 1 FROM event_evidence a JOIN event_evidence b ON b.event_id = a.event_id
                         WHERE a.kind = 'document' AND a.ref_id = d.id AND b.kind = 'inkoop' AND b.ref_id = p.id) THEN 'geboekt'
           -- van vóór de gebeurtenissen (#19): niet te zien of de bon later is toegevoegd; dan de voorzichtige keuze
           WHEN NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.id = p.journal_entry_id AND e.rules_version <> 'backfill') THEN 'geboekt'
           ELSE 'bewijs'
         END,
         'migratie'
  FROM documents d
  JOIN purchase_invoices p ON p.id = COALESCE(d.purchase_invoice_id, (SELECT MIN(p2.id) FROM purchase_invoices p2 WHERE p2.document_id = d.id));

  -- 2. Oude tekstkoppelingen aan een bankbetaling: per document vastleggen wat ermee gebeurt.
  WITH refs AS (
    SELECT d.id AS document_id, substr(j.value, length('bewijsstuk bij banktransactie #') + 1) AS rest
    FROM documents d, json_each(json_extract(CASE WHEN json_valid(d.classification) THEN d.classification ELSE '{}' END, '$.reasons')) j
    WHERE d.classification IS NOT NULL AND j.type = 'text' AND j.value LIKE 'bewijsstuk bij banktransactie #%'
  ),
  per_document AS (
    SELECT document_id, COUNT(DISTINCT rest) AS n,
           CASE WHEN MIN(rest) <> '' AND MIN(rest) NOT GLOB '*[^0-9]*' THEN CAST(MIN(rest) AS INTEGER) END AS bank_id
    FROM refs GROUP BY document_id
  ),
  judged AS (
    SELECT d.id AS document_id, r.bank_id,
           CASE
             WHEN r.n > 1 THEN 'meerdere'
             WHEN r.bank_id IS NULL THEN 'onleesbaar'
             WHEN EXISTS (SELECT 1 FROM document_links k WHERE k.document_id = d.id) THEN 'aankoop'
             WHEN d.status <> 'verwerkt' THEN 'status'
             WHEN b.id IS NULL THEN 'geen-betaling'
             WHEN b.matched_purchase_invoice_id IS NOT NULL OR b.matched_invoice_id IS NOT NULL THEN 'anders-gekoppeld'
             WHEN b.status <> 'gematcht' OR NOT EXISTS (
                    SELECT 1 FROM journal_entries e JOIN events ev ON ev.id = e.event_id
                     WHERE e.id = b.matched_journal_entry_id AND e.status = 'definitief') THEN 'niet-geboekt'
             ELSE 'ok'
           END AS why
    FROM per_document r JOIN documents d ON d.id = r.document_id
    LEFT JOIN bank_transactions b ON b.id = r.bank_id
  )
  INSERT OR IGNORE INTO document_link_migration (document_id, result, bank_transaction_id, detail)
  SELECT document_id,
         CASE why WHEN 'ok' THEN 'gemigreerd' WHEN 'meerdere' THEN 'conflict' WHEN 'aankoop' THEN 'conflict' WHEN 'anders-gekoppeld' THEN 'conflict' ELSE 'onzeker' END,
         bank_id,
         CASE why
           WHEN 'ok' THEN 'gekoppeld aan de betaling'
           WHEN 'meerdere' THEN 'er worden meerdere betalingen genoemd'
           WHEN 'onleesbaar' THEN 'het nummer van de betaling is niet te lezen'
           WHEN 'aankoop' THEN 'de bon hoort al bij een aankoop'
           WHEN 'status' THEN 'de bon stond niet (meer) op verwerkt'
           WHEN 'geen-betaling' THEN 'de betaling bestaat niet meer'
           WHEN 'anders-gekoppeld' THEN 'de betaling hoort intussen bij een aankoop of factuur'
           ELSE 'de betaling is niet (meer) geboekt'
         END
  FROM judged;

  INSERT OR IGNORE INTO document_links (document_id, bank_transaction_id, is_primary, origin, provenance)
  SELECT document_id, bank_transaction_id, 0, 'bewijs', 'migratie' FROM document_link_migration WHERE result = 'gemigreerd';

  -- 3. Een kopie van een document dat ergens bij hoort, hoort daar ook bij (beide bestanden blijven bewaard).
  INSERT OR IGNORE INTO document_links (document_id, purchase_invoice_id, bank_transaction_id, is_primary, origin, provenance)
  SELECT d.id, k.purchase_invoice_id, k.bank_transaction_id, 0, 'dubbel', 'migratie'
  FROM documents d JOIN document_links k ON k.document_id = d.duplicate_of_document_id
  WHERE d.status = 'genegeerd';
  UPDATE documents SET purchase_invoice_id = (SELECT k.purchase_invoice_id FROM document_links k WHERE k.document_id = documents.id)
  WHERE purchase_invoice_id IS NULL AND EXISTS (SELECT 1 FROM document_links k WHERE k.document_id = documents.id AND k.purchase_invoice_id IS NOT NULL);

  -- 4. Precies één hoofdbewijsstuk per aankoop of betaling. Wat al de bijlage van de aankoop was, blijft
  -- dat; anders het best leesbare bestand (PDF met e-factuur erin, PDF, foto, losse e-factuur), dan het oudste.
  UPDATE document_links SET is_primary = 1
  WHERE is_primary = 0
    AND NOT EXISTS (SELECT 1 FROM document_links o WHERE o.purchase_invoice_id IS document_links.purchase_invoice_id
                     AND o.bank_transaction_id IS document_links.bank_transaction_id AND o.is_primary = 1)
    AND id = (SELECT o.id FROM document_links o JOIN documents d ON d.id = o.document_id
               WHERE o.purchase_invoice_id IS document_links.purchase_invoice_id AND o.bank_transaction_id IS document_links.bank_transaction_id
               ORDER BY CASE WHEN d.mime_type = 'application/pdf' AND d.extraction_source = 'ubl' THEN 5
                             WHEN d.mime_type = 'application/pdf' AND d.extraction_source = 'pdf-text' THEN 4
                             WHEN d.mime_type = 'application/pdf' THEN 3
                             WHEN d.mime_type = 'application/xml' THEN 1 ELSE 2 END DESC, o.document_id
               LIMIT 1);

  -- 5. Onzeker of tegenstrijdig: niets koppelen en niets boeken. De bon komt bij "Nog controleren" met uitleg.
  UPDATE documents
     SET status = 'controle',
         issues = json_insert(CASE WHEN json_valid(issues) AND json_type(issues) = 'array' THEN issues ELSE '[]' END, '$[#]',
                    json_object('field', 'evidence-migration', 'severity', 'fout', 'message',
                      'Deze bon stond als bewijs bij een betaling, maar de app kan niet meer zeker zien bij welke. Kijk waar hij bij hoort. Aan je boekhouding is niets veranderd.'))
   WHERE status = 'verwerkt'
     AND id IN (SELECT document_id FROM document_link_migration WHERE result IN ('onzeker','conflict'))
     AND NOT EXISTS (SELECT 1 FROM document_links k WHERE k.document_id = documents.id);
  `,
  /* 28: bonnenscanner (#48): gekoppelde telefoons, ontvangen bonnen, en notitie en betaalwijze bij een document */ `
  -- Gekoppelde telefoons. De sleutel staat hier niet: die zit versleuteld in 'secrets' (scanner:key:<id>).
  -- expires_at (ms) alleen zolang de telefoon de QR-code nog niet gescand heeft.
  CREATE TABLE scanner_devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at INTEGER,
    paired_at TEXT,
    last_seen_at TEXT
  );
  -- Nonces van berichten binnen het tijdvenster: een bericht kan niet nog een keer ingestuurd worden,
  -- ook niet na opnieuw starten van de app.
  CREATE TABLE scanner_nonces (
    device_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    seen_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, nonce)
  );
  -- Bonnen van de telefoon, op het ID dat de telefoon eraan gaf: twee keer versturen geeft één document.
  -- 'wacht' = veilig opgeslagen in de wachtrij, nog niet in de inbox.
  CREATE TABLE scanner_documents (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'wacht' CHECK (state IN ('wacht','verwerkt','mislukt')),
    document_id INTEGER REFERENCES documents(id),
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    received_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Wat de telefoon erbij vertelde: een notitie, en hoe er betaald is (het voorstel bij het bevestigen).
  ALTER TABLE documents ADD COLUMN note TEXT;
  ALTER TABLE documents ADD COLUMN proposed_paid_with TEXT CHECK (proposed_paid_with IN ('bank','kas','prive','later'));
  `,
  /* 29: verzamelbetaling als één regel én als deelposten (#184): hetzelfde geld telt maar één keer */ `
  -- Een verzamelboeking staat in CAMT als losse deelposten en in CSV of MT940 als één regel met het totaal.
  -- batch_ref en batch_total zeggen welke deelposten bij één boeking horen en wat die boeking in totaal was.
  ALTER TABLE bank_transactions ADD COLUMN batch_ref TEXT;
  ALTER TABLE bank_transactions ADD COLUMN batch_total INTEGER;
  ALTER TABLE import_skipped ADD COLUMN batch_ref TEXT;
  ALTER TABLE import_skipped ADD COLUMN batch_total INTEGER;
  -- Stond zo'n bedrag er toch twee keer in, dan haalt de gebruiker één kant uit de boekhouding. Die regel
  -- blijft bestaan (status 'genegeerd', met hier de betaling die blijft), telt niet meer mee in het saldo
  -- volgens de afschriften en is terug te zetten. Er wordt nooit een betaling verwijderd.
  ALTER TABLE bank_transactions ADD COLUMN duplicate_of INTEGER REFERENCES bank_transactions(id);
  CREATE INDEX idx_bank_transactions_batch ON bank_transactions(bank_account_id, batch_ref);

  -- Deelposten die al waren ingelezen: herkenbaar aan de id van de boeking met een volgnummer (REF, REF#2, …)
  -- binnen één import, rekening en dag. Het totaal is de som van die deelposten, ook de overgeslagen.
  -- (Deelposten met een eigen id van de bank krijgen dit pas als hun afschrift opnieuw wordt ingelezen.)
  CREATE TEMP TABLE batch_members AS
    SELECT 't' AS tbl, id, import_batch_id AS b, bank_account_id AS a, transaction_date AS d, amount, bank_id, CASE WHEN rtrim(bank_id, '0123456789') <> bank_id AND substr(rtrim(bank_id, '0123456789'), -1) = '#' THEN substr(rtrim(bank_id, '0123456789'), 1, length(rtrim(bank_id, '0123456789')) - 1) ELSE bank_id END AS gk
    FROM bank_transactions WHERE source = 'camt' AND bank_id IS NOT NULL AND import_batch_id IS NOT NULL
    UNION ALL
    SELECT 'k', id, batch_id, bank_account_id, transaction_date, amount, bank_id, CASE WHEN rtrim(bank_id, '0123456789') <> bank_id AND substr(rtrim(bank_id, '0123456789'), -1) = '#' THEN substr(rtrim(bank_id, '0123456789'), 1, length(rtrim(bank_id, '0123456789')) - 1) ELSE bank_id END
    FROM import_skipped WHERE source = 'camt' AND bank_id IS NOT NULL AND added_transaction_id IS NULL;
  CREATE TEMP TABLE batch_groups AS
    SELECT b, a, d, gk, SUM(amount) AS total FROM batch_members
    GROUP BY b, a, d, gk HAVING COUNT(*) >= 2 AND SUM(bank_id <> gk) >= 1 AND SUM(bank_id = gk) = 1;
  UPDATE bank_transactions SET
    batch_ref = (SELECT g.gk FROM batch_members m JOIN batch_groups g ON g.b = m.b AND g.a = m.a AND g.d = m.d AND g.gk = m.gk WHERE m.tbl = 't' AND m.id = bank_transactions.id),
    batch_total = (SELECT g.total FROM batch_members m JOIN batch_groups g ON g.b = m.b AND g.a = m.a AND g.d = m.d AND g.gk = m.gk WHERE m.tbl = 't' AND m.id = bank_transactions.id)
    WHERE id IN (SELECT m.id FROM batch_members m JOIN batch_groups g ON g.b = m.b AND g.a = m.a AND g.d = m.d AND g.gk = m.gk WHERE m.tbl = 't');
  UPDATE import_skipped SET
    batch_ref = (SELECT g.gk FROM batch_members m JOIN batch_groups g ON g.b = m.b AND g.a = m.a AND g.d = m.d AND g.gk = m.gk WHERE m.tbl = 'k' AND m.id = import_skipped.id),
    batch_total = (SELECT g.total FROM batch_members m JOIN batch_groups g ON g.b = m.b AND g.a = m.a AND g.d = m.d AND g.gk = m.gk WHERE m.tbl = 'k' AND m.id = import_skipped.id)
    WHERE id IN (SELECT m.id FROM batch_members m JOIN batch_groups g ON g.b = m.b AND g.a = m.a AND g.d = m.d AND g.gk = m.gk WHERE m.tbl = 'k');
  DROP TABLE batch_groups;
  DROP TABLE batch_members;
  `,
  /* 30: creditnota's van leveranciers die ten onrechte op "betaald" stonden (#227) */ `
  -- Bij een bedrag onder nul was "betaald >= totaal" altijd waar: een creditnota kwam na een aanpassing of na
  -- een deel van het geld terug op 'betaald', terwijl er nog geld terug moest komen. Die staan weer open, zodat
  -- de terugbetaling eraan gekoppeld kan worden. Alleen de status: er verandert geen boeking en geen bedrag.
  UPDATE purchase_invoices SET status = 'open' WHERE total < 0 AND amount_paid > total AND status = 'betaald';
  `,
  /* 31: verkoop uit een koppeling die op een antwoord wacht (#231) */ `
  -- Een verkoop uit een webshop of Mollie Facturen die de app niet vanzelf als omzet boekt, bv. een verkoop
  -- aan je eigen bedrijf: de order zoals hij binnenkwam, waarom hij wacht en wat de gebruiker koos.
  -- Zolang answer leeg is, is er niets geboekt. De regel blijft daarna staan: zo komt de order niet opnieuw binnen.
  -- reason: 'eigen-bedrijf' (#231), 'btw' of 'opnieuw' (#228). answer: het laatste antwoord, bv. 'neutraal'
  -- (geen omzet en geen btw), 'verkoop' (gewone factuur) of 'niet' (een teruggedraaide factuur niet opnieuw inlezen).
  CREATE TABLE integration_questions (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    order_data TEXT NOT NULL,
    signals TEXT NOT NULL DEFAULT '[]',
    answer TEXT,
    journal_entry_id INTEGER REFERENCES journal_entries(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    answered_at TEXT,
    UNIQUE (source, external_id)
  );
  `,
  /* 32: aankoop waarvan je zegt dat hij al van je bankrekening betaald is (#239) */ `
  -- "Al betaald, via <rekening>": er wordt niets geboekt, de aankoop blijft open tot de afschriftimport de
  -- betaling koppelt. Dit onthoudt alleen welke rekening en sinds wanneer, zodat Vandaag niet blijft zeggen
  -- dat de aankoop te laat betaald is zolang het afschrift ontbreekt.
  ALTER TABLE purchase_invoices ADD COLUMN expected_on_bank_account_id INTEGER REFERENCES bank_accounts(id);
  ALTER TABLE purchase_invoices ADD COLUMN expected_on_bank_since TEXT;
  `,
  /* 33: Ponto-bankfeed: gekoppelde rekeningen (WP1, #243) */ `
  -- Een bankrekening die via Ponto aan de bank hangt, zodra de koppeling er is. Nu is de tabel alleen het
  -- fundament (de vlag staat nog uit, #243): hij heeft nog geen rijen en er is nog geen netwerkcode.
  -- Per provider hooguit één koppeling per externe rekening (UNIQUE). Saldo's en bevindingen van de
  -- synchronisatie in centen en tekst; credentials horen hier niet (die staan in de veilige opslag).
  CREATE TABLE bank_feed_accounts (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'ponto',
    external_id TEXT NOT NULL,
    bank_account_id INTEGER REFERENCES bank_accounts(id),
    iban TEXT,
    name TEXT,
    holder TEXT,
    status TEXT NOT NULL DEFAULT 'actief'
      CHECK (status IN ('actief','niet-gebruiken','weg')),
    link_from TEXT,
    transactions_synchronized_at TEXT,
    details_synchronized_at TEXT,
    covered_to TEXT,
    expires_at TEXT,
    balance INTEGER,
    balance_at TEXT,
    balance_diff INTEGER,
    balance_diff_rounds INTEGER NOT NULL DEFAULT 0,
    gap_from TEXT,
    gap_to TEXT,
    last_round_at TEXT,
    last_ok_at TEXT,
    last_error TEXT,
    last_error_kind TEXT,
    manual_sync_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (provider, external_id)
  );
  `,
  /* 34: leverancierscredits toewijzen aan een bedrijfsmiddel, zonder journaalregels te wijzigen */ `
  CREATE TABLE asset_credit_allocations (
    journal_line_id INTEGER PRIMARY KEY REFERENCES journal_lines(id),
    asset_id INTEGER NOT NULL REFERENCES assets(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  /* 35: expliciete afboekingen van vraagposten, zonder blind salderen */ `
  CREATE TABLE question_item_settlements (
    original_entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
    settlement_entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
    amount INTEGER NOT NULL CHECK (amount > 0),
    PRIMARY KEY (original_entry_id, settlement_entry_id),
    CHECK (original_entry_id != settlement_entry_id)
  );
  `,
  /* 36: gedateerde afschrijvingshistorie; eerdere jaarbedragen nooit overschrijven */ `
  CREATE TABLE asset_depreciation_history (
    asset_id INTEGER NOT NULL REFERENCES assets(id),
    year INTEGER NOT NULL,
    journal_entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
    amount INTEGER NOT NULL,
    PRIMARY KEY (asset_id, journal_entry_id)
  );
  -- De oude jaarcache kan bij verkoop zijn verlaagd. De onveranderlijke cumulatieve
  -- journaalregels bevatten nog het oorspronkelijke bedrag. De app boekte de activa
  -- in primaire-sleutelvolgorde, met per activum één cumulatieve regel.
  INSERT INTO asset_depreciation_history (asset_id, year, journal_entry_id, amount)
  WITH old AS (
    SELECT d.asset_id, d.year, d.journal_entry_id, s.account_rgs,
      ROW_NUMBER() OVER (PARTITION BY d.journal_entry_id, s.account_rgs ORDER BY d.asset_id) AS position
    FROM asset_depreciation d JOIN assets s ON s.id = d.asset_id
  ), posted AS (
    SELECT l.journal_entry_id, l.credit AS amount,
      CASE a.rgs_code WHEN 'BMvaBedCae' THEN 'BMvaBedIna' WHEN 'BMvaTraCae' THEN 'BMvaTraVrt' END AS account_rgs,
      ROW_NUMBER() OVER (PARTITION BY l.journal_entry_id, a.rgs_code ORDER BY l.id) AS position
    FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id
    WHERE a.rgs_code IN ('BMvaBedCae', 'BMvaTraCae') AND l.credit > 0
  )
  SELECT o.asset_id, o.year, o.journal_entry_id, p.amount FROM old o JOIN posted p
    ON p.journal_entry_id = o.journal_entry_id AND p.account_rgs = o.account_rgs AND p.position = o.position;

  -- Bestaande verkoop- en aankoopcorrecties hebben een verwijzing naar het activum.
  INSERT INTO asset_depreciation_history (asset_id, year, journal_entry_id, amount)
  SELECT s.id,
    CASE WHEN e.source_ref = 'afschrijving-correctie:' || s.id THEN CAST(substr(e.entry_date, 1, 4) AS INTEGER)
      ELSE CAST(substr(e.source_ref, length('afschrijving-correctie:' || s.id || ':') + 1) AS INTEGER) END,
    e.id, SUM(l.credit - l.debit)
  FROM assets s JOIN journal_entries e ON e.source_ref = 'afschrijving-correctie:' || s.id
    OR e.source_ref LIKE 'afschrijving-correctie:' || s.id || ':%'
  JOIN journal_lines l ON l.journal_entry_id = e.id
  JOIN chart_of_accounts a ON a.id = l.account_id
  WHERE a.rgs_code = CASE s.account_rgs WHEN 'BMvaBedIna' THEN 'BMvaBedCae' WHEN 'BMvaTraVrt' THEN 'BMvaTraCae' END
    AND e.reverses_entry_id IS NULL
  GROUP BY s.id, e.id;
  CREATE TRIGGER asset_depreciation_history_no_update BEFORE UPDATE ON asset_depreciation_history
    BEGIN SELECT RAISE(ABORT, 'Afschrijvingshistorie is onveranderlijk'); END;
  CREATE TRIGGER asset_depreciation_history_no_delete BEFORE DELETE ON asset_depreciation_history
    BEGIN SELECT RAISE(ABORT, 'Afschrijvingshistorie is onveranderlijk'); END;
  `,
  // Datum van levering of dienst (of periode) op een factuur: een eis voor gewone btw-facturen. Leeg = de factuurdatum.
  `
  ALTER TABLE invoices ADD COLUMN delivery_date TEXT;
  ALTER TABLE invoices ADD COLUMN delivery_date_to TEXT;
  `,
  // Oninbare facturen: de afschrijving (omzet en btw terug) en wat daarna alsnog binnenkomt (opnieuw aangeven).
  `
  CREATE TABLE invoice_writeoffs (
    id INTEGER PRIMARY KEY,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id),
    journal_entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
    amount INTEGER NOT NULL,
    recovered INTEGER NOT NULL DEFAULT 0,
    written_off_on TEXT NOT NULL
  );
  CREATE INDEX idx_invoice_writeoffs_invoice ON invoice_writeoffs(invoice_id);
  `,
  // Jaarafsluiting: vooruitbetaalde kosten, nog te betalen kosten, voorraad en onderhanden werk, met automatische omkering op 1 januari.
  `
  CREATE TABLE year_end_items (
    id INTEGER PRIMARY KEY,
    year INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('vooruitbetaald','nog-te-betalen','voorraad','onderhanden-werk')),
    description TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    cost_account TEXT,
    journal_entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
    reversal_entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
    removed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // Controle van een btw-nummer in VIES (alleen op verzoek van de gebruiker): het resultaat met datum, als bewijs.
  `
  CREATE TABLE vies_checks (
    id INTEGER PRIMARY KEY,
    vat_number TEXT NOT NULL,
    relation_id INTEGER REFERENCES relations(id),
    -- 1 = geldig, 0 = ongeldig, NULL = geen uitslag (dienst niet bereikbaar)
    valid INTEGER,
    name TEXT,
    address TEXT,
    message TEXT,
    checked_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_vies_checks_vat ON vies_checks(vat_number);
  `,
  // Onbetaalde inkoop: de afgetrokken voorbelasting terugbetalen (uiterlijk 1 jaar na de uiterste betaaldatum) en bij latere betaling opnieuw aftrekken.
  `
  CREATE TABLE purchase_vat_repayments (
    id INTEGER PRIMARY KEY,
    purchase_id INTEGER NOT NULL REFERENCES purchase_invoices(id),
    journal_entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
    vat_amount INTEGER NOT NULL,
    -- het openstaande bedrag op het moment van terugbetalen, en hoeveel daarvan daarna alsnog is betaald
    basis INTEGER NOT NULL,
    paid_since INTEGER NOT NULL DEFAULT 0,
    rededucted INTEGER NOT NULL DEFAULT 0,
    repaid_on TEXT NOT NULL
  );
  CREATE INDEX idx_purchase_vat_repayments_purchase ON purchase_vat_repayments(purchase_id);
  `,
  /* 37: uren voor een hele week of maand */ `
  -- period_end leeg = één dag (entry_date); anders loopt de regel van entry_date t/m period_end,
  -- binnen één kalenderjaar (een periode over de jaargrens wordt in twee regels bewaard).
  ALTER TABLE time_entries ADD COLUMN period_end TEXT;
  `,
  `
  -- Unieke apparaatcode (M1, M2, …) per koppeling: het volgnummer loopt nooit terug, dus een code
  -- wordt nooit hergebruikt. Ontkoppelen vult afgesloten_op en laat de rij staan. De sleutel van de
  -- koppeling staat hier niet: die zit versleuteld in 'secrets'. IF NOT EXISTS omdat een test (en een
  -- teruggezette administratie) de migraties op een al gevulde database opnieuw kan draaien.
  CREATE TABLE IF NOT EXISTS scanner_device_codes (
    code TEXT PRIMARY KEY,
    volgnummer INTEGER NOT NULL UNIQUE,
    device_id TEXT,
    toegekend_op TEXT NOT NULL,
    afgesloten_op TEXT NULL
  );
  `,
  `
  -- Sync-identiteit van klanten en leveranciers aan de pc-kant (voorbereiding telefoon-sync).
  -- Alleen additief. De uuid is een willekeurige versie-4-uuid in kleine letters en mag NULL zijn:
  -- een oudere app-versie die deze administratie daarna nog opent, schrijft rijen zonder uuid en met
  -- sync_seq 0; het herstel bij het openen van de database vult die aan.
  -- revisie: pc-rij-revisie (informatief). gewijzigd_op: bewerktijd van de laatste wijziging in
  -- milliseconden (informatief, nooit voor delta of sortering). sync_seq: nummer uit de globale teller
  -- sync_teller, de enige basis voor delta-sync.
  -- Regel voor velden zonder rij in relation_field_rev: tijd = created_at van de klant in milliseconden
  -- en bron 'pc' (niet gewijzigd_op en niet 0). Deze migratie schrijft daarom geen veldrijen.
  ALTER TABLE relations ADD COLUMN uuid TEXT;
  ALTER TABLE relations ADD COLUMN revisie INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE relations ADD COLUMN gewijzigd_op INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE relations ADD COLUMN sync_seq INTEGER NOT NULL DEFAULT 0;

  UPDATE relations SET uuid = lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-'||substr('89ab',1+(abs(random())%4),1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))) WHERE uuid IS NULL;
  UPDATE relations SET gewijzigd_op = COALESCE(CAST(strftime('%s', created_at) AS INTEGER) * 1000, 0);
  UPDATE relations SET sync_seq = id;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_uuid ON relations(uuid);
  CREATE INDEX IF NOT EXISTS idx_relations_sync_seq ON relations(sync_seq);

  -- IF NOT EXISTS omdat een test (en een teruggezette administratie) de migraties op een al gevulde
  -- database opnieuw kan draaien.
  CREATE TABLE IF NOT EXISTS relation_field_rev (
    relation_id INTEGER NOT NULL REFERENCES relations(id),
    veld TEXT NOT NULL,
    tijd INTEGER NOT NULL,
    bron TEXT NOT NULL,
    PRIMARY KEY (relation_id, veld)
  );

  CREATE TABLE IF NOT EXISTS relation_changelog (
    id INTEGER PRIMARY KEY,
    relation_id INTEGER NOT NULL REFERENCES relations(id),
    revisie INTEGER NOT NULL,
    veld TEXT NOT NULL,
    oud TEXT,
    nieuw TEXT,
    tijd INTEGER NOT NULL,
    bron TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_relation_changelog_relation ON relation_changelog(relation_id);

  -- Later voor samengevoegde klanten; hier alleen aangemaakt.
  CREATE TABLE IF NOT EXISTS relation_aliases (
    alias_uuid TEXT PRIMARY KEY,
    relation_id INTEGER NOT NULL REFERENCES relations(id),
    aangemaakt_op INTEGER NOT NULL
  );

  -- Globale wijzigingsteller; de rij 'wijziging' begint op het hoogste klantnummer (0 zonder klanten).
  CREATE TABLE IF NOT EXISTS sync_teller (
    naam TEXT PRIMARY KEY,
    waarde INTEGER NOT NULL
  );
  INSERT INTO sync_teller (naam, waarde) SELECT 'wijziging', COALESCE(MAX(id), 0) FROM relations WHERE true ON CONFLICT(naam) DO NOTHING;
  `,
  `
  -- Register van ontvangen telefoonwijzigingen: per (apparaat, entiteit, uuid, revisie) een rij met de
  -- uitkomst van de eerste verwerking. Zo wordt dezelfde wijziging nooit twee keer toegepast, via welke
  -- route ze ook binnenkomt. tijd is de bewerktijd van de telefoon, ontvangen_op de klok van de pc (beide in
  -- milliseconden), uitkomst is toegepast, overgeslagen of afgewezen en fout bevat de reden van een afwijzing.
  -- IF NOT EXISTS omdat een test (en een teruggezette administratie) de migraties op een al gevulde
  -- database opnieuw kan draaien. Er worden geen rijen geschreven.
  CREATE TABLE IF NOT EXISTS sync_ontvangen (
    apparaat_id TEXT,
    entiteit TEXT,
    uuid TEXT,
    revisie INTEGER,
    tijd INTEGER,
    ontvangen_op INTEGER,
    uitkomst TEXT,
    fout TEXT NULL,
    route TEXT NOT NULL DEFAULT 'netwerk',
    PRIMARY KEY (apparaat_id, entiteit, uuid, revisie)
  );
  `,
  `
  -- Klussen (jobs) krijgen dezelfde sync-administratie als klanten: uuid, revisie, gewijzigd_op, sync_seq
  -- en een archiefvlag, plus de tijd per veld (job_field_rev), een logboek (job_changelog) en de
  -- generieke wachtrij voor wijzigingen die wachten op een nog onbekende verwijzing (sync_wachtrij).
  -- Alleen additief. uuid mag NULL zijn (een oudere app-versie schrijft rijen zonder uuid en met
  -- sync_seq 0; het herstel bij het openen vult dat aan) en is uniek via een eigen index, want SQLite
  -- staat ADD COLUMN met UNIQUE niet toe. revisie: pc-rij-revisie (informatief). gewijzigd_op: bewerktijd
  -- van de laatste wijziging in milliseconden (informatief, nooit voor delta of sortering). sync_seq:
  -- nummer uit de globale teller sync_teller, de enige basis voor delta-sync.
  -- Een veld zonder rij in job_field_rev heeft als tijd de aanmaaktijd van de klus (UTC) en als bron pc;
  -- deze migratie schrijft daarom geen veldrijen.
  ALTER TABLE jobs ADD COLUMN uuid TEXT;
  ALTER TABLE jobs ADD COLUMN revisie INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE jobs ADD COLUMN gewijzigd_op INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE jobs ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1));
  ALTER TABLE jobs ADD COLUMN sync_seq INTEGER NOT NULL DEFAULT 0;

  UPDATE jobs SET uuid = lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-'||substr('89ab',1+(abs(random())%4),1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))) WHERE uuid IS NULL;
  UPDATE jobs SET gewijzigd_op = COALESCE(CAST(strftime('%s', created_at) AS INTEGER) * 1000, 0);
  UPDATE jobs SET sync_seq = (SELECT waarde FROM sync_teller WHERE naam = 'wijziging') + id;
  UPDATE sync_teller SET waarde = waarde + (SELECT COALESCE(MAX(id), 0) FROM jobs) WHERE naam = 'wijziging';

  CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_uuid ON jobs(uuid);
  CREATE INDEX IF NOT EXISTS idx_jobs_sync_seq ON jobs(sync_seq);

  -- IF NOT EXISTS omdat een test (en een teruggezette administratie) de migraties op een al gevulde
  -- database opnieuw kan draaien.
  CREATE TABLE IF NOT EXISTS job_field_rev (
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    veld TEXT NOT NULL,
    tijd INTEGER NOT NULL,
    bron TEXT NOT NULL,
    PRIMARY KEY (job_id, veld)
  );

  CREATE TABLE IF NOT EXISTS job_changelog (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    revisie INTEGER NOT NULL,
    veld TEXT NOT NULL,
    oud TEXT,
    nieuw TEXT,
    tijd INTEGER NOT NULL,
    bron TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_job_changelog_job ON job_changelog(job_id);

  -- Wijzigingen van een telefoon die wachten op een object dat er nog niet is (een klant, later een project
  -- of periode). Een rij wordt nooit verwijderd: afhandelen is verwerkt_op, verwerkt_uitkomst en
  -- verwerkt_reden invullen. wijziging is de volledige wijziging als JSON-tekst, tijd de bewerktijd van de
  -- telefoon en ontvangen_op de klok van de pc (beide in milliseconden); nummer is voor facturen.
  CREATE TABLE IF NOT EXISTS sync_wachtrij (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    apparaat_id TEXT NOT NULL,
    bron TEXT NOT NULL,
    entiteit TEXT NOT NULL,
    uuid TEXT NOT NULL,
    revisie INTEGER NOT NULL,
    tijd INTEGER NOT NULL,
    wijziging TEXT NOT NULL,
    nummer TEXT,
    wacht_op_entiteit TEXT NOT NULL,
    wacht_op_uuid TEXT NOT NULL,
    reden TEXT NOT NULL,
    ontvangen_op INTEGER NOT NULL,
    verwerkt_op INTEGER,
    verwerkt_uitkomst TEXT,
    verwerkt_reden TEXT,
    UNIQUE (apparaat_id, entiteit, uuid, revisie)
  );
  CREATE INDEX IF NOT EXISTS idx_sync_wachtrij_wacht ON sync_wachtrij(verwerkt_op, wacht_op_entiteit, wacht_op_uuid);
  `,
  `
  -- Facturen van een telefoon op de pc: sync-identiteit en reeksgegevens. uuid is de sleutel van de
  -- telefoon; apparaat_code, reeks_jaar en reeks_volgnr komen uit het nummer (M1-2026-0001); regeltabel_versie
  -- is de versie van de btw-regeltabel waarmee de telefoon rekende. Een pc-factuur houdt overal NULL, dus
  -- bestaande rijen veranderen niet en de unieke indexen gelden alleen voor telefoonfacturen.
  ALTER TABLE invoices ADD COLUMN uuid TEXT;
  ALTER TABLE invoices ADD COLUMN apparaat_code TEXT;
  ALTER TABLE invoices ADD COLUMN reeks_jaar INTEGER;
  ALTER TABLE invoices ADD COLUMN reeks_volgnr INTEGER;
  ALTER TABLE invoices ADD COLUMN regeltabel_versie TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS ux_invoices_uuid ON invoices(uuid) WHERE uuid IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS ux_invoices_reeks ON invoices(apparaat_code, reeks_jaar, reeks_volgnr) WHERE apparaat_code IS NOT NULL;
  `,
  `
  -- De route (netwerk, map of mail) waarmee een wachtende wijziging van de telefoon voor het eerst binnenkwam, zodat
  -- de registerrij bij het later overnemen die route houdt. Bestaande wachtrijrijen blijven NULL en gelden dan als netwerk.
  ALTER TABLE sync_wachtrij ADD COLUMN route TEXT;
  `,
  `
  -- Reeksbewaking voor facturen van een telefoon: een volgnummer (M1-2026-0003) dat nooit meer komt, kan door de
  -- gebruiker expliciet als vervallen worden gemarkeerd, met een reden. Een rij hoort bij een nummer van een reeks
  -- (apparaat_code, reeks_jaar) en wordt nooit gewijzigd of weggehaald: markeren is een rij toevoegen. Alleen
  -- additief; bestaande tabellen en rijen veranderen niet.
  CREATE TABLE IF NOT EXISTS factuur_reeks_vervallen (
    apparaat_code TEXT NOT NULL,
    reeks_jaar INTEGER NOT NULL,
    reeks_volgnr INTEGER NOT NULL,
    reden TEXT NOT NULL CHECK (length(trim(reden)) > 0),
    gemarkeerd_op TEXT NOT NULL,
    PRIMARY KEY (apparaat_code, reeks_jaar, reeks_volgnr)
  );
  `,
];
