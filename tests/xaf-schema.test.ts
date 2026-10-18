import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

/**
 * De auditfile moet voldoen aan het officiële schema XmlAuditfileFinancieel3.2.xsd
 * (tests/fixtures; te vinden via softwarepakketten.nl). Boekhoudpakketten en viewers lezen hem
 * streng in. Deze test gebruikt xmllint (libxml2-utils) en slaat over als dat niet is geïnstalleerd.
 */
const hasXmllint = spawnSync('xmllint', ['--version']).status !== null;

describe.skipIf(!hasXmllint)('auditfile tegen het officiële XAF 3.2-schema', () => {
  it('een administratie met factuur, inkoop, bank, zakelijk deel en tegenboeking valideert', () => {
    const { s, klant } = setup();
    const inv = s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-02-10', lines: [{ description: 'x', quantity: 1, unitPrice: 100000, vatCode: 'hoog' }] }).id);
    s.invoices.registerPayment(inv.id, { amount: 121000, date: '2026-03-05' });
    const rel = s.relations.findOrCreateSupplier('Dropbox');
    s.purchases.create({ relationId: rel.id, invoiceDate: '2026-02-01', description: 'Dropbox', lines: [{ account: 'WBedKanSof', netAmount: 10000, vatCode: 'hoog' }], businessPct: 40 });
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-03-01', amount: -12100, description: 'Card Payment: Anthropic', counterName: 'Anthropic' }] });
    const t = s.bank.list()[0]!;
    s.bank.bookToAccount(t.id, { account: 'WBedKanSof', vatCode: 'buiten-eu' });
    s.bank.unmatch(t.id);
    s.vat.markSubmitted('2026-Q1', { alreadyFiled: true });

    const xaf = s.exports.auditfile('2026-01-01', '2026-12-31', s.settings.get().company, '0.0.0-test');
    const dir = mkdtempSync(join(tmpdir(), 'xaf-'));
    const file = join(dir, 'test.xaf');
    writeFileSync(file, xaf);
    let out = '';
    try {
      out = execFileSync('xmllint', ['--noout', '--schema', join(__dirname, 'fixtures', 'XmlAuditfileFinancieel3.2.xsd'), file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      throw new Error(`Auditfile voldoet niet aan XAF 3.2:\n${(e as { stderr?: string }).stderr ?? e}`);
    }
    expect(out).toBe('');
    // en de RGS-code staat als standaardveld bij elke rekening die er een heeft
    expect(xaf.match(/<leadReference>/g)!.length).toBeGreaterThan(20);
  });
});
