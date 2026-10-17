import { useState, type ReactNode } from 'react';
import { api } from '../api';
import { Button, Modal, useLoad } from '../ui';
import { needsAccount, type NeedsAccount } from '../../shared/statement-files';
/** Wat de gebruiker koos: bij een bestaande rekening, of toch een nieuwe rekening. */
export type AccountChoice = { bankAccountId?: number; newAccount?: boolean };

const groupedIban = (iban: string) => iban.replace(/(.{4})/g, '$1 ').trim();

/**
 * Leest een afschrift in en vraagt eerst, als er een rekeningnummer in staat dat nog niet in de administratie
 * staat, of dat een nieuwe rekening is of bij een bestaande hoort (#459). Zo komt een afschrift van je
 * privérekening er niet ongemerkt bij als "Rekening 4321". `importWithQuestion` geeft de samenvatting, of
 * null als de gebruiker annuleert; `question` is de vraag, om ergens in het scherm te zetten.
 */
export function useNewAccountQuestion(): {
  importWithQuestion: <R>(read: (choice?: AccountChoice) => Promise<R>) => Promise<Exclude<R, NeedsAccount> | null>;
  question: ReactNode;
} {
  const [ask, setAsk] = useState<{ ibans: string[]; single: boolean; choose: (choice: AccountChoice | null) => void } | null>(null);

  const importWithQuestion = async <R,>(read: (choice?: AccountChoice) => Promise<R>): Promise<Exclude<R, NeedsAccount> | null> => {
    const first = await read();
    if (!needsAccount(first)) return first as Exclude<R, NeedsAccount>;
    const choice = await new Promise<AccountChoice | null>((resolve) => setAsk({ ...first.needsAccount, choose: resolve }));
    setAsk(null);
    if (!choice) return null;
    const second = await read(choice);
    // met een keuze vraagt de app niet nog eens
    return needsAccount(second) ? null : (second as Exclude<R, NeedsAccount>);
  };

  return { importWithQuestion, question: ask && <Question ibans={ask.ibans} single={ask.single} onChoose={ask.choose} /> };
}

function Question({ ibans, single, onChoose }: { ibans: string[]; single: boolean; onChoose: (choice: AccountChoice | null) => void }) {
  const accounts = useLoad(() => api.bank.accounts());
  const own = (accounts.data ?? []).filter((a) => !a.is_pot);
  const one = ibans.length === 1;
  return (
    <Modal title="Nieuwe bankrekening?" onClose={() => onChoose(null)}>
      <p>
        Dit afschrift is van {one ? 'rekening' : 'de rekeningen'} <strong>{ibans.map(groupedIban).join(', ')}</strong>, die nog niet in je administratie {one ? 'staat' : 'staan'}.
        Is het een zakelijke rekening die erbij hoort, voeg {one ? 'hem' : 'ze'} dan toe. Is het je privérekening, lees het afschrift dan niet in.
      </p>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <Button kind="primary" onClick={() => onChoose({ newAccount: true })}>{one ? 'Nieuwe rekening toevoegen' : 'Nieuwe rekeningen toevoegen'}</Button>
        {single && own.map((a) => (
          <Button key={a.id} onClick={() => onChoose({ bankAccountId: a.id })}>Hoort bij {a.name}{a.iban ? ` (${groupedIban(a.iban)})` : ''}</Button>
        ))}
        <Button onClick={() => onChoose(null)}>Niet inlezen</Button>
      </div>
    </Modal>
  );
}
