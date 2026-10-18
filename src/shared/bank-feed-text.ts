import type { FeedAccountInfo, FeedTestAccount } from '../bankfeed/bankfeed';
import { formatDateNl } from './dates';

type LinkState = Pick<FeedTestAccount, 'suggestedBankAccountId' | 'link'>;

export function pontoLinkText(account: LinkState): string {
  if (account.suggestedBankAccountId == null) return 'Geen bestaande rekening gevonden. Eerdere periode nog onderbouwen met een afschrift/openingssaldo.';
  if (account.link.proven && account.link.completeTo) return `Sluit aantoonbaar aan op je afschriften t/m ${formatDateNl(account.link.completeTo)}.`;
  if (account.link.from) return `Aansluiting vanaf ${formatDateNl(account.link.from)} is nog niet bewezen. Eerdere periode nog onderbouwen met een afschrift/openingssaldo.`;
  return 'Eerdere periode nog onderbouwen met een afschrift/openingssaldo.';
}

export function pontoAccountStatusText(account: Pick<FeedAccountInfo, 'coveredTo' | 'gap' | 'lastErrorKind'>): string {
  if (account.gap) return `Ontbrekende periode van ${formatDateNl(account.gap.from)} t/m ${formatDateNl(account.gap.to)}. Onderbouw die met een afschrift/openingssaldo.`;
  if (account.coveredTo) return `Laatst volledig bijgewerkt t/m ${formatDateNl(account.coveredTo)}.`;
  if (account.lastErrorKind) return `Niet volledig bijgewerkt: ${pontoErrorKindText(account.lastErrorKind)}`;
  return 'Nog geen volledig bijgewerkte periode. Eerdere periode nog onderbouwen met een afschrift/openingssaldo.';
}

export function pontoCooldownText(allowedAt: string, now = new Date()): string {
  const at = new Date(allowedAt);
  if (Number.isNaN(at.getTime()) || at <= now) return 'Nu bijwerken';
  return `Kan weer om ${at.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}`;
}

/** Leesbare uitleg bij een veilige foutsoort uit de bankfeed; onbekende soorten blijven zichtbaar. */
export function pontoErrorKindText(kind: string): string {
  switch (kind) {
    case 'credentials': return 'Ponto weigert de inloggegevens. Plak Client ID en Secret opnieuw.';
    case 'forbidden': return 'Geen toegang bij Ponto. Controleer de toestemming van de integratie.';
    case 'rate-limit': return 'Ponto vraagt om even te wachten (te veel verzoeken). Probeer het later opnieuw.';
    case 'server': return 'Ponto of de bank heeft een storing. Probeer het later opnieuw.';
    case 'network': return 'Geen verbinding met Ponto. Controleer je internet, VPN of firewall.';
    case 'timeout': return 'Ponto reageerde niet op tijd. Probeer het later opnieuw.';
    case 'bad-response': return 'Ponto gaf een onverwacht antwoord.';
    case 'account-gone': return 'De rekening bestaat niet meer bij Ponto.';
    case 'synchronization-error': return 'De bank gaf een fout bij het ophalen. Probeer het later opnieuw.';
    case 'geblokkeerd': return 'De actie is niet gestart.';
    default: return `onbekende fout (${kind}).`;
  }
}
