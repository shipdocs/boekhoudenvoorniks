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
/** Een regel die er met een eerdere versie al in kwam, uit een ander afschrift (zoals in tests/dubbele-betaling.test.ts). */
function oudeImport(s: S, accountId: number, source: 'csv' | 'camt', t: { date: string; amount: number; name: string; text: string }): number {
  const batch = Number(s.db.prepare('INSERT INTO import_batches (filename, source, kind) VALUES (?, ?, ?)').run(`oud.${source}`, source, source).lastInsertRowid);
  s.db.prepare('INSERT INTO import_batch_accounts (batch_id, bank_account_id, period_from, period_to, transactions, imported, duplicates) VALUES (?, ?, ?, ?, 1, 1, 0)').run(batch, accountId, t.date, t.date);
  return Number(
    s.db
      .prepare('INSERT INTO bank_transactions (bank_account_id, transaction_date, amount, counter_iban, counter_name, description, source, import_batch_id, dedup_hash) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)')
      .run(accountId, t.date, t.amount, t.name, t.text, source, batch, `oud-${batch}-${t.amount}`).lastInsertRowid,
  );
}
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
      // ook vóór de eerstvolgende verwerking komt er geen vraag over
      expect(bankTaken(s)).toEqual([]);
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

  it('twee nul-regels uit verschillende imports: geen melding "staat er twee keer in", en een behouden of teruggezette nul-regel blijft genegeerd', () => {
    const { s, api } = world();
    // dezelfde kaartcontrole uit twee afschriften van een eerdere versie van de app; ter controle ook een gewoon bedrag dat zo wél als dubbel wordt gemeld
    lees(s, [{ amount: -100, name: 'Voorbeeld Kantoorwinkel' }]);
    const rekening = s.bank.list()[0]!.bank_account_id;
    for (const bron of ['csv', 'camt'] as const) {
      for (const amount of [0, -2500]) oudeImport(s, rekening, bron, { date: '2026-10-01', amount, name: 'Voorbeeld Softwarehuis', text: 'Voorbeeld Softwarehuis kaart' });
    }
    expect(s.bank.list().filter((t) => t.amount === -2500)).toHaveLength(2);
    expect(s.bank.paymentDoubles().map((d) => d.amount)).toEqual([-2500]);
    s.db.prepare(`UPDATE bank_transactions SET status = 'genegeerd' WHERE amount IN (-2500, -100)`).run();
    const [eerste, tweede] = s.bank.list().filter((t) => t.amount === 0).sort((a, b) => a.id - b.id);
    expect(eerste && tweede).toBeTruthy();
    // zoals regels die een eerdere versie van de app heeft ingelezen
    s.db.prepare(`UPDATE bank_transactions SET status = 'nieuw' WHERE amount = 0`).run();
    s.inbox.autoProcess('2026-10-11');
    expect(s.bank.paymentDoubles().filter((d) => d.amount === 0)).toEqual([]);
    const nulIds = new Set(s.bank.list().filter((t) => t.amount === 0).map((t) => t.id));
    const taken = () => s.inbox.tasks('2026-10-11').filter((t) => (t.ref.bankTransactionId !== undefined && nulIds.has(t.ref.bankTransactionId)) || /0,00/.test(t.title));
    expect(taken()).toEqual([]);
    // de gebruiker wijst zelf de tweede aan als dubbele regel van de eerste: de behouden regel wordt niet weer een vraag
    api.bank.ignore(tweede!.id, eerste!.id);
    expect(s.bank.get(eerste!.id).status).toBe('genegeerd');
    expect(s.bank.get(tweede!.id)).toMatchObject({ status: 'genegeerd', duplicate_of: eerste!.id });
    expect(taken()).toEqual([]);
    // en terugzetten maakt er ook geen vraag van, zonder tussentijdse automatische verwerking
    s.bank.restoreDuplicate(tweede!.id);
    expect(s.bank.get(tweede!.id)).toMatchObject({ status: 'genegeerd', duplicate_of: null });
    expect(s.bank.get(eerste!.id).status).toBe('genegeerd');
    expect(taken()).toEqual([]);
    expect(boekingen(s)).toBe(0);
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
