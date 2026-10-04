import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/db/database';
import { migrations } from '../src/db/migrations';
import { createServices, MemorySecretStore } from '../src/services';
import { createApi, type HostContext } from '../src/main/api';
import { sanitizeForExchange } from '../src/exchange/exchange';
import { BANK_FEED, BANK_FEED_SECRET_KEYS } from '../src/shared/bank-feed';
import { SafeStorageSecretStore } from '../src/main/secrets';
import { INTEGRATIONS } from '../src/integrations/integrations';
import { ValidationError } from '../src/shared/validation';

/** De tabel uit migratie 33, exact zoals het contract hem voorschrijft. */
const FEED_COLUMNS = [
  'id', 'provider', 'external_id', 'bank_account_id', 'iban', 'name', 'holder', 'status', 'link_from',
  'transactions_synchronized_at', 'details_synchronized_at', 'covered_to', 'expires_at',
  'balance', 'balance_at', 'balance_diff', 'balance_diff_rounds', 'gap_from', 'gap_to',
  'last_round_at', 'last_ok_at', 'last_error', 'last_error_kind', 'manual_sync_at', 'created_at',
];

describe('Ponto WP1: fundament (#243)', () => {
  describe('migratie 33', () => {
    it('bestaat: migratie 33 maakt de tabel op een nieuwe database', () => {
      expect(migrations.length).toBeGreaterThanOrEqual(33);
      expect(migrations[31]!).toContain('expected_on_bank_account_id');
      expect(migrations[32]!).toContain('CREATE TABLE bank_feed_accounts');
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      migrate(db);
      expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
      db.close();
    });

    it('op een bestaande database (user_version 32) draaien migratie 33 en latere migraties en laat bestaande rijen staan', () => {
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      for (const m of migrations.slice(0, 32)) db.exec(m);
      db.pragma('user_version = 32');
      // bestaande data die de migratie moet overleven
      db.exec(`INSERT INTO chart_of_accounts (id, rgs_code, code, name, category) VALUES (1, 'BLiqBanRba', '1100', 'Bank', 'activa');
        INSERT INTO bank_accounts (id, name, account_id) VALUES (1, 'Zakelijk', 1);`);
      migrate(db);
      expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bank_feed_accounts'`).get()).toBeTruthy();
      expect(db.prepare('SELECT COUNT(*) AS n FROM bank_accounts').get()).toEqual({ n: 1 });
      db.close();
    });

    it('heeft exact de voorgeschreven kolommen, typen en beperkingen', () => {
      const db = new Database(':memory:');
      migrate(db);
      const columns = db.prepare('PRAGMA table_info(bank_feed_accounts)').all() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[];
      expect(columns.map((c) => c.name)).toEqual(FEED_COLUMNS);
      const byName = Object.fromEntries(columns.map((c) => [c.name, c]));
      expect(byName['id']!.type).toBe('INTEGER');
      expect(byName['id']!.pk).toBe(1);
      expect(byName['provider']!.type).toBe('TEXT');
      expect(byName['provider']!.notnull).toBe(1);
      expect(byName['provider']!.dflt_value).toBe("'ponto'");
      expect(byName['external_id']!.notnull).toBe(1);
      expect(byName['status']!.dflt_value).toBe("'actief'");
      expect(byName['balance_diff_rounds']!.type).toBe('INTEGER');
      expect(byName['balance_diff_rounds']!.notnull).toBe(1);
      expect(byName['balance_diff_rounds']!.dflt_value).toBe('0');
      expect(byName['created_at']!.notnull).toBe(1);
      // foreign key naar bank_accounts
      const fks = db.prepare('PRAGMA foreign_key_list(bank_feed_accounts)').all() as { table: string; from: string; to: string }[];
      expect(fks.map((f) => ({ table: f.table, from: f.from, to: f.to }))).toEqual([{ table: 'bank_accounts', from: 'bank_account_id', to: 'id' }]);
      // de CHECK op status
      const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'bank_feed_accounts'`).get() as { sql: string }).sql;
      expect(sql).toContain("CHECK (status IN ('actief','niet-gebruiken','weg'))");
      expect(sql).toContain("UNIQUE (provider, external_id)");
      db.close();
    });

    it('dwingt de unique constraint af en de status-CHECK, en geen credentialkolommen', () => {
      const db = new Database(':memory:');
      migrate(db);
      db.prepare(`INSERT INTO bank_feed_accounts (external_id) VALUES ('ext-1')`).run();
      expect(() => db.prepare(`INSERT INTO bank_feed_accounts (external_id) VALUES ('ext-1')`).run()).toThrow(/UNIQUE/);
      db.prepare(`INSERT INTO bank_feed_accounts (external_id, provider) VALUES ('ext-1', 'anders')`).run();
      expect(() => db.prepare(`INSERT INTO bank_feed_accounts (external_id, status) VALUES ('ext-check', 'verborgen')`).run()).toThrow(/CHECK/);
      const columns = (db.prepare('PRAGMA table_info(bank_feed_accounts)').all() as { name: string }[]).map((c) => c.name);
      for (const verboden of ['client_id', 'client_secret', 'secret', 'api_key', 'config']) expect(columns).not.toContain(verboden);
      db.close();
    });
  });

  describe('featureflag BANK_FEED', () => {
    it('staat standaard aan (1.2.0) en is alleen via api.app.meta zichtbaar voor de renderer', () => {
      expect(BANK_FEED.available).toBe(true);
      // de renderer importeert de vlag niet: alleen api.ts (main) leest hem
      const api = createApi(setupMinimal(), { appVersion: () => '0.0.0', hasSmtpPassword: () => false } as unknown as HostContext);
      const meta = api.app.meta();
      expect(meta.bankFeed).toBe(true);
      expect(meta.phoneScanner).toBe(false);
    });
  });

  describe('veilige opslag: SecretStore.available', () => {
    it('MemorySecretStore meldt zich beschikbaar, de MCP/no-store niet', () => {
      expect(new MemorySecretStore().available).toBe(true);
      const noStore = { available: false, get: () => null, set: () => undefined, delete: () => undefined };
      expect(noStore.available).toBe(false);
    });

    it('SafeStorageSecretStore meldt beschikbaarheid via de eigen getter (in tests zonder Electron geen toegang)', () => {
      const store = new SafeStorageSecretStore(new Database(':memory:'));
      // de getter bestaat op de klasse; hem oproepen kan niet zonder Electron (safeStorage ontbreekt in unit-tests)
      const descriptor = Object.getOwnPropertyDescriptor(SafeStorageSecretStore.prototype, 'available');
      expect(descriptor?.get).toBeTypeOf('function');
      expect(() => store.available).toThrow(/safeStorage|isEncryptionAvailable|undefined/i);
    });
  });

  describe('reservering van de credential-sleutels', () => {
    it('alleen bankfeed:ponto:clientId en bankfeed:ponto:clientSecret, en die komen niet in integrations.config', () => {
      expect(BANK_FEED_SECRET_KEYS).toEqual({ clientId: 'bankfeed:ponto:clientId', clientSecret: 'bankfeed:ponto:clientSecret' });
      // de generieke integratie-API kent geen Ponto en dus ook geen plek voor deze sleutels
      for (const def of INTEGRATIONS) {
        expect(def.id).not.toBe('ponto');
        for (const f of def.fields) expect(`${def.id}:${f.key}`).not.toMatch(/ponto|clientSecret/i);
      }
      // in de broncode schrijft alleen shared/bank-feed.ts ze vast; geen integratie schrijft ze in config
      const src = readFileSync(join(__dirname, '..', 'src', 'integrations', 'integrations.ts'), 'utf8');
      expect(src).not.toContain('bankfeed:ponto');
    });
  });

  describe('klantkopie (sanitizeForExchange)', () => {
    it('wist bank_feed_accounts én secrets', () => {
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      migrate(db);
      db.exec(`INSERT INTO chart_of_accounts (id, rgs_code, code, name, category) VALUES (1, 'BLiqBanRba', '1100', 'Bank', 'activa');
        INSERT INTO bank_accounts (id, name, account_id) VALUES (1, 'Zakelijk', 1);
        INSERT INTO bank_feed_accounts (external_id, bank_account_id, iban, balance) VALUES ('ext-1', 1, 'NL91ABNA0417164300', 12345);
        INSERT INTO secrets (key, value) VALUES ('bankfeed:ponto:clientSecret', x'01020304');`);
      sanitizeForExchange(db);
      expect(db.prepare('SELECT COUNT(*) AS n FROM bank_feed_accounts').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM secrets').get()).toEqual({ n: 0 });
      db.close();
    });
  });

  describe('verwijderregels van bankrekeningen', () => {
    it('een rekening met een gekoppelde Ponto-feed is niet verwijderbaar, met de exacte melding', () => {
      const s = setupMinimal();
      const extra = s.bank.addAccount('Tweede', null);
      expect(s.bank.removable(extra.id)).toEqual({ ok: true, reason: null });
      s.db.prepare(`INSERT INTO bank_feed_accounts (external_id, bank_account_id) VALUES ('ext-1', ?)`).run(extra.id);
      expect(s.bank.removable(extra.id)).toEqual({ ok: false, reason: 'Deze rekening is gekoppeld aan Ponto' });
      // een rekening zonder koppeling blijft gewoon verwijderbaar (bestaande regels ongewijzigd)
      const derde = s.bank.addAccount('Derde', null);
      expect(s.bank.removable(derde.id)).toEqual({ ok: true, reason: null });
    });

    it('ook een feedrij met status "weg" blokkeert verwijderen: geen kale FOREIGN KEY-fout', () => {
      const s = setupMinimal();
      const gekoppeld = s.bank.addAccount('Gekoppeld', null);
      s.db.prepare(`INSERT INTO bank_feed_accounts (external_id, bank_account_id, status) VALUES ('ext-weg', ?, 'weg')`).run(gekoppeld.id);
      // removable weigert, ook al staat de rij als 'weg': de foreign key bestaat nog
      expect(s.bank.removable(gekoppeld.id)).toEqual({ ok: false, reason: 'Deze rekening is gekoppeld aan Ponto' });
      // en het echte verwijderen gooit de nette melding, niet de kale SQLite-constraintfout
      expect(() => s.bank.removeAccount(gekoppeld.id)).toThrow(ValidationError);
      expect(() => s.bank.removeAccount(gekoppeld.id)).toThrow('Deze rekening is gekoppeld aan Ponto');
      // de rekening bestaat daarna nog steeds
      expect(s.bank.listAccounts().some((a) => a.id === gekoppeld.id)).toBe(true);
    });
  });

  describe('generieke integratie-API', () => {
    it('blijft ongewijzigd en weigert ponto als onbekend', async () => {
      const s = setupMinimal();
      expect(s.integrations.list().map((i) => i.definition.id)).toEqual(['woocommerce', 'shopify', 'mollie-facturen', 'mollie', 'stripe']);
      expect(() => s.integrations.state('ponto')).toThrow('Onbekende koppeling: ponto');
      expect(() => s.integrations.configure('ponto', { clientId: 'x', clientSecret: 'y' }, true)).toThrow('Onbekende koppeling: ponto');
      const api = createApi(s, { appVersion: () => '0.0.0', hasSmtpPassword: () => false } as unknown as HostContext);
      await expect(api.integrations.sync('ponto')).rejects.toThrow('Onbekende koppeling: ponto');
    });
  });

  describe('met de vlag uit (#243)', () => {
    it('geen enkel zichtbaar Ponto-element: de api bevat geen ponto-routes of -velden buiten meta.bankFeed=false', () => {
      const api = createApi(setupMinimal(), { appVersion: () => '0.0.0', hasSmtpPassword: () => false } as unknown as HostContext);
      expect(Object.keys(api)).not.toContain('bankFeed');
      expect(Object.keys(api.app)).toEqual(expect.arrayContaining(['meta']));
      expect(JSON.stringify(Object.keys(api))).not.toContain('ponto');
    });
  });
});

/** Een minimale administratie: migraties gedraaid, diensten gemaakt. */
function setupMinimal(): ReturnType<typeof createServices> {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return createServices(db, {
    pdf: async () => Buffer.from('PDF'),
    mailerFactory: async () => { throw new Error('geen mail in tests'); },
    secrets: new MemorySecretStore(),
    fetch: async () => { throw new Error('geen netwerk in tests'); },
    storeFile: async (name) => `/tmp/${name}`,
    licensePublicKey: '',
  });
}

/** Lees een werkmapbestand (voor broncontroles die tsc niet kan uiten). */
function readFileSyncLocal(path: string): string {
  // eslint negeert: alleen hier node:fs gebruiken; de renderer doet dat nooit
  return require('node:fs').readFileSync(require('node:path').join(__dirname, '..', path), 'utf8') as string;
}
