import { decide, type AutopilotLevel, type Decision, type Signal } from '../automation/decisions';
import { EXPENSE_CATEGORIES } from '../shared/categories';
import { formatEuro } from '../shared/money';
import type { BankTransaction } from '../import/bank';
import type { Classification } from './classify';
import { vatFromDocument } from './classify';
import type { SupplierRule } from './supplier-memory';
import type { DocumentResult, Issue } from './types';

const hasIssue = (issues: Issue[], field: string) => issues.some((i) => i.field === field || i.field.startsWith(`${field}.`));

/**
 * Zekerheid per veld en per beslissing voor een document (#21), plus de signalen voor de
 * "Waarom?"-uitleg (#28). Puur: geen database.
 */
export function documentDecisions(input: {
  doc: DocumentResult;
  issues: Issue[];
  classification: Classification;
  bankMatch: BankTransaction | null;
  rule: SupplierRule | null;
  level: AutopilotLevel;
}): { decisions: Decision[]; signals: Signal[] } {
  const { doc, issues, classification: c, bankMatch, rule, level } = input;
  const category = EXPENSE_CATEGORIES.find((x) => x.key === c.categoryKey)?.label.toLowerCase() ?? c.categoryKey;
  const docVat = vatFromDocument(doc);

  const signals: Signal[] = [];
  const keyFields = [doc.supplier, doc.invoiceDate, doc.total].map((f) => f?.confidence ?? 0);
  signals.push({ type: 'extractie', label: 'tekst herkend', value: Math.min(...keyFields) });
  if (doc.total?.source === 'ubl') signals.push({ type: 'e-factuur', label: 'het een e-factuur is', value: 1 });
  const errors = issues.filter((i) => i.severity === 'fout').length;
  signals.push({ type: 'validatie', label: 'bedragen gecontroleerd', value: errors === 0 ? 1 : 0 });
  if (rule && c.source === 'geheugen') {
    signals.push({
      type: 'leveranciersregel',
      label: `je ${rule.confirmations} eerdere aankopen bij ${rule.display_name} als ${category} hebt bevestigd${c.automatic ? ' en hebt gezegd dat dit voortaan automatisch mag' : ''}`,
      value: c.confidence,
    });
  } else {
    signals.push({ type: 'standaard', label: `het op ${category} lijkt`, value: c.confidence });
  }
  if (docVat) {
    const rates = [...new Set(doc.vat.value.map((v) => v.rate))];
    signals.push({ type: 'document-btw', label: docVat === 'verlegd' ? 'op het document "btw verlegd" staat' : `het document ${rates.join('% en ')}% btw vermeldt`, value: doc.vat.confidence });
  }
  if (bankMatch) signals.push({ type: 'bankbetaling', label: `we een bankbetaling van ${formatEuro(-bankMatch.amount)} hebben gevonden`, value: 1 });

  // Netto + btw = totaal (en geen fouten daarop): dan zijn totaal en btw onafhankelijk bevestigd.
  const vatSum = doc.vat.value.reduce((s, v) => s + v.amount, 0);
  const consistent = !!doc.total && !!doc.subtotal && doc.vat.value.length > 0 && doc.subtotal.value + vatSum === doc.total.value && !hasIssue(issues, 'total') && !hasIssue(issues, 'vat');
  if (consistent) signals.push({ type: 'validatie', label: 'netto + btw precies het totaal is', value: 1 });
  const boost = (conf: number | undefined) => (consistent ? Math.max(conf ?? 0, 0.95) : conf ?? 0);
  const fieldConf = (conf: number | undefined, field: string) => (hasIssue(issues, field) ? Math.min(conf ?? 0, 0.5) : conf ?? 0);
  const extraction = signals.filter((s) => s.type === 'extractie' || s.type === 'e-factuur' || s.type === 'validatie');
  const choice = signals.filter((s) => s.type === 'leveranciersregel' || s.type === 'standaard');
  const decisions: Decision[] = [
    decide('veld:leverancier', 'Winkel / leverancier', doc.supplier?.value ?? '?', fieldConf(doc.supplier?.confidence, 'supplier'), extraction, level, 'supplier'),
    decide('veld:datum', 'Datum', doc.invoiceDate?.value ?? '?', fieldConf(doc.invoiceDate?.confidence, 'invoiceDate'), extraction, level, 'invoiceDate'),
    decide('veld:totaal', 'Totaal', doc.total ? formatEuro(doc.total.value) : '?', fieldConf(boost(doc.total?.confidence), 'total'), extraction, level, 'total'),
    decide('veld:btw', 'BTW', doc.vat.value.map((v) => `${v.rate}%`).join(', ') || '?', doc.vat.value.length === 0 ? 0.5 : fieldConf(boost(doc.vat.confidence), 'vat'), extraction, level, 'vat'),
    decide('categorie', 'Waar was het voor', category, c.automatic ? c.confidence : Math.min(c.confidence, 0.8), choice, level),
    decide(
      'btw-behandeling',
      'BTW-keuze',
      c.vatCode,
      docVat && docVat === c.vatCode ? 0.95 : c.automatic ? 0.9 : 0.7,
      signals.filter((s) => s.type === 'document-btw' || s.type === 'leveranciersregel'),
      level,
    ),
    decide('zakelijk', 'Zakelijk of privé', c.business ? 'zakelijk' : 'privé', c.automatic ? c.confidence : Math.min(c.confidence, 0.8), choice, level),
  ];
  return { decisions, signals };
}
