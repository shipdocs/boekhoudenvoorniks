import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { pontoAccountStatusText, pontoCooldownText, pontoLinkText } from '../src/shared/bank-feed-text';
import { PontoAccountChoice, PontoCredentialFields, PontoIntro, PontoStoredCredentialHint } from '../src/renderer/screens/PontoDialog';

const testedAccount = (patch: Record<string, unknown> = {}) => ({
  pontoId: 'ponto-1', name: 'Zakelijk', iban: 'NL00TEST0123456789', balance: null, expiresAt: null,
  usable: true, reason: null, suggestedBankAccountId: 7,
  link: { completeTo: '2026-09-30', from: '2026-01-01', proven: true, note: 'bewijs' },
  ...patch,
}) as Parameters<typeof PontoAccountChoice>[0]['account'];

describe('Ponto-teksten', () => {
  it('onderscheidt een bewezen en onbewezen aansluiting', () => {
    expect(pontoLinkText(testedAccount())).toContain('aantoonbaar');
    expect(pontoLinkText(testedAccount({ link: { completeTo: null, from: '2026-01-01', proven: false, note: '' } }))).toContain('nog niet bewezen');
  });

  it('legt een gat en een rekening zonder aansluiting uit', () => {
    expect(pontoAccountStatusText({ coveredTo: '2026-09-30', gap: { from: '2026-02-01', to: '2026-02-03' }, lastErrorKind: null })).toContain('Ontbrekende periode');
    expect(pontoLinkText(testedAccount({ suggestedBankAccountId: null }))).toContain('Geen bestaande rekening');
  });

  it('toont de lokale rate-limit-tijd', () => {
    expect(pontoCooldownText('2026-10-03T12:30:00.000Z', new Date('2026-10-03T12:00:00.000Z'))).toMatch(/^Kan weer om \d{2}:\d{2}$/);
    expect(pontoCooldownText('2026-10-03T11:30:00.000Z', new Date('2026-10-03T12:00:00.000Z'))).toBe('Nu bijwerken');
  });
});

describe('Ponto-componenten', () => {
  it('biedt zonder veilige opslag uitsluitend de afschriftalternatief-uitleg', () => {
    const html = renderToStaticMarkup(createElement(PontoIntro, { secureStorage: false }));
    expect(html).toContain('geen veilige opslag');
    expect(html).toContain('bankafschriften');
  });

  it('rendert beide credentialvelden als wachtwoord zonder autocomplete', () => {
    const html = renderToStaticMarkup(createElement(PontoCredentialFields, { clientId: '', clientSecret: '', onClientId: () => undefined, onClientSecret: () => undefined }));
    expect(html.match(/type="password"/g)).toHaveLength(2);
    expect(html.match(/autoComplete="off"/g)).toHaveLength(2);
  });

  it('zet een nieuwe rekening nooit standaard aan', () => {
    const html = renderToStaticMarkup(createElement(PontoAccountChoice, { account: testedAccount({ suggestedBankAccountId: null }), bankAccounts: [], value: null, onChange: () => undefined }));
    expect(html).toContain('<option value="" selected="">Niet gebruiken</option>');
    expect(html).toContain('<option value="nieuw">Nieuwe zakelijke rekening maken</option>');
  });

  it('toont van opgeslagen credentials alleen de laatste vier tekens', () => {
    const html = renderToStaticMarkup(createElement(PontoStoredCredentialHint, { last4: 'WXYZ' }));
    expect(html).toContain('WXYZ');
    expect(html).not.toContain('volledige-client-id-WXYZ');
  });
});
