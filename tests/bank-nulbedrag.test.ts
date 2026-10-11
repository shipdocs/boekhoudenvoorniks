import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { createApi, type HostContext } from '../src/main/api';
import { ZERO_AMOUNT_MESSAGE } from '../src/import/bank';

/**
 * Een bankregel van nul euro (bijvoorbeeld de controle van een betaalkaart): er valt niets te boeken. De regel gaat vanzelf
 * op 'genegeerd', komt niet als vraag op Vandaag en een poging om hem toch te boeken geeft een gewone melding.
 */

const world = () => {
  const { s } = setup();
  s.settings.update({ onboardingDone: true });
  const api = createApi(s, { appVersion: () => '0.0.0', hasSmtpPassword: () => false } as unknown as HostContext);
  return { s, api };
};
type S = ReturnType<typeof world>['s'];

const lees = (s: S, regels: { amount: number; name: string }[]) =>
  s.bank.import({ source: 'csv', warnings: [], transactions: regels.map((r, i) => ({ date: `2026-10-0${i + 1}`, amount: r.amount, description: `${r.name} kaart`, counterName: r.name })) });
const boekingen = (s: S) => (s.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as { n: number }).n;
const bankTaken = (s: S) => s.inbox.tasks('2026-10-11').filter((t) => t.kind.startsWith('bank-'));

describe('bankregel van nul euro', () => {
  it('nul euro bij het inlezen: vanzelf genegeerd, geen vraag op Vandaag en geen boeking; een gewone regel blijft zoals hij was', () => {
    const { s } = world();
    const voor = boekingen(s);
    const uit = lees(s, [{ amount: 0, name: 'Voorbeeld Softwarehuis' }, { amount: -1250, name: 'Voorbeeld Kantoorwinkel' }]);
    expect(uit.imported).toBe(2);
    const nul = s.bank.list().find((t) => t.amount === 0)!;
    const gewoon = s.bank.list().find((t) => t.amount === -1250)!;
    expect(nul.status).toBe('genegeerd');
    expect(nul.duplicate_of).toBeNull();
    expect(gewoon.status).toBe('nieuw');
    expect(boekingen(s)).toBe(voor);
    expect(bankTaken(s).map((t) => t.ref.bankTransactionId)).toEqual([gewoon.id]);
  });

  it('nul euro die al was ingelezen: de eerstvolgende verwerking zet hem op genegeerd, ook bij de voorzichtige stand', () => {
    for (const autopilot of ['voorzichtig', 'normaal'] as const) {
      const { s } = world();
      s.settings.update({ autopilot });
      lees(s, [{ amount: 0, name: 'Voorbeeld Softwarehuis' }]);
      const nul = s.bank.list()[0]!;
      // zoals een regel die een eerdere versie van de app heeft ingelezen
      s.db.prepare(`UPDATE bank_transactions SET status = 'nieuw' WHERE id = ?`).run(nul.id);
      expect(bankTaken(s)).toHaveLength(1);
      s.inbox.autoProcess('2026-10-11');
      expect(s.bank.get(nul.id).status, autopilot).toBe('genegeerd');
      expect(bankTaken(s), autopilot).toEqual([]);
      expect(boekingen(s), autopilot).toBe(0);
    }
  });

  it('nul euro toch boeken: een gewone melding in plaats van een programmafout, en er wordt niets geboekt', async () => {
    const { s, api } = world();
    lees(s, [{ amount: 0, name: 'Voorbeeld Softwarehuis' }]);
    const nul = s.bank.list()[0]!;
    for (const status of ['genegeerd', 'nieuw'] as const) {
      s.db.prepare(`UPDATE bank_transactions SET status = ? WHERE id = ?`).run(status, nul.id);
      expect(() => api.bank.book(nul.id, { account: 'WKprInkMat', vatCode: 'hoog' }), status).toThrow(ZERO_AMOUNT_MESSAGE);
      expect(() => api.bank.book(nul.id, { account: 'WKprInkMat', vatCode: 'geen', businessPct: 100 }), status).toThrow(ZERO_AMOUNT_MESSAGE);
      expect(() => s.bank.bookSale(nul.id, { vatCode: 'hoog' }), status).toThrow(ZERO_AMOUNT_MESSAGE);
      expect(() => s.bank.bookOwnTransfer(nul.id), status).toThrow(ZERO_AMOUNT_MESSAGE);
    }
    // het antwoord op de vraag "zakelijk of privé" van Vandaag (voorheen: "Cannot read properties of null (reading 'debit')" bij privé)
    for (const answer of [{ business: false, categoryKey: 'overig', vatCode: 'geen' }, { business: true, categoryKey: 'software', vatCode: 'hoog', businessPct: 100 }, { business: true }]) {
      expect(() => s.inbox.answerBank(nul.id, answer), JSON.stringify(answer)).toThrow(ZERO_AMOUNT_MESSAGE);
    }
    await expect(Promise.resolve().then(() => api.home.act({ key: '', kind: 'bank-business', icon: '', title: '', question: '', actions: [], ref: { bankTransactionId: nul.id } } as never, 'prive'))).rejects.toThrow(ZERO_AMOUNT_MESSAGE);
    expect(boekingen(s)).toBe(0);
    expect(s.bank.get(nul.id).status).toBe('nieuw');
    // negeren zelf blijft kunnen
    api.bank.ignore(nul.id);
    expect(s.bank.get(nul.id).status).toBe('genegeerd');
  });

  it('nul euro telt niet mee in het saldo en een dubbele regel van nul euro blijft een dubbele regel', () => {
    const { s } = world();
    lees(s, [{ amount: -1250, name: 'Voorbeeld Kantoorwinkel' }, { amount: 0, name: 'Voorbeeld Softwarehuis' }]);
    const som = (s.db.prepare(`SELECT COALESCE(SUM(amount), 0) AS n FROM bank_transactions WHERE status <> 'gematcht'`).get() as { n: number }).n;
    expect(som).toBe(-1250);
    const [gewoon, nul] = [s.bank.list().find((t) => t.amount === -1250)!, s.bank.list().find((t) => t.amount === 0)!];
    s.db.prepare(`UPDATE bank_transactions SET status = 'nieuw', duplicate_of = ? WHERE id = ?`).run(gewoon.id, nul.id);
    expect(s.bank.ignoreZeroAmounts()).toBe(0);
    expect(s.bank.get(nul.id)).toMatchObject({ status: 'nieuw', duplicate_of: gewoon.id });
  });
});
