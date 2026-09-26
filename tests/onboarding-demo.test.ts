import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/db/database';
import { createServices, MemorySecretStore } from '../src/services';
import { seedDemo } from '../src/demo/demo';
import { hasRealData, wipeDatabase } from '../src/main/reset';
import { DEFAULT_SETTINGS } from '../src/settings/settings';
import { ONBOARDING_STEPS, hasOnboardingUpdate, markSeen, pendingSteps, type OnboardingStep } from '../src/shared/onboarding';
import { isValidIban } from '../src/shared/validation';
import type { Db } from '../src/db/database';
import { setup } from './helpers';

function emptyServices(db: Db = new Database(':memory:')) {
  db.pragma('foreign_keys = ON');
  migrate(db);
  return createServices(db, {
    pdf: async () => Buffer.from('PDF'),
    mailerFactory: async () => ({ send: async () => ({ messageId: '<x@local>' }) }),
    secrets: new MemorySecretStore(),
    fetch: async () => {
      throw new Error('geen netwerk in tests');
    },
    storeFile: async (name) => `/tmp/${name}`,
  });
}

describe('onboarding die zichzelf bijwerkt', () => {
  const base = { ...DEFAULT_SETTINGS };

  it('nieuwe gebruiker: alle stappen', () => {
    expect(pendingSteps(base).map((s) => s.id)).toEqual(ONBOARDING_STEPS.map((s) => s.id));
    expect(hasOnboardingUpdate(base)).toBe(false);
  });

  it('bestaande gebruiker van vóór de versies ziet alleen wat nieuw is', () => {
    const legacy = { ...base, onboardingDone: true, onboardingSteps: {} };
    expect(pendingSteps(legacy).map((s) => s.id)).toEqual(['fiscaal', 'thuis', 'automatisch']);
    expect(hasOnboardingUpdate(legacy)).toBe(true);
    const after = { ...legacy, onboardingSteps: markSeen(legacy, ['fiscaal', 'thuis', 'automatisch']) };
    expect(pendingSteps(after)).toEqual([]);
  });

  it('een gewijzigde stap komt terug, tenzij de gegevens al kloppen', () => {
    const steps: OnboardingStep[] = [
      { id: 'bedrijf', version: 2, title: 'Je bedrijf', satisfied: (s) => !!s.company.kvkNumber },
      { id: 'nieuw', version: 1, title: 'Nieuw' },
    ];
    const user = { ...base, onboardingDone: true, onboardingSteps: { bedrijf: 1, nieuw: 1 } };
    expect(pendingSteps(user, steps).map((s) => s.id)).toEqual(['bedrijf']);
    const filled = { ...user, company: { ...base.company, kvkNumber: '12345678' } };
    expect(pendingSteps(filled, steps)).toEqual([]);
    // en wordt dan meteen als gezien vastgelegd
    expect(markSeen(filled, [], steps)).toEqual({ bedrijf: 2, nieuw: 1 });
  });

  it('elke bestaande stap komt terug als zijn versie omhooggaat en de gegevens niet vanzelf kloppen', () => {
    const legacy = { ...base, onboardingDone: true, onboardingSteps: {} };
    for (const step of ONBOARDING_STEPS) {
      const bumped = ONBOARDING_STEPS.map((st) => (st.id === step.id ? { ...st, version: st.version + 1 } : st));
      const seen = markSeen(legacy, ONBOARDING_STEPS.map((st) => st.id));
      expect(pendingSteps({ ...legacy, onboardingSteps: seen }, bumped).map((st) => st.id)).toEqual([step.id]);
    }
  });
});

describe('aan de slag-lijstje', () => {
  it('vinkt zichzelf af op basis van de administratie', () => {
    const s = emptyServices();
    const open = () => s.checklist.items().filter((i) => !i.done).map((i) => i.key);
    expect(open()).toEqual(['bedrijf', 'iban', 'klant', 'factuur', 'bank', 'bon', 'email']);

    const { s: filled } = setup();
    expect(filled.checklist.items().find((i) => i.key === 'klant')?.done).toBe(true);
    expect(filled.checklist.items().find((i) => i.key === 'factuur')?.done).toBe(false);
  });
});

describe('demo', () => {
  it('vult een lege administratie met een kloppende demo', () => {
    const s = emptyServices();
    seedDemo(s, '2026-09-26');
    const st = s.settings.get();
    expect(st.demoMode).toBe(true);
    expect(st.onboardingDone).toBe(true);
    expect(pendingSteps(st)).toEqual([]);
    expect(s.invoices.list().length).toBe(5);
    expect(s.invoices.list({ status: 'betaald' }).length).toBe(2);
    expect(s.invoices.list({ status: 'vervallen' }).length).toBe(1);
    expect(s.quotes.list().length).toBe(2);
    expect(s.jobs.list({ active: true }).length).toBe(1);
    expect(s.ledger.checkIntegrity()).toMatchObject({ balanced: true });
    expect(s.inbox.home().tasks.length).toBeGreaterThan(0);
    for (const r of s.relations.list()) if (r.iban) expect(isValidIban(r.iban)).toBe(true);
    expect(hasRealData(s.db)).toBe(false);
  });

  it('gaat er iets mis, dan blijft de administratie leeg', () => {
    const s = emptyServices();
    const original = s.inbox.autoProcess.bind(s.inbox);
    s.inbox.autoProcess = () => {
      throw new Error('stuk');
    };
    expect(() => seedDemo(s, '2026-09-26')).toThrow('stuk');
    expect(s.settings.get().demoMode).toBe(false);
    expect(s.relations.list()).toEqual([]);
    s.inbox.autoProcess = original;
    seedDemo(s, '2026-09-26');
    expect(s.settings.get().demoMode).toBe(true);
  });

  it('weigert een administratie met gegevens', () => {
    const { s } = setup();
    expect(() => seedDemo(s)).toThrow(/lege administratie/);
  });

  it('verstuurt in de demo geen e-mail', async () => {
    const s = emptyServices();
    seedDemo(s, '2026-09-26');
    const inv = s.invoices.list({ status: 'openstaand' })[0]!;
    await expect(s.sender.sendInvoice(inv.id)).rejects.toThrow(/demo/);
  });
});

describe('wissen', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('echte gegevens: eerst een veiligheidskopie, daarna een lege administratie', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gb-wis-'));
    const file = join(dir, 'boekhouding.sqlite');
    const s = emptyServices(openDatabase(file));
    s.relations.create({ name: 'Echte klant', address: 'Straat 1', city: 'Utrecht' });
    expect(hasRealData(s.db)).toBe(true);

    const backup = await wipeDatabase(s.db, file, join(dir, 'backups'));
    expect(backup && existsSync(backup)).toBeTruthy();
    expect(existsSync(file)).toBe(false);

    const fresh = emptyServices(openDatabase(file));
    expect(fresh.relations.list()).toEqual([]);
    expect(fresh.settings.get().onboardingDone).toBe(false);
    fresh.db.close();
  });

  it('demo wissen: geen kopie nodig', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gb-wis-'));
    const file = join(dir, 'boekhouding.sqlite');
    const s = emptyServices(openDatabase(file));
    seedDemo(s, '2026-09-26');
    expect(await wipeDatabase(s.db, file, join(dir, 'backups'))).toBeNull();
    expect(existsSync(join(dir, 'backups'))).toBe(false);
  });

  it('bijlagen: weg bij de demo, bewaard bij echte gegevens (de kopie verwijst ernaar)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gb-wis-'));
    const file = join(dir, 'boekhouding.sqlite');
    const bijlagen = join(dir, 'bijlagen');
    mkdirSync(bijlagen);
    const bon = (name: string) => {
      const p = join(bijlagen, name);
      writeFileSync(p, 'x');
      return p;
    };

    const demo = emptyServices(openDatabase(file));
    seedDemo(demo, '2026-09-26');
    const demoBon = bon('demo.pdf');
    demo.purchases.create({ invoiceDate: '2026-09-20', description: 'bon', attachmentPath: demoBon, lines: [{ account: 'WBedAlkOvr', netAmount: 1000, vatCode: 'geen', vatAmount: 0 }] });
    const los = bon('los.pdf');
    await wipeDatabase(demo.db, file, join(dir, 'backups'), bijlagen);
    expect(existsSync(demoBon)).toBe(false);
    expect(existsSync(los)).toBe(true);

    const real = emptyServices(openDatabase(file));
    const echteBon = bon('echt.pdf');
    real.purchases.create({ invoiceDate: '2026-09-20', description: 'bon', attachmentPath: echteBon, lines: [{ account: 'WBedAlkOvr', netAmount: 1000, vatCode: 'geen', vatAmount: 0 }] });
    expect(await wipeDatabase(real.db, file, join(dir, 'backups'), bijlagen)).toBeTruthy();
    expect(existsSync(echteBon)).toBe(true);
  });
});
