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
    checked_at TEXT
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
];
