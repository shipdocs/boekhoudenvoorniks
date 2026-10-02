import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VatRoundingExplanation } from '../src/renderer/screens/Tax';
import { BankPaidExplanation } from '../src/renderer/screens/Purchases';

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

describe('uitleg in de schermen', () => {
  it('legt een teruggaafverschil van meer dan een euro uit als afronding per aangiftevak (#232)', () => {
    const html = renderToStaticMarkup(createElement(VatRoundingExplanation, { cents: -9783, wholeEuros: -99 }));
    const rendered = text(html);
    expect(rendered).toContain('Waarom wordt € 97,83 terug in de aangifte € 99 terug?');
    expect(rendered).toContain("bedragen per vak afgerond op hele euro's");
    expect(rendered).toContain('Daarna berekent de aangifte het totaal');
    expect(rendered).toContain('niet rechtstreeks afgerond');
  });

  it('gebruikt dezelfde uitleg bij te betalen btw en verbergt hem zonder verschil (#232)', () => {
    expect(text(renderToStaticMarkup(createElement(VatRoundingExplanation, { cents: 9783, wholeEuros: 99 })))).toContain('€ 97,83 te betalen in de aangifte € 99 te betalen');
    expect(renderToStaticMarkup(createElement(VatRoundingExplanation, { cents: 9900, wholeEuros: 99 }))).toBe('');
  });

  it('zegt bij via-bank-betaald hoe oud het complete afschrift is en dat de rekening openblijft (#178)', () => {
    const rendered = text(renderToStaticMarkup(createElement(BankPaidExplanation, { status: { name: 'Knab zakelijk', completeTo: '2026-09-28' }, asOf: '2026-10-02' })));
    expect(rendered).toContain('Knab zakelijk is bijgewerkt t/m 28 september 2026 (4 dagen geleden)');
    expect(rendered).toContain('Laat de rekening open');
    expect(rendered).toContain('koppelt de app hem of vraagt de app of ze bij elkaar horen');
  });

  it('legt ook uit wat er gebeurt als nog geen compleet afschrift is ingelezen (#178)', () => {
    const rendered = text(renderToStaticMarkup(createElement(BankPaidExplanation, { status: { name: 'Zakelijke rekening', completeTo: null }, asOf: '2026-10-02' })));
    expect(rendered).toContain('nog geen compleet bankafschrift');
    expect(rendered).toContain('Laat de rekening open');
  });
});
