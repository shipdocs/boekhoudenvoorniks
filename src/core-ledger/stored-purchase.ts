import { purchaseVat, type PurchaseLineInput } from './rules';
import { purchaseVat as legacyPurchaseVat, expenseLines as legacyExpenseLines } from './rules-2026-2';

/** Alleen voor het lezen van reeds geboekte gegevens. Nieuwe boekingen blijven strikt gevalideerd. */
export const storedPurchaseVat = legacyPurchaseVat;
export const storedExpenseLines = legacyExpenseLines;

export function storedVatWarning(lines: PurchaseLineInput[]): string | null {
  for (const line of lines) {
    try { purchaseVat(line); }
    catch { return 'De opgeslagen btw past niet bij het tarief. Controleer de oorspronkelijke bon en corrigeer deze aankoop met je boekhouder.'; }
  }
  return null;
}
