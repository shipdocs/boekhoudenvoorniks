import { describe, expect, it } from 'vitest';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { setup } from './helpers';
import { parseUbl } from '../src/intake/ubl';
import { BIS_CUSTOMIZATION, BIS_PROFILE, unitCode } from '../src/documents/ubl-out';

const parse = (xml: string) => new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, isArray: (n) => ['TaxSubtotal', 'InvoiceLine', 'CreditNoteLine'].includes(n) }).parse(xml);

describe('uitgaande e-factuur (UBL, Peppol BIS 3.0) (#24)', () => {
  it('maakt geldige XML die een ontvanger zonder OCR volledig inleest', () => {
    const { s, klant } = setup();
    const inv = s.invoices.finalize(s.invoices.createDraft({
      relationId: klant.id,
      invoiceDate: '2026-09-10',
      reference: 'Badkamer Dorpsstraat',
      lines: [
        { description: 'Stucwerk wanden', quantity: 24.5, unit: 'm²', unitPrice: 2250, vatCode: 'hoog' },
        { description: 'Arbeid renovatie woning', quantity: 6, unit: 'uur', unitPrice: 4800, vatCode: 'laag' },
      ],
    }).id);
    const xml = s.invoices.ublXml(inv.id);
    expect(XMLValidator.validate(xml)).toBe(true);
    const x = parse(xml).Invoice;
    expect(x.CustomizationID).toBe(BIS_CUSTOMIZATION);
    expect(x.ProfileID).toBe(BIS_PROFILE);
    expect(x.InvoiceTypeCode).toBe('380');
    expect(x.BuyerReference).toBe('Badkamer Dorpsstraat');
    expect(x.AccountingSupplierParty.Party.EndpointID['@_schemeID']).toBe('0106');
    expect(x.AccountingCustomerParty.Party.EndpointID['#text']).toBe('jansen@example.nl');
    expect(x.InvoiceLine.map((l: { InvoicedQuantity: { '@_unitCode': string } }) => l.InvoicedQuantity['@_unitCode'])).toEqual(['MTK', 'HUR']);
    // de eigen UBL-lezer (zoals een ontvanger) haalt alles eruit met zekerheid 1
    const back = parseUbl(xml);
    expect(back.supplier?.value).toBe('Stukadoorsbedrijf Piet');
    expect(back.total).toMatchObject({ value: inv.total, confidence: 1 });
    expect(back.invoiceNumber?.value).toBe(inv.number);
    expect(back.supplierIban?.value).toBe('NL91ABNA0417164300');
    expect(back.vat.value).toEqual([
      { rate: 21, base: 55125, amount: 11576 },
      { rate: 9, base: 28800, amount: 2592 },
    ]);
    expect(back.lineDescriptions).toEqual(['Stucwerk wanden', 'Arbeid renovatie woning']);
  });

  it('btw verlegd: categorie AE met reden, en eerst de btw-nummers controleren', () => {
    const { s, aannemer } = setup();
    const inv = s.invoices.finalize(s.invoices.createDraft({ relationId: aannemer.id, invoiceDate: '2026-09-10', lines: [{ description: 'Stucwerk nieuwbouw', quantity: 1, unitPrice: 500000, vatCode: 'verlegd' }] }).id);
    const x = parse(s.invoices.ublXml(inv.id)).Invoice;
    const cat = x.TaxTotal.TaxSubtotal[0].TaxCategory;
    expect(cat).toMatchObject({ ID: 'AE', Percent: '0', TaxExemptionReasonCode: 'VATEX-EU-AE' });
    expect(x.AccountingCustomerParty.Party.PartyTaxScheme.CompanyID).toBe('NL999999999B01');
    expect(x.LegalMonetaryTotal.PayableAmount['#text']).toBe('5000.00');
  });

  it('creditnota wordt een CreditNote met positieve bedragen', () => {
    const { s, klant } = setup();
    const inv = s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-09-10', lines: [{ description: 'x', quantity: 2, unitPrice: 10000, vatCode: 'hoog' }] }).id);
    const credit = s.invoices.finalize(s.invoices.createCreditNote(inv.id).id);
    const xml = s.invoices.ublXml(credit.id);
    const x = parse(xml).CreditNote;
    expect(x.CreditNoteTypeCode).toBe('381');
    expect(x.LegalMonetaryTotal.PayableAmount['#text']).toBe('242.00');
    expect(x.CreditNoteLine[0].CreditedQuantity['#text']).toBe('2');
    expect(parseUbl(xml).total?.value).toBe(-24200);
  });

  it('weigert een e-factuur met ontbrekende verplichte gegevens, met uitleg', () => {
    const { s, klant } = setup();
    s.relations.update(klant.id, { email: null });
    const inv = s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-09-10', lines: [{ description: 'x', quantity: 1, unitPrice: 10000, vatCode: 'hoog' }] }).id);
    expect(() => s.invoices.ublXml(inv.id)).toThrow(/elektronisch adres van de koper/);
    expect(unitCode('stuks')).toBe('H87');
    expect(unitCode(null)).toBe('C62');
  });

  it('gaat als bijlage mee met de factuurmail', async () => {
    const { s, klant, sent } = setup();
    s.settings.update({ smtp: { host: 'smtp.example.nl', port: 587, secure: false, user: 'u', fromName: 'Piet', fromEmail: 'piet@example.nl', bcc: '' } });
    const draft = s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-09-10', lines: [{ description: 'x', quantity: 1, unitPrice: 10000, vatCode: 'hoog' }] });
    await s.sender.sendInvoice(draft.id);
    const names = sent[0]!.attachments.map((a) => a.filename);
    expect(names.some((n) => n.endsWith('.pdf'))).toBe(true);
    expect(names.some((n) => n.endsWith('.xml'))).toBe(true);
    s.settings.update({ sendUbl: false });
    const d2 = s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-09-11', lines: [{ description: 'y', quantity: 1, unitPrice: 10000, vatCode: 'hoog' }] });
    await s.sender.sendInvoice(d2.id);
    expect(sent[1]!.attachments.some((a) => a.filename.endsWith('.xml'))).toBe(false);
  });
});
