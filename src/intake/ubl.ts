import { XMLParser } from 'fast-xml-parser';
import { parseEuro } from '../shared/money';
import type { DocumentResult, Field } from './types';

/**
 * Gestructureerde e-factuur (UBL 2.1 / SI-UBL 2.0 / NLCIUS / Peppol BIS).
 * Structured data heeft altijd voorrang op tekstherkenning: confidence 1.
 */
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, parseTagValue: false, isArray: (n) => ['TaxSubtotal', 'InvoiceLine', 'CreditNoteLine', 'PaymentMeans'].includes(n) });

type X = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const t = (v: unknown): string => (v == null ? '' : typeof v === 'object' ? String((v as X)['#text'] ?? '') : String(v));
const f = <T>(value: T): Field<T> => ({ value, confidence: 1, source: 'ubl' });

export function isUbl(xml: string): boolean {
  return /<(\w+:)?(Invoice|CreditNote)[\s>]/.test(xml.slice(0, 3000)) && /urn:oasis:names:specification:ubl/.test(xml.slice(0, 3000));
}

export function parseUbl(xml: string): DocumentResult {
  const doc = parser.parse(xml) as X;
  const inv: X | undefined = doc.Invoice ?? doc.CreditNote;
  if (!inv) throw new Error('Geen UBL Invoice of CreditNote');
  const isCredit = Boolean(doc.CreditNote);
  const sign = isCredit ? -1 : 1;
  const supplierParty = inv.AccountingSupplierParty?.Party ?? {};
  const name = t(supplierParty.PartyLegalEntity?.RegistrationName) || t(supplierParty.PartyName?.Name);
  const vatId = t(supplierParty.PartyTaxScheme?.CompanyID);
  const iban = t((inv.PaymentMeans ?? [])[0]?.PayeeFinancialAccount?.ID);
  const totals = inv.LegalMonetaryTotal ?? {};
  const taxTotal: X = Array.isArray(inv.TaxTotal) ? inv.TaxTotal[0] : inv.TaxTotal ?? {};
  const vat = ((taxTotal.TaxSubtotal ?? []) as X[]).map((s) => ({
    rate: Number(t(s.TaxCategory?.Percent) || 0),
    base: sign * parseEuro(t(s.TaxableAmount) || '0'),
    amount: sign * parseEuro(t(s.TaxAmount) || '0'),
  }));
  const reverseCharge = ((taxTotal.TaxSubtotal ?? []) as X[]).some((s) => t(s.TaxCategory?.ID) === 'AE');
  const rawLines = (inv.InvoiceLine ?? inv.CreditNoteLine ?? []) as X[];
  const lines = rawLines.map((l) => t(l.Item?.Name) || t(l.Item?.Description)).filter(Boolean);
  const items = rawLines.map((l) => {
    const qtyRaw = t(l.InvoicedQuantity ?? l.CreditedQuantity);
    const price = t(l.Price?.PriceAmount);
    // de prijs kan voor meerdere stuks gelden (BaseQuantity, bv. per 100): omrekenen naar per stuk
    const baseQty = Number(t(l.Price?.BaseQuantity) || 1) || 1;
    const rate = t(l.Item?.ClassifiedTaxCategory?.Percent);
    return f({
      description: t(l.Item?.Name) || t(l.Item?.Description) || 'Regel',
      quantity: qtyRaw ? sign * Number(qtyRaw) : null,
      unitPrice: price ? Math.round(parseEuro(price) / baseQty) : null,
      amount: sign * parseEuro(t(l.LineExtensionAmount) || '0'),
      vatRate: rate !== '' ? Number(rate) : null,
    });
  });
  const subtotalCents = t(totals.LineExtensionAmount || totals.TaxExclusiveAmount) ? sign * parseEuro(t(totals.LineExtensionAmount || totals.TaxExclusiveAmount)) : null;
  const linesBasis = items.length && subtotalCents !== null && items.reduce((s, i) => s + i.value.amount, 0) === subtotalCents ? ('excl' as const) : null;
  return {
    documentType: f(isCredit ? 'credit_note' : 'purchase_invoice'),
    supplier: name ? f(name) : null,
    supplierVatNumber: vatId ? f(vatId) : null,
    supplierIban: iban ? f(iban.replace(/\s/g, '')) : null,
    invoiceNumber: t(inv.ID) ? f(t(inv.ID)) : null,
    invoiceDate: t(inv.IssueDate) ? f(t(inv.IssueDate)) : null,
    dueDate: t(inv.DueDate) ? f(t(inv.DueDate)) : null,
    currency: f(t(inv.DocumentCurrencyCode) || 'EUR'),
    subtotal: t(totals.TaxExclusiveAmount) ? f(sign * parseEuro(t(totals.TaxExclusiveAmount))) : null,
    vat: f(vat),
    total: t(totals.PayableAmount || totals.TaxInclusiveAmount) ? f(sign * parseEuro(t(totals.PayableAmount || totals.TaxInclusiveAmount))) : null,
    lineDescriptions: lines,
    lines: items,
    linesBasis,
    reverseCharge,
    rawText: '',
  };
}

/** Een PDF kan een UBL-bijlage bevatten (bv. ZUGFeRD/Factur-X of NL e-facturen). */
export function findEmbeddedUbl(attachments: { filename: string; content: Uint8Array }[]): string | null {
  for (const a of attachments) {
    if (!/\.xml$/i.test(a.filename)) continue;
    const xml = Buffer.from(a.content).toString('utf8');
    if (isUbl(xml)) return xml;
  }
  return null;
}
