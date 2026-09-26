import type { Invoice } from './invoices';
import type { CompanySettings } from '../settings/settings';
import type { Relation } from '../relations/relations';
import { lineNet } from './totals';
import type { Cents } from '../shared/money';

/**
 * Uitgaande e-factuur (#24): UBL 2.1 volgens Peppol BIS Billing 3.0 / NLCIUS. Werkt zonder
 * netwerk: de XML gaat als bijlage mee met de PDF-mail. Structured data gaat bij de ontvanger
 * altijd vóór tekstherkenning.
 */
export const BIS_CUSTOMIZATION = 'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0';
export const BIS_PROFILE = 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0';

type Party = Pick<Relation, 'name' | 'address' | 'postcode' | 'city' | 'country' | 'vat_number' | 'kvk_number' | 'email'>;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const amt = (c: Cents) => (c / 100).toFixed(2);
const qty = (q: number) => String(Math.round(q * 1000) / 1000);

/** UNECE Rec 20-eenheden voor veelgebruikte eenheden van vakmensen. */
export function unitCode(unit: string | null | undefined): string {
  const u = (unit ?? '').trim().toLowerCase().replace('²', '2');
  if (['uur', 'uren', 'u'].includes(u)) return 'HUR';
  if (['m2', 'm^2', 'vierkante meter'].includes(u)) return 'MTK';
  if (['m', 'meter', 'strekkende meter', 'm1'].includes(u)) return 'MTR';
  if (['dag', 'dagen'].includes(u)) return 'DAY';
  if (['kg'].includes(u)) return 'KGM';
  if (['l', 'liter'].includes(u)) return 'LTR';
  if (['st', 'stuk', 'stuks'].includes(u)) return 'H87';
  return 'C62';
}

/** EN 16931 btw-categorie + reden voor vrijstelling/verlegging. */
export function taxCategory(vatCode: string, percentage: number): { id: string; percent: number; reason?: string; reasonCode?: string } {
  if (vatCode === 'verlegd') return { id: 'AE', percent: 0, reason: 'Btw verlegd', reasonCode: 'VATEX-EU-AE' };
  if (vatCode === 'vrijgesteld') return { id: 'E', percent: 0, reason: 'Vrijgesteld van btw (KOR)' };
  if (percentage === 0) return { id: 'Z', percent: 0 };
  return { id: 'S', percent: percentage };
}

/** Elektronisch adres (EAS): KvK (0106), NL-btw (9944), anders e-mail (EM). */
function endpoint(p: Party): { scheme: string; id: string } | null {
  if (p.kvk_number?.trim()) return { scheme: '0106', id: p.kvk_number.replace(/\s/g, '') };
  if (p.vat_number?.trim() && /^NL/i.test(p.vat_number.trim())) return { scheme: '9944', id: p.vat_number.replace(/\s/g, '').toUpperCase() };
  if (p.email?.trim()) return { scheme: 'EM', id: p.email.trim() };
  return null;
}

function splitStreet(address: string | null | undefined): string {
  return (address ?? '').split('\n')[0]!.trim();
}

function party(tag: 'AccountingSupplierParty' | 'AccountingCustomerParty', p: Party): string {
  const ep = endpoint(p);
  const country = (p.country || 'NL').toUpperCase();
  return `<cac:${tag}><cac:Party>
${ep ? `<cbc:EndpointID schemeID="${ep.scheme}">${esc(ep.id)}</cbc:EndpointID>` : ''}
<cac:PartyName><cbc:Name>${esc(p.name)}</cbc:Name></cac:PartyName>
<cac:PostalAddress>${splitStreet(p.address) ? `<cbc:StreetName>${esc(splitStreet(p.address))}</cbc:StreetName>` : ''}${p.city ? `<cbc:CityName>${esc(p.city)}</cbc:CityName>` : ''}${p.postcode ? `<cbc:PostalZone>${esc(p.postcode)}</cbc:PostalZone>` : ''}<cac:Country><cbc:IdentificationCode>${country}</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
${p.vat_number?.trim() ? `<cac:PartyTaxScheme><cbc:CompanyID>${esc(p.vat_number.replace(/\s/g, '').toUpperCase())}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>` : ''}
<cac:PartyLegalEntity><cbc:RegistrationName>${esc(p.name)}</cbc:RegistrationName>${p.kvk_number?.trim() ? `<cbc:CompanyID schemeID="0106">${esc(p.kvk_number.replace(/\s/g, ''))}</cbc:CompanyID>` : ''}</cac:PartyLegalEntity>
</cac:Party></cac:${tag}>`;
}

export function companyAsParty(c: CompanySettings): Party {
  return { name: c.name, address: c.address, postcode: c.postcode, city: c.city, country: c.country, vat_number: c.vatNumber, kvk_number: c.kvkNumber, email: c.email };
}

/**
 * Controle op de belangrijkste BIS/EN 16931-regels vóór we de XML maken. Geeft een lijst met
 * problemen in mensentaal; leeg = in orde.
 */
export function checkBisRules(inv: Invoice, seller: Party, buyer: Party, iban: string): string[] {
  const errors: string[] = [];
  if (!inv.number) errors.push('De factuur heeft nog geen nummer (eerst definitief maken).');
  if (!seller.name.trim()) errors.push('Je bedrijfsnaam ontbreekt.');
  if (!endpoint(seller)) errors.push('Vul je KvK-nummer of e-mailadres in (elektronisch adres van de verkoper).');
  if (!endpoint(buyer)) errors.push(`Vul het KvK-nummer, btw-nummer of e-mailadres van ${buyer.name} in (elektronisch adres van de koper).`);
  if (!buyer.name.trim()) errors.push('De naam van de klant ontbreekt.');
  const categories = inv.totals.groups.map((g) => taxCategory(g.vatCode, g.percentage).id);
  if (categories.includes('S') && !seller.vat_number?.trim()) errors.push('Bij btw-plichtige omzet moet je btw-nummer op de factuur (BR-S-02).');
  if (categories.includes('AE')) {
    if (!seller.vat_number?.trim()) errors.push('Bij btw verlegd moet je eigen btw-nummer op de factuur (BR-AE-02).');
    if (!buyer.vat_number?.trim()) errors.push('Bij btw verlegd moet het btw-nummer van de klant op de factuur (BR-AE-02).');
  }
  if (!iban.trim()) errors.push('Vul je IBAN in, zodat de klant weet waarheen te betalen.');
  const lineSum = inv.lines.reduce((s, l) => s + lineNet({ quantity: l.quantity, unitPrice: l.unit_price }), 0);
  if (lineSum !== inv.totals.subtotal) errors.push('Som van de regels wijkt af van het subtotaal (BR-CO-10).');
  if (inv.totals.subtotal + inv.totals.vatTotal !== inv.totals.total) errors.push('Subtotaal + btw wijkt af van het totaal (BR-CO-15).');
  return errors;
}

export function buildInvoiceUbl(inv: Invoice, company: CompanySettings, buyer: Party): string {
  const seller = companyAsParty(company);
  const problems = checkBisRules(inv, seller, buyer, company.iban);
  if (problems.length) throw new Error(`E-factuur kan nog niet gemaakt worden: ${problems.join(' ')}`);
  // Een creditnota is in BIS een apart documenttype met positieve bedragen.
  const credit = inv.totals.total < 0;
  const sign = credit ? -1 : 1;
  const root = credit ? 'CreditNote' : 'Invoice';
  const lineTag = credit ? 'CreditNoteLine' : 'InvoiceLine';
  const qtyTag = credit ? 'CreditedQuantity' : 'InvoicedQuantity';
  const ns = credit ? 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2' : 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';
  const t = inv.totals;
  const subtotals = t.groups
    .map((g) => {
      const c = taxCategory(g.vatCode, g.percentage);
      return `<cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">${amt(sign * g.net)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">${amt(sign * g.vat)}</cbc:TaxAmount><cac:TaxCategory><cbc:ID>${c.id}</cbc:ID><cbc:Percent>${c.percent}</cbc:Percent>${c.reasonCode ? `<cbc:TaxExemptionReasonCode>${c.reasonCode}</cbc:TaxExemptionReasonCode>` : ''}${c.reason ? `<cbc:TaxExemptionReason>${esc(c.reason)}</cbc:TaxExemptionReason>` : ''}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`;
    })
    .join('\n');
  const lines = inv.lines
    .map((l, i) => {
      const c = taxCategory(l.vat_code, l.vat_percentage);
      const net = lineNet({ quantity: l.quantity, unitPrice: l.unit_price });
      return `<cac:${lineTag}><cbc:ID>${i + 1}</cbc:ID><cbc:${qtyTag} unitCode="${unitCode(l.unit)}">${qty(sign * l.quantity)}</cbc:${qtyTag}><cbc:LineExtensionAmount currencyID="EUR">${amt(sign * net)}</cbc:LineExtensionAmount><cac:Item><cbc:Name>${esc(l.description.split('\n')[0]!.slice(0, 200) || 'Regel')}</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>${c.id}</cbc:ID><cbc:Percent>${c.percent}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item><cac:Price><cbc:PriceAmount currencyID="EUR">${amt(l.unit_price)}</cbc:PriceAmount></cac:Price></cac:${lineTag}>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="${ns}" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
<cbc:CustomizationID>${BIS_CUSTOMIZATION}</cbc:CustomizationID>
<cbc:ProfileID>${BIS_PROFILE}</cbc:ProfileID>
<cbc:ID>${esc(inv.number!)}</cbc:ID>
<cbc:IssueDate>${inv.invoice_date}</cbc:IssueDate>
${credit ? '' : `<cbc:DueDate>${inv.due_date}</cbc:DueDate>`}
<cbc:${credit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'}>${credit ? '381' : '380'}</cbc:${credit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'}>
${inv.notes ? `<cbc:Note>${esc(inv.notes.slice(0, 1000))}</cbc:Note>` : ''}
<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
<cbc:BuyerReference>${esc(inv.reference || inv.number!)}</cbc:BuyerReference>
${party('AccountingSupplierParty', seller)}
${party('AccountingCustomerParty', buyer)}
<cac:PaymentMeans><cbc:PaymentMeansCode>58</cbc:PaymentMeansCode><cbc:PaymentID>${esc(inv.number!)}</cbc:PaymentID><cac:PayeeFinancialAccount><cbc:ID>${esc(company.iban.replace(/\s/g, '').toUpperCase())}</cbc:ID><cbc:Name>${esc(company.name)}</cbc:Name></cac:PayeeFinancialAccount></cac:PaymentMeans>
${credit ? '' : `<cac:PaymentTerms><cbc:Note>Te betalen vóór ${inv.due_date}</cbc:Note></cac:PaymentTerms>`}
<cac:TaxTotal><cbc:TaxAmount currencyID="EUR">${amt(sign * t.vatTotal)}</cbc:TaxAmount>
${subtotals}
</cac:TaxTotal>
<cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="EUR">${amt(sign * t.subtotal)}</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="EUR">${amt(sign * t.subtotal)}</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="EUR">${amt(sign * t.total)}</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="EUR">${amt(sign * t.total)}</cbc:PayableAmount></cac:LegalMonetaryTotal>
${lines}
</${root}>
`.replace(/\n\n+/g, '\n');
}
