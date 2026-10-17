import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { createApi, type HostContext } from '../src/main/api';
import { detectFormat } from '../src/import/detect';
import { CSV_EXTENSIONS, isStatementName, MT940_EXTENSIONS, STATEMENT_ACCEPT, STATEMENT_EXTENSIONS } from '../src/shared/statement-files';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Een afschrift van een rekening die nog niet in de administratie staat (#459): eerst vragen in plaats van stil
 * een "Rekening 4321" aan te maken. En één lijst met extensies voor slepen, downloadmap en herkennen.
 */

const ZAKELIJK = 'NL91ABNA0417164300';
const PRIVE = 'NL20INGB0001234567';

function camt(ibans: string[]): string {
  const stmt = (iban: string, n: number) => `<Stmt><Id>${n}</Id><Acct><Id><IBAN>${iban}</IBAN></Id></Acct>
    <Ntry><Amt Ccy="EUR">12.50</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-09-0${n}</Dt></BookgDt><AcctSvcrRef>R${iban.slice(-4)}${n}</AcctSvcrRef>
      <NtryDtls><TxDtls><RltdPties><Cdtr><Nm>Bakker</Nm></Cdtr></RltdPties><RmtInf><Ustrd>brood</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry></Stmt>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt>${ibans.map((i, n) => stmt(i, n + 1)).join('')}</BkToCstmrStmt></Document>`;
}

function start(opts: { zakelijkIban?: string | null } = {}) {
  const ctx = setup();
  const first = ctx.s.bank.ensureDefaultAccount();
  if (opts.zakelijkIban !== null) ctx.s.bank.updateAccount(first.id, { name: 'Zakelijk', iban: opts.zakelijkIban ?? ZAKELIJK });
  const api = createApi(ctx.s, { appVersion: () => 'test' } as unknown as HostContext);
  const accounts = () => ctx.s.bank.listAccounts().map((a) => ({ name: a.name, iban: a.iban }));
  return { ...ctx, api, first, accounts };
}

describe('afschrift van een rekening die nog niet in de administratie staat (#459)', () => {
  it('vraagt eerst en leest nog niets in', async () => {
    const t = start();
    const r = await t.api.bank.importFile('prive.xml', camt([PRIVE]));
    expect(r).toEqual({ needsAccount: { ibans: [PRIVE], single: true } });
    expect(t.accounts()).toEqual([{ name: 'Zakelijk', iban: ZAKELIJK }]);
    expect(t.s.bank.list()).toEqual([]);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM import_batches').get()).toEqual({ n: 0 });
  });

  it('"Nieuwe rekening toevoegen" leest in op een nieuwe rekening, zoals vroeger', async () => {
    const t = start();
    const r = await t.api.bank.importFile('tweede.xml', camt([PRIVE]), undefined, undefined, true);
    expect(r).toMatchObject({ imported: 1 });
    expect(t.accounts()).toEqual([{ name: 'Zakelijk', iban: ZAKELIJK }, { name: 'Rekening 4567', iban: PRIVE }]);
  });

  it('"Hoort bij" leest in op die bestaande rekening, zonder een nieuwe aan te maken', async () => {
    const t = start();
    const r = await t.api.bank.importFile('nieuw-nummer.xml', camt([PRIVE]), undefined, t.first.id);
    expect(r).toMatchObject({ imported: 1 });
    expect(t.accounts()).toHaveLength(1);
    expect(t.s.bank.list().every((x) => x.bank_account_id === t.first.id)).toBe(true);
  });

  it('een bekende rekening, of de eerste rekening zonder IBAN: gewoon inlezen zonder vraag', async () => {
    const bekend = start();
    expect(await bekend.api.bank.importFile('zakelijk.xml', camt([ZAKELIJK]))).toMatchObject({ imported: 1 });
    const leeg = start({ zakelijkIban: null });
    expect(await leeg.api.bank.importFile('eerste.xml', camt([PRIVE]))).toMatchObject({ imported: 1 });
    expect(leeg.accounts()).toEqual([{ name: 'Zakelijke rekening', iban: PRIVE }]);
  });

  it('een afschrift met een bekende en een onbekende rekening: vragen, maar "hoort bij" kan dan niet', async () => {
    const t = start();
    expect(await t.api.bank.importFile('beide.xml', camt([ZAKELIJK, PRIVE]))).toEqual({ needsAccount: { ibans: [PRIVE], single: false } });
  });

  it('newAccountIbans: de lege rekening vangt het eerste onbekende nummer op, het tweede wordt gevraagd', () => {
    const t = start({ zakelijkIban: null });
    const row = (ownIban: string) => ({ date: '2026-09-01', amount: -100, description: 'x', ownIban });
    expect(t.s.bank.newAccountIbans({ transactions: [row(PRIVE), row(PRIVE), row(ZAKELIJK)] })).toEqual([ZAKELIJK]);
    // regels zonder eigen IBAN (CSV zonder rekeningkolom) gaan zoals altijd: geen vraag
    expect(t.s.bank.newAccountIbans({ transactions: [{ date: '2026-09-01', amount: -100, description: 'x' }] })).toEqual([]);
  });
});

describe('één lijst met extensies voor slepen, downloadmap en herkennen (#459)', () => {
  it('elke extensie in de lijst wordt herkend als het bijbehorende formaat', () => {
    for (const ext of MT940_EXTENSIONS) expect(detectFormat(`afschrift${ext}`, 'geen herkenbare inhoud')).toBe('mt940');
    for (const ext of CSV_EXTENSIONS) expect(detectFormat(`afschrift${ext}`, 'geen herkenbare inhoud')).toBe('csv');
    expect(STATEMENT_EXTENSIONS).toContain('.xml');
    expect(STATEMENT_ACCEPT.split(',')).toEqual([...STATEMENT_EXTENSIONS]);
    expect(isStatementName('Afschrift.MT940')).toBe(true);
    expect(isStatementName('afschrift.swi')).toBe(true);
    expect(isStatementName('afschrift.pdf')).toBe(false);
  });

  it('geen scherm heeft nog een eigen lijst in de broncode', () => {
    for (const file of ['Bank.tsx', 'Onboarding.tsx', 'Switchover.tsx']) {
      const src = readFileSync(join(__dirname, '..', 'src', 'renderer', 'screens', file), 'utf8');
      expect(src, file).not.toMatch(/accept="[^"]*\.sta/);
      expect(src, file).toContain('STATEMENT_ACCEPT');
    }
  });
});
