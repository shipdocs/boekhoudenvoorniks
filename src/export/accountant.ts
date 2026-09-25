import type { Db } from '../db/database';
import type { Ledger } from '../core-ledger/ledger';
import type { CompanySettings } from '../settings/settings';
import { centsToDecimalString } from '../shared/money';
import { escapeHtml } from '../documents/render';
import type { IsoDate } from '../shared/dates';

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Export voor de boekhouder: journaal, grootboek en saldibalans met RGS-codes. */
export class AccountantExport {
  constructor(private readonly db: Db, private readonly ledger: Ledger) {}

  journalCsv(from: IsoDate, to: IsoDate): string {
    const rows = this.db
      .prepare(
        `SELECT e.id, e.entry_date, e.description, e.source, e.status, a.code, a.rgs_ref, a.name, l.debit, l.credit, l.vat_code, r.name AS relation
         FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
         JOIN chart_of_accounts a ON a.id = l.account_id LEFT JOIN relations r ON r.id = l.relation_id
         WHERE e.entry_date BETWEEN ? AND ? ORDER BY e.entry_date, e.id, l.id`,
      )
      .all(from, to) as Record<string, unknown>[];
    const header = ['Boekstuk', 'Datum', 'Omschrijving', 'Bron', 'Status', 'Rekening', 'RGS', 'Rekeningnaam', 'Debet', 'Credit', 'BTW-code', 'Relatie'];
    const lines = rows.map((r) =>
      [r.id, r.entry_date, r.description, r.source, r.status, r.code, r.rgs_ref, r.name, centsToDecimalString(r.debit as number), centsToDecimalString(r.credit as number), r.vat_code, r.relation].map(csvCell).join(';'),
    );
    return [header.join(';'), ...lines].join('\r\n') + '\r\n';
  }

  trialBalanceCsv(from: IsoDate, to: IsoDate): string {
    const header = ['Rekening', 'RGS', 'Naam', 'Categorie', 'Debet', 'Credit', 'Saldo'];
    const lines = this.ledger
      .balances({ from, to })
      .filter((b) => b.debit !== 0 || b.credit !== 0)
      .map((b) => [b.code, b.rgs_ref ?? '', b.name, b.category, centsToDecimalString(b.debit), centsToDecimalString(b.credit), centsToDecimalString(b.balance)].map(csvCell).join(';'));
    return [header.join(';'), ...lines].join('\r\n') + '\r\n';
  }

  /**
   * XML Auditfile Financieel (XAF 3.2) — het standaard uitwisselformaat voor accountants
   * en de Belastingdienst. Bevat grootboek, relaties en alle journaalposten.
   */
  auditfile(from: IsoDate, to: IsoDate, company: CompanySettings, softwareVersion: string): string {
    const x = escapeHtml;
    const amount = (c: number) => centsToDecimalString(c);
    const accounts = this.ledger.listAccounts(true);
    const relations = this.db.prepare('SELECT * FROM relations ORDER BY id').all() as { id: number; name: string; type: string; address: string | null; postcode: string | null; city: string | null; country: string; vat_number: string | null; kvk_number: string | null; iban: string | null }[];
    const entries = this.db
      .prepare(`SELECT * FROM journal_entries WHERE entry_date BETWEEN ? AND ? ORDER BY entry_date, id`)
      .all(from, to) as { id: number; entry_date: string; description: string; source: string }[];
    const lines = this.db
      .prepare(
        `SELECT l.*, a.code FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id
         JOIN journal_entries e ON e.id = l.journal_entry_id WHERE e.entry_date BETWEEN ? AND ? ORDER BY l.id`,
      )
      .all(from, to) as { id: number; journal_entry_id: number; code: string; debit: number; credit: number; relation_id: number | null; vat_code: string | null; description: string | null }[];
    const byEntry = new Map<number, typeof lines>();
    for (const l of lines) byEntry.set(l.journal_entry_id, [...(byEntry.get(l.journal_entry_id) ?? []), l]);
    const journals = [...new Set(entries.map((e) => e.source))];
    const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
    const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
    const accTp = (cat: string) => (cat === 'omzet' || cat === 'kosten' ? 'P' : 'B');

    return `<?xml version="1.0" encoding="UTF-8"?>
<auditfile xmlns="http://www.auditfiles.nl/XAF/3.2">
  <header>
    <fiscalYear>${from.slice(0, 4)}</fiscalYear>
    <startDate>${from}</startDate>
    <endDate>${to}</endDate>
    <curCode>EUR</curCode>
    <dateCreated>${new Date().toISOString().slice(0, 10)}</dateCreated>
    <softwareDesc>Gratis Boekhouden</softwareDesc>
    <softwareVersion>${x(softwareVersion)}</softwareVersion>
  </header>
  <company>
    <companyIdent>${x(company.kvkNumber)}</companyIdent>
    <companyName>${x(company.name)}</companyName>
    <taxRegistrationCountry>NL</taxRegistrationCountry>
    <taxRegIdent>${x(company.vatNumber)}</taxRegIdent>
    <streetAddress><streetname>${x(company.address)}</streetname><city>${x(company.city)}</city><postalCode>${x(company.postcode)}</postalCode><country>NL</country></streetAddress>
    <customersSuppliers>
${relations
  .map(
    (r) => `      <customerSupplier>
        <custSupID>${r.id}</custSupID>
        <custSupName>${x(r.name)}</custSupName>
        <custSupTp>${r.type === 'leverancier' ? 'S' : r.type === 'beide' ? 'B' : 'C'}</custSupTp>
${r.kvk_number ? `        <commerceNr>${x(r.kvk_number)}</commerceNr>\n` : ''}${r.vat_number ? `        <taxRegIdent>${x(r.vat_number)}</taxRegIdent>\n` : ''}        <streetAddress><streetname>${x(r.address ?? '')}</streetname><city>${x(r.city ?? '')}</city><postalCode>${x(r.postcode ?? '')}</postalCode><country>${x(r.country)}</country></streetAddress>
${r.iban ? `        <bankAccount><bankAccNr>${x(r.iban)}</bankAccNr></bankAccount>\n` : ''}      </customerSupplier>`,
  )
  .join('\n')}
    </customersSuppliers>
    <generalLedger>
${accounts.map((a) => `      <ledgerAccount><accID>${x(a.code)}</accID><accDesc>${x(a.name)}</accDesc><accTp>${accTp(a.category)}</accTp>${a.rgs_ref ? `<taxonomies><taxonomy><txAcctMap><txLink>${x(a.rgs_ref)}</txLink></txAcctMap></taxonomy></taxonomies>` : ''}</ledgerAccount>`).join('\n')}
    </generalLedger>
    <transactions>
      <linesCount>${lines.length}</linesCount>
      <totalDebit>${amount(totalDebit)}</totalDebit>
      <totalCredit>${amount(totalCredit)}</totalCredit>
${journals
  .map(
    (j) => `      <journal>
        <jrnID>${x(j)}</jrnID>
        <desc>${x(j)}</desc>
        <jrnTp>${j === 'factuur' ? 'S' : j === 'inkoop' ? 'P' : j === 'bank' ? 'B' : 'G'}</jrnTp>
${entries
  .filter((e) => e.source === j)
  .map(
    (e) => `        <transaction>
          <nr>${e.id}</nr>
          <desc>${x(e.description)}</desc>
          <periodNumber>${Number(e.entry_date.slice(5, 7))}</periodNumber>
          <trDt>${e.entry_date}</trDt>
          <amnt>${amount((byEntry.get(e.id) ?? []).reduce((s, l) => s + l.debit, 0))}</amnt>
${(byEntry.get(e.id) ?? [])
  .map(
    (l) => `          <trLine>
            <nr>${l.id}</nr>
            <accID>${x(l.code)}</accID>
            <docRef>${e.id}</docRef>
            <effDate>${e.entry_date}</effDate>
            <desc>${x(l.description ?? e.description)}</desc>
            <amnt>${amount(l.debit || l.credit)}</amnt>
            <amntTp>${l.debit ? 'D' : 'C'}</amntTp>
${l.relation_id ? `            <custSupID>${l.relation_id}</custSupID>\n` : ''}          </trLine>`,
  )
  .join('\n')}
        </transaction>`,
  )
  .join('\n')}
      </journal>`,
  )
  .join('\n')}
    </transactions>
  </company>
</auditfile>
`;
  }
}
