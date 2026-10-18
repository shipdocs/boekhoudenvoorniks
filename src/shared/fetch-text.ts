import type { PollResult } from '../mail/mail-intake';
import type { RoundSummary } from '../bankfeed/bankfeed';
import { pontoErrorKindText } from './bank-feed-text';

export interface FetchOutcome {
  ok: boolean;
  lines: string[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function mailFetchOutcome(r: PollResult): FetchOutcome {
  const parts = [
    plural(r.documents, 'bonnetje', 'bonnetjes'),
    r.onlineInvoices ? `${r.onlineInvoices} online` : '',
    r.fromCustomers ? `${r.fromCustomers} van klanten` : '',
    r.other ? `${r.other} zonder factuur of bon (blijft staan)` : '',
  ].filter(Boolean);
  const lines = [`Mail opgehaald: ${parts.join(', ')}.`];
  if (r.errors) lines.push(`${plural(r.errors, 'bericht', 'berichten')} niet te lezen.`);
  if (r.missingFolders.length) lines.push(`Map niet gevonden: ${r.missingFolders.join(', ')}.`);
  return { ok: r.errors === 0 && r.missingFolders.length === 0, lines };
}

export function bankFetchOutcome(s: RoundSummary): FetchOutcome {
  const imported = s.accounts.reduce((sum, a) => sum + a.imported, 0);
  const lines = [`Bank opgehaald: ${plural(imported, 'nieuwe transactie', 'nieuwe transacties')}.`];
  for (const f of s.failed) lines.push(pontoErrorKindText(f.errorKind));
  if (s.skipped.length) lines.push(`${plural(s.skipped.length, 'rekening', 'rekeningen')} overgeslagen: de bank gaf ze tijdelijk alleen-lezen.`);
  return { ok: s.failed.length === 0, lines };
}

export function errorOutcome(label: string, message: string): FetchOutcome {
  return { ok: false, lines: [`${label} lukte niet. ${message}`] };
}
