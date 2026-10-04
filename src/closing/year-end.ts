import type { Db } from '../db/database';
import { tx } from '../db/database';
import { ACCOUNTS } from '../core-ledger/accounts';
import type { Ledger, PostLine } from '../core-ledger/ledger';
import { ValidationError } from '../shared/validation';
import type { Cents } from '../shared/money';
import type { IsoDate } from '../shared/dates';

/**
 * Jaarafsluiting: posten die de winst van het jaar veranderen zonder dat er een bon of betaling bij hoort.
 * Elke post wordt op 31 december geboekt en op 1 januari van het volgende jaar omgekeerd, zodat hij alleen in
 * het juiste jaar meetelt. De app boekt het bedrag dat jij invult; de waardering bepaalt jij of je boekhouder.
 */
export type YearEndKind = 'vooruitbetaald' | 'nog-te-betalen' | 'voorraad' | 'onderhanden-werk';

export const YEAR_END_KINDS: Record<YearEndKind, { label: string; needsCostAccount: boolean; help: string }> = {
  vooruitbetaald: {
    label: 'Vooruitbetaalde kosten',
    needsCostAccount: true,
    help: 'Je betaalde dit jaar iets dat (deels) bij volgend jaar hoort: een verzekering, abonnement of huur. Vul het deel in dat naar volgend jaar gaat.',
  },
  'nog-te-betalen': {
    label: 'Nog te betalen kosten',
    needsCostAccount: true,
    help: 'Kosten die bij dit jaar horen, maar waarvan je de factuur nog niet hebt: bijvoorbeeld de energie van december of de afrekening van je accountant. Vul het geschatte bedrag in.',
  },
  voorraad: {
    label: 'Voorraad',
    needsCostAccount: false,
    help: 'Materialen of handelsgoederen die je op 31 december nog op voorraad hebt, tegen inkoopprijs (of lager als ze minder waard zijn). Vul de totale waarde van de voorraad op 31 december in.',
  },
  'onderhanden-werk': {
    label: 'Onderhanden werk',
    needsCostAccount: false,
    help: 'Werk waar je dit jaar kosten of uren aan hebt besteed maar dat je nog niet (helemaal) hebt gefactureerd. Meestal waardeer je het tegen de gemaakte kosten. Vul het totaal in; een boekhouder kan de waardering controleren, vooral bij grotere projecten.',
  },
};

export interface YearEndItem {
  id: number;
  year: number;
  kind: YearEndKind;
  description: string;
  amount: Cents;
  cost_account: string | null;
  journal_entry_id: number;
  reversal_entry_id: number;
}

export class YearEndService {
  constructor(private readonly db: Db, private readonly ledger: Ledger) {}

  list(year: number): YearEndItem[] {
    return this.db.prepare('SELECT * FROM year_end_items WHERE year = ? AND removed = 0 ORDER BY id').all(year) as YearEndItem[];
  }

  add(input: { year: number; kind: YearEndKind; description: string; amount: Cents; costAccount?: string | null }): YearEndItem {
    const info = YEAR_END_KINDS[input.kind];
    if (!info) throw new ValidationError('Kies een soort post');
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new ValidationError('Vul een bedrag boven nul in');
    if (!input.description?.trim()) throw new ValidationError('Vul een omschrijving in');
    if (info.needsCostAccount) {
      if (!input.costAccount) throw new ValidationError('Kies de kostensoort waar dit bij hoort');
      if (this.ledger.getAccount(input.costAccount).category !== 'kosten') throw new ValidationError('Kies een kostenrekening');
    }
    const [balance, counter] = this.accounts(input.kind, input.costAccount ?? null);
    const date: IsoDate = `${input.year}-12-31`;
    const next: IsoDate = `${input.year + 1}-01-01`;
    const text = `${info.label}: ${input.description.trim()}`;
    return tx(this.db, () => {
      const entry = this.ledger.post({ date, description: `Jaarafsluiting ${input.year} – ${text}`, source: 'handmatig', sourceRef: `jaarafsluiting:${input.year}`, lines: this.orient(input.kind, input.amount, balance.account, counter.account, false) });
      const back = this.ledger.post({ date: next, description: `Omkering jaarafsluiting ${input.year} – ${text}`, source: 'handmatig', sourceRef: `jaarafsluiting:${input.year}`, lines: this.orient(input.kind, input.amount, balance.account, counter.account, true) });
      const id = Number(
        this.db
          .prepare('INSERT INTO year_end_items (year, kind, description, amount, cost_account, journal_entry_id, reversal_entry_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(input.year, input.kind, input.description.trim(), input.amount, input.costAccount ?? null, entry, back).lastInsertRowid,
      );
      return this.db.prepare('SELECT * FROM year_end_items WHERE id = ?').get(id) as YearEndItem;
    });
  }

  /** Haalt een post weer weg: beide boekingen worden teruggedraaid. */
  remove(id: number, date: IsoDate): void {
    const item = this.db.prepare('SELECT * FROM year_end_items WHERE id = ? AND removed = 0').get(id) as YearEndItem | undefined;
    if (!item) throw new ValidationError('Deze post bestaat niet (meer)');
    tx(this.db, () => {
      this.ledger.reverse(item.journal_entry_id, date);
      this.ledger.reverse(item.reversal_entry_id, date);
      this.db.prepare('UPDATE year_end_items SET removed = 1 WHERE id = ?').run(id);
    });
  }

  /** [balansrekening, tegenrekening]: activa/passiva tegenover resultaat. */
  private accounts(kind: YearEndKind, costAccount: string | null): [{ account: string }, { account: string }] {
    switch (kind) {
      case 'vooruitbetaald': return [{ account: ACCOUNTS.vooruitbetaaldeKosten }, { account: costAccount! }];
      case 'nog-te-betalen': return [{ account: ACCOUNTS.nogTeBetalenKosten }, { account: costAccount! }];
      case 'voorraad': return [{ account: ACCOUNTS.voorraad }, { account: ACCOUNTS.voorraadmutatie }];
      case 'onderhanden-werk': return [{ account: ACCOUNTS.onderhandenWerk }, { account: ACCOUNTS.onderhandenWerkMutatie }];
    }
  }

  /**
   * Vooruitbetaald, voorraad en onderhanden werk: activa omhoog (debet), kosten of mutatie omlaag (credit).
   * Nog te betalen: kosten omhoog (debet), schuld omhoog (credit). De omkering draait dat om.
   */
  private orient(kind: YearEndKind, amount: Cents, balance: string, counter: string, reverse: boolean): PostLine[] {
    const balanceDebit = kind !== 'nog-te-betalen';
    const debitBalance = balanceDebit !== reverse;
    return debitBalance ? [{ account: balance, debit: amount }, { account: counter, credit: amount }] : [{ account: counter, debit: amount }, { account: balance, credit: amount }];
  }
}
