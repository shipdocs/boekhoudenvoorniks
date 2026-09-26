import QRCode from 'qrcode';
import { isValidIban, normalizeIban, ValidationError } from '../shared/validation';
import type { PurchaseService } from './purchases';
import type { Cents } from '../shared/money';

/**
 * SEPA-betaal-QR volgens EPC069-12 ("GiroCode"): bank-apps lezen hieruit IBAN, naam, bedrag en
 * omschrijving. Versie 002, UTF-8, SCT. BIC is optioneel (binnen de EER).
 */
export const EPC_MAX_AMOUNT: Cents = 99_999_999_999; // € 999.999.999,99
const MAX_PAYLOAD_BYTES = 331;

export interface EpcInput {
  name: string;
  iban: string;
  bic?: string | null;
  amount: Cents;
  /** gestructureerde betalingskenmerk (max 35), óf */
  reference?: string | null;
  /** vrije omschrijving, bv. het factuurnummer (max 140) */
  text?: string | null;
}

export function buildEpcPayload(input: EpcInput): string {
  const iban = normalizeIban(input.iban);
  if (!isValidIban(iban)) throw new ValidationError(`Ongeldig IBAN: ${input.iban}`);
  if (!Number.isSafeInteger(input.amount) || input.amount < 1) throw new ValidationError('Het bedrag moet minimaal € 0,01 zijn');
  if (input.amount > EPC_MAX_AMOUNT) throw new ValidationError('Dit bedrag is te hoog voor een betaal-QR (maximaal € 999.999.999,99)');
  const name = input.name.trim().replace(/\s+/g, ' ').slice(0, 70);
  if (!name) throw new ValidationError('De naam van de ontvanger ontbreekt');
  const bic = (input.bic ?? '').replace(/\s/g, '').toUpperCase();
  if (bic && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)) throw new ValidationError(`Ongeldige BIC: ${input.bic}`);
  const reference = (input.reference ?? '').trim();
  const text = (input.text ?? '').trim().slice(0, 140);
  if (reference && text) throw new ValidationError('Gebruik óf een betalingskenmerk óf een omschrijving');
  if (reference.length > 35) throw new ValidationError('Het betalingskenmerk is te lang (maximaal 35 tekens)');
  const euros = `EUR${Math.floor(input.amount / 100)}.${String(input.amount % 100).padStart(2, '0')}`;
  const lines = ['BCD', '002', '1', 'SCT', bic, name, iban, euros, '', reference, text];
  // lege regels aan het eind mogen weg
  while (lines.length > 8 && lines[lines.length - 1] === '') lines.pop();
  const payload = lines.join('\n');
  if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) throw new ValidationError('De betaalgegevens passen niet in een betaal-QR');
  return payload;
}

/** Leest een EPC-payload terug (voor tests en controle). */
export function parseEpcPayload(payload: string): { name: string; iban: string; bic: string; amount: Cents; reference: string; text: string } {
  const l = payload.split('\n');
  if (l[0] !== 'BCD' || l[1] !== '002' || l[2] !== '1' || l[3] !== 'SCT') throw new Error('Geen EPC-QR (versie 002)');
  const m = /^EUR(\d+)\.(\d{2})$/.exec(l[7] ?? '');
  if (!m) throw new Error('Ongeldig bedrag');
  return { bic: l[4] ?? '', name: l[5] ?? '', iban: l[6] ?? '', amount: Number(m[1]) * 100 + Number(m[2]), reference: l[9] ?? '', text: l[10] ?? '' };
}

export type PaymentQr =
  | { needsConfirm: true; warning: string; iban: string; name: string; amount: Cents; dueDate: string | null }
  | { needsConfirm: false; warning: string | null; svg: string; payload: string; iban: string; name: string; amount: Cents; dueDate: string | null };

/**
 * Betaal-QR voor een open inkoop (#25). Ander IBAN dan eerder bij deze leverancier: eerst een
 * waarschuwing en pas na expliciete bevestiging de QR-code.
 */
export async function purchasePaymentQr(purchases: PurchaseService, id: number, confirmNewIban = false): Promise<PaymentQr> {
  const info = purchases.paymentInfo(id);
  const p = info.purchase;
  if (p.open_amount <= 0) throw new ValidationError('Deze rekening is al betaald');
  if (!info.iban) throw new ValidationError('We kennen het rekeningnummer van deze leverancier niet. Betaal via je bank-app met de gegevens op de factuur.');
  if (!info.ibanValid) throw new ValidationError(`Het rekeningnummer ${info.iban} klopt niet (controlegetal). Controleer de factuur.`);
  const base = { iban: info.iban, name: info.name, amount: p.open_amount, dueDate: p.due_date };
  if (info.ibanChanged && !confirmNewIban) {
    return { ...base, needsConfirm: true, warning: `Let op: ander rekeningnummer dan vorige keer (eerder ${info.knownIbans.join(', ')}). Bel de leverancier op een bekend nummer als je twijfelt.` };
  }
  const payload = buildEpcPayload({ name: info.name, iban: info.iban, amount: p.open_amount, text: p.supplier_reference ? `Factuur ${p.supplier_reference}` : p.description });
  const svg = await QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
  return { ...base, needsConfirm: false, svg, payload, warning: info.ibanChanged ? 'Je hebt bevestigd dat dit nieuwe rekeningnummer klopt.' : null };
}
