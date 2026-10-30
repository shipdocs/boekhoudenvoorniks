import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { setup } from './helpers';
import { createBackupBundle, extractBundle } from '../src/main/backup';
import { openDatabase } from '../src/db/database';
import { makeJpeg } from './fixtures/jpeg';
import type { PackageHeader } from '../src/exchange/crypto';
import { Bonnenscanner } from '../src/scanner/scanner';
import { createApi, type HostContext } from '../src/main/api';
import { blockAiInOfficeCopy, ocrAllowed } from '../src/settings/ocr-policy';
import type { ExchangeService } from '../src/exchange/exchange';

type ExportMeta = Parameters<ExchangeService['initCopy']>[1];

// Een ontvangen uitwisselingspakket komt van een andere partij: wat daarin aan programma- en
// koppelingsinstellingen staat, mag de kopie bij de boekhouder niet overnemen of uitvoeren.

const dirs: string[] = [];
const open: Bonnenscanner[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('ontvangen kopie wordt geschoond', () => {
  it('houdt na het inlezen geen ocr-programma, geheimen of koppelingen van de afzender over', () => {
    const t = setup();
    // zo kan een afzender met de publieke kantoorsleutel een database klaarmaken
    t.s.settings.update({ ocr: { ...t.s.settings.get().ocr, engine: 'claude-code', claudeCodePath: '/tmp/kwaadaardig' } });
    t.db.prepare(`INSERT INTO secrets (key, value) VALUES ('smtp:password', x'0102')`).run();
    t.db.prepare(`UPDATE integrations SET enabled = 1, config = '{"url":"https://afzender.example"}'`).run();
    expect(t.s.settings.get().ocr.claudeCodePath).toBe('/tmp/kwaadaardig');

    const header = { administratie: t.s.settings.administrationId(), uitwisseling: 1, einddatum: '2026-12-31' } as unknown as PackageHeader;
    const meta = { company: 'Klant', email: 'klant@example.nl', key: 'antwoordsleutel' } as unknown as ExportMeta;
    t.s.exchange.initCopy(header, meta, 'Kantoor');

    const ocr = t.s.settings.get().ocr;
    expect(ocr.engine).not.toBe('claude-code');
    expect(ocr.claudeCodePath).toBe('');
    expect(t.db.prepare(`SELECT COUNT(*) AS n FROM secrets WHERE key = 'smtp:password'`).get()).toEqual({ n: 0 });
    expect(t.db.prepare(`SELECT COUNT(*) AS n FROM integrations WHERE enabled = 1 OR config <> '{}'`).get()).toEqual({ n: 0 });
    // de kopie zelf werkt nog
    expect(t.s.settings.officeCopy()).toMatchObject({ office: 'Kantoor', exchange: 1 });
  });
});

describe('bonnenscanner leest in een kantoorkopie geen wachtende bonnen', () => {
  async function wachtendeBon(kopie: boolean) {
    const t = setup();
    const herkend: string[] = [];
    t.s.intake.setOcrProvider({
      id: 'test', label: 'test', available: async () => true,
      recognize: async (i) => { herkend.push(i.filename); throw new Error('niet nodig in deze test'); },
    });
    const spoolDir = mkdtempSync(join(tmpdir(), 'bvn-ontvangst-'));
    dirs.push(spoolDir);
    await t.s.intake.add('wacht.jpg', makeJpeg('wacht'), '2026-10-01', { deferOcr: true });
    expect(t.s.intake.waitingToRead()).toHaveLength(1);
    if (kopie) t.s.settings.markOfficeCopy({ office: 'Kantoor', exchange: 1, endDate: '2026-12-31' });
    const gelezen: string[] = [];
    const scanner = new Bonnenscanner({ db: t.db, secrets: t.secrets, intake: t.s.intake, settings: t.s.settings, spoolDir, interfaces: () => [], readAttachment: (p) => (gelezen.push(p), makeJpeg('wacht')) });
    open.push(scanner);
    await scanner.start();
    await scanner.whenRead().catch(() => undefined);
    return { gelezen, herkend };
  }

  it('in een gewone administratie wordt de wachtende bon wel gelezen', async () => {
    const r = await wachtendeBon(false);
    expect(r.gelezen).toHaveLength(1);
    expect(r.herkend).toHaveLength(1);
  });

  it('in een kantoorkopie niet', async () => {
    const r = await wachtendeBon(true);
    expect(r.gelezen).toEqual([]);
    expect(r.herkend).toEqual([]);
  });
});

describe('oude, ongeschoonde kantoorkopie gebruikt een opgeslagen programma niet', () => {
  function oudeKopie(kopie: boolean) {
    const t = setup();
    t.s.settings.update({ ocr: { ...t.s.settings.get().ocr, engine: 'claude-code', claudeCodePath: '/tmp/kwaadaardig' } });
    if (kopie) t.s.settings.markOfficeCopy({ office: 'Kantoor', exchange: 1, endDate: '2026-12-31' });
    const gestart: string[] = [];
    const host = {
      appVersion: () => 'test',
      programExists: () => true,
      checkCli: async (_k: string, cli: string) => (gestart.push(cli), { ok: true }),
      openLoginTerminal: async (_k: string, cli: string) => (gestart.push(cli), { ok: true }),
      connectMcp: async (_k: string, cli: string) => (gestart.push(cli), { ok: true }),
      mcpCommand: () => ({ command: 'x', args: [] }),
      readAttachment: () => makeJpeg('x'),
      reconfigureLocalAi: () => {},
    } as unknown as HostContext;
    return { api: createApi(t.s, host), gestart };
  }

  it('ocrAllowed: alleen buiten een kantoorkopie', () => {
    expect(ocrAllowed({ officeCopy: () => null })).toBe(true);
    expect(ocrAllowed({ officeCopy: () => ({ office: 'K' }) })).toBe(false);
  });

  it('Controleer, inloggen, koppelen en lezen weigeren in een kantoorkopie en starten niets', async () => {
    const { api, gestart } = oudeKopie(true);
    await expect(api.assistantTools.check('claude-code')).rejects.toThrow(/kopie van een klant/);
    await expect(api.assistantTools.openLogin('claude-code')).rejects.toThrow(/kopie van een klant/);
    await expect(api.assistant.connect('claude-code')).rejects.toThrow(/kopie van een klant/);
    await expect(api.reader.rereadPending()).rejects.toThrow(/kopie van een klant/);
    expect(() => api.assistantTools.search()).toThrow(/kopie van een klant/);
    expect(api.assistant.info().claudeCode).toBeNull();
    expect(gestart).toEqual([]);
  });

  it('in een gewone administratie wordt het opgeslagen pad nog wel gebruikt', async () => {
    const { api, gestart } = oudeKopie(false);
    await api.assistantTools.check('claude-code');
    expect(gestart).toEqual(['/tmp/kwaadaardig']);
    expect(api.assistant.info().claudeCode).toBe('/tmp/kwaadaardig');
  });
});

/** Een bundel met een database die met `prepare` is bewerkt, zoals een afzender dat kan doen. */
async function bundleMet(prepare: (db: Database.Database) => void): Promise<{ bundle: Buffer; dir: string }> {
  const src = mkdtempSync(join(tmpdir(), 'bvn-ontvangst-bron-'));
  dirs.push(src);
  const t = setup({ db: new Database(join(src, 'boekhouding.sqlite')) });
  prepare(t.db);
  const bundle = await createBackupBundle(t.db, src);
  t.db.close();
  const dir = join(mkdtempSync(join(tmpdir(), 'bvn-ontvangst-')), 'kopie');
  dirs.push(join(dir, '..'));
  return { bundle, dir };
}

const KWAAD = `INSERT INTO settings (key, value) VALUES ('marker', 'geschreven')`;
const marker = (file: string) => {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM settings WHERE key = 'marker'`).get();
  } finally {
    db.close();
  }
};

describe('ontvangen database brengt geen eigen triggers mee', () => {
  it('vervalste user_version en een trigger met vertrouwde naam: kopie geweigerd, geen marker', async () => {
    const { bundle, dir } = await bundleMet((db) => {
      db.exec(`DROP TRIGGER journal_lines_no_update; CREATE TRIGGER journal_lines_no_update AFTER INSERT ON settings BEGIN ${KWAAD}; END;`);
      db.pragma(`user_version = ${(db.pragma('user_version', { simple: true }) as number) - 1}`);
    });
    expect(() => extractBundle(bundle, dir)).toThrow(/niet bij deze versie/);
    expect(marker(join(dir, 'boekhouding.sqlite'))).toEqual({ n: 0 });
  });

  it('trigger op een bijlagetabel met absoluut bijlagepad: door de volledige ontvangst geen marker, eigen triggers terug', async () => {
    const { bundle, dir } = await bundleMet((db) => {
      db.exec(`INSERT INTO documents (file_path, original_name, mime_type, sha256) VALUES ('/data/oud/bijlagen/2026/bon.pdf', 'bon.pdf', 'application/pdf', 'abc')`);
      db.exec(`CREATE TRIGGER kwaad AFTER UPDATE ON documents BEGIN ${KWAAD}; END; CREATE VIEW kwaadview AS SELECT 1;`);
    });
    extractBundle(bundle, dir);
    const file = join(dir, 'boekhouding.sqlite');
    const db = openDatabase(file, () => {});
    try {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('kwaad', 'kwaadview')`).get()).toEqual({ n: 0 });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'journal_lines_no_update'`).get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
    expect(marker(file)).toEqual({ n: 0 });
    const check = new Database(file, { readonly: true });
    expect(check.prepare(`SELECT file_path FROM documents`).get()).toEqual({ file_path: 'bijlagen/2026/bon.pdf' });
    check.close();
  });

  it('zet een gewijzigde eigen trigger terug', async () => {
    const { bundle, dir } = await bundleMet((db) => {
      db.exec(`DROP TRIGGER journal_lines_no_update; CREATE TRIGGER journal_lines_no_update BEFORE UPDATE ON journal_lines BEGIN SELECT 1; END;`);
    });
    extractBundle(bundle, dir);
    const db = new Database(join(dir, 'boekhouding.sqlite'), { readonly: true });
    try {
      expect((db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'journal_lines_no_update'`).get() as { sql: string }).sql).toContain('RAISE');
    } finally {
      db.close();
    }
  });
});

describe('LLM en leesprogramma in een kantoorkopie', () => {
  const nep = (office: boolean) => {
    const calls: string[] = [];
    return {
      calls,
      services: {
        settings: { officeCopy: () => (office ? { office: 'K' } : null) },
        intake: { setOcrProvider: (p: null) => void calls.push(`ocr:${p}`) },
        classifier: { setLlm: (l: null) => void calls.push(`llm:${l}`) },
      },
    };
  };

  it('kantoorkopie: leesprogramma gestopt en geen OCR of LLM', () => {
    const { calls, services } = nep(true);
    let stopped = 0;
    expect(blockAiInOfficeCopy(services, () => stopped++)).toBe(true);
    expect(calls.sort()).toEqual(['llm:null', 'ocr:null']);
    expect(stopped).toBe(1);
  });

  it('gewone administratie: niets geblokkeerd of aangeraakt', () => {
    const { calls, services } = nep(false);
    expect(blockAiInOfficeCopy(services, () => { throw new Error('mag niet stoppen'); })).toBe(false);
    expect(calls).toEqual([]);
  });
});
