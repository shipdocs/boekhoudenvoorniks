import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, onboard, nav, call } from './fixtures';

/**
 * Betrouwbaar inlezen (#184): wisselen van soort afschrift geeft geen dubbele betalingen, wat is
 * overgeslagen is te bekijken en alsnog toe te voegen, en een saldo dat niet klopt komt op Vandaag.
 */
const CSV = readFileSync(join(__dirname, '..', 'tests', 'fixtures', 'ing.csv'));
const IBAN = 'NL91ABNA0417164300';

interface Entry { ref: string; date: string; amount: number; name: string; text: string }

/** CAMT.053 met de boekdatum en een id van de bank per betaling, en het eindsaldo van die dag. */
function camt(entries: Entry[], closing: { date: string; amount: number }): Buffer {
  const xml = entries.map((e) => `<Ntry><Amt Ccy="EUR">${Math.abs(e.amount).toFixed(2)}</Amt><CdtDbtInd>${e.amount < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd><Sts>BOOK</Sts>
    <BookgDt><Dt>${e.date}</Dt></BookgDt><AcctSvcrRef>${e.ref}</AcctSvcrRef>
    <NtryDtls><TxDtls><RltdPties>${e.amount < 0 ? `<Cdtr><Nm>${e.name}</Nm></Cdtr>` : `<Dbtr><Nm>${e.name}</Nm></Dbtr>`}</RltdPties><RmtInf><Ustrd>${e.text}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`);
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt><Id>1</Id>
    <Acct><Id><IBAN>${IBAN}</IBAN></Id></Acct>
    <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">${closing.amount.toFixed(2)}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>${closing.date}</Dt></Dt></Bal>
    ${xml.join('\n')}</Stmt></BkToCstmrStmt></Document>`);
}

// dezelfde drie betalingen als in de CSV (de kaartbetalingen een dag later geboekt), en één die de CSV miste
const SAME: Entry[] = [
  { ref: 'R1', date: '2026-09-15', amount: 936.43, name: 'Familie Jansen', text: 'factuur 2026-0001' },
  { ref: 'R2', date: '2026-09-16', amount: -65, name: 'SHELL STATION', text: 'Betaalautomaat 12:01' },
  { ref: 'R3', date: '2026-09-16', amount: -65, name: 'SHELL STATION', text: 'Betaalautomaat 12:01' },
];
const KPN: Entry = { ref: 'R4', date: '2026-09-15', amount: -15, name: 'KPN', text: 'Mobiel abonnement' };

const upload = (page: import('@playwright/test').Page, name: string, buffer: Buffer) =>
  page.locator('main input[type=file]').first().setInputFiles({ name, mimeType: name.endsWith('.xml') ? 'text/xml' : 'text/csv', buffer });

test('CSV en daarna CAMT over dezelfde dagen: niets dubbel, en wat is overgeslagen is te bekijken en toe te voegen', async ({ page, problems }) => {
  await onboard(page);
  await nav(page, 'Bank');
  await upload(page, 'afschrift.csv', CSV);
  await expect(page.locator('.notice.good')).toContainText('3 nieuwe betalingen.');

  await upload(page, 'afschrift.xml', camt([...SAME, KPN], { date: '2026-09-16', amount: 791.43 }));
  const notice = page.locator('.notice.good');
  await expect(notice).toContainText('1 nieuwe betaling.');
  await expect(notice).toContainText('3 stonden er al (uit je afschrift van 15 september 2026 t/m 16 september 2026).');
  await expect(notice).toContainText('1 toegevoegd in een periode die al was ingelezen.');
  expect(await call<unknown[]>(page, 'bank.transactions', {})).toHaveLength(4);

  await notice.getByRole('button', { name: 'Bekijken' }).click();
  const dlg = page.getByRole('dialog', { name: 'Betalingen die er al stonden' });
  await expect(dlg.getByRole('button', { name: 'Toch toevoegen' })).toHaveCount(3);
  // de overgeslagen regel staat naast de betaling die er al stond, met het afschrift waar die uit kwam
  await expect(dlg.locator('tbody tr', { hasText: 'Familie Jansen' }).first()).toContainText('uit afschrift.csv');
  await expect(dlg.getByRole('heading', { name: 'Nieuw in een periode die al was ingelezen' })).toBeVisible();
  await expect(dlg.locator('tr', { hasText: 'KPN' })).toBeVisible();

  // toch een eigen betaling: hij komt er alsnog in
  await dlg.locator('tbody tr', { hasText: 'Familie Jansen' }).first().getByRole('button', { name: 'Toch toevoegen' }).click();
  await expect(dlg.getByText('toegevoegd ✓')).toBeVisible();
  await expect(dlg.getByRole('button', { name: 'Toch toevoegen' })).toHaveCount(2);
  await dlg.getByRole('button', { name: 'Sluiten' }).click();
  expect(await call<unknown[]>(page, 'bank.transactions', {})).toHaveLength(5);
  // bij de rekening blijft staan dat er regels zijn overgeslagen
  await page.getByRole('button', { name: '2 regels stonden er al: bekijken' }).click();
  await expect(page.getByRole('dialog', { name: 'Betalingen die er al stonden' })).toBeVisible();
  expect(problems.apiErrors).toEqual([]);
});

test('het saldo klopt niet: melding op Vandaag, met de overgeslagen betaling als eerste kandidaat', async ({ page, problems }) => {
  await onboard(page);
  const [account] = await call<{ id: number; name: string }[]>(page, 'bank.accounts');
  await call(page, 'bank.openingBalance', account!.id, 100000, '2026-09-01');
  await nav(page, 'Bank');
  // de CSV heeft één keer tanken; de CAMT ook één, maar dat was de tweede keer. Volgens de bank ging er twee keer € 65 af.
  await upload(page, 'afschrift.csv', Buffer.from(CSV.toString('utf8').split('\n').slice(0, 3).join('\n')));
  await expect(page.locator('.notice.good')).toContainText('2 nieuwe betalingen.');
  await upload(page, 'afschrift.xml', camt([SAME[0]!, SAME[1]!], { date: '2026-09-16', amount: 1000 + 936.43 - 65 - 65 }));
  await expect(page.locator('.notice.good')).toContainText('2 stonden er al');

  await nav(page, 'Vandaag');
  const task = page.locator('.task', { hasText: 'Zakelijke rekening: het saldo klopt niet' });
  await expect(task).toContainText('Volgens je bank stond er op 16 september 2026 € 1.806,43, volgens de app € 1.871,43.');
  await expect(task).toContainText('Bij het inlezen is een betaling van € 65,00 op 16 september 2026 overgeslagen, omdat hij er al leek te staan.');
  await expect(task.getByRole('button', { name: 'Dit klopt, negeren' })).toBeVisible();
  await task.getByRole('button', { name: 'Bekijken' }).click();

  // op het bankscherm staan de overgeslagen regels van deze rekening meteen open
  const dlg = page.getByRole('dialog', { name: 'Betalingen die er al stonden' });
  await dlg.locator('tbody tr', { hasText: 'SHELL STATION' }).getByRole('button', { name: 'Toch toevoegen' }).click();
  await expect(dlg.getByText('toegevoegd ✓')).toBeVisible();
  await dlg.getByRole('button', { name: 'Sluiten' }).click();
  await nav(page, 'Vandaag');
  await expect(page.locator('.hero')).toBeVisible();
  await expect(page.locator('.task', { hasText: 'het saldo klopt niet' })).toHaveCount(0);
  expect(problems.apiErrors).toEqual([]);
});

test('het saldo klopt niet zonder kandidaat: afschrift inlezen of zeggen dat het klopt', async ({ page, problems }) => {
  await onboard(page);
  const [account] = await call<{ id: number }[]>(page, 'bank.accounts');
  await call(page, 'bank.openingBalance', account!.id, 100000, '2026-09-01');
  await nav(page, 'Bank');
  // volgens de bank staat er € 25,00 meer dan de app kan verklaren
  await upload(page, 'afschrift.xml', camt(SAME, { date: '2026-09-16', amount: 1000 + 936.43 - 130 + 25 }));
  await expect(page.locator('.notice.good')).toContainText('3 nieuwe betalingen.');
  await nav(page, 'Vandaag');
  const show = page.getByRole('button', { name: /^Toon alle/ });
  if (await show.isVisible()) await show.click();
  const task = page.locator('.task', { hasText: 'het saldo klopt niet' });
  await expect(task).toContainText('volgens de app € 1.806,43. In de app staat € 25,00 te weinig: er mist waarschijnlijk geld dat binnenkwam, of een afschrijving staat er dubbel in.');
  await expect(task.getByRole('button', { name: 'Afschrift inlezen' })).toBeVisible();
  await task.getByRole('button', { name: 'Dit klopt, negeren' }).click();
  await expect(page.locator('.task', { hasText: 'het saldo klopt niet' })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.hero')).toBeVisible();
  await expect(page.locator('.task', { hasText: 'het saldo klopt niet' })).toHaveCount(0);
  expect(problems.apiErrors).toEqual([]);
});

/** CAMT met een verzamelboeking van € 600,00 als drie deelposten; `date` is de boekdatum. */
function camtBatch(date: string): Buffer {
  const subs = [['Jan', '100.00'], ['Piet', '200.00'], ['Klaas', '300.00']].map(([name, amount]) => `<TxDtls><Amt Ccy="EUR">${amount}</Amt><RltdPties><Cdtr><Nm>${name}</Nm></Cdtr></RltdPties><RmtInf><Ustrd>loon ${name}</Ustrd></RmtInf></TxDtls>`).join('');
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt><Id>1</Id><Acct><Id><IBAN>${IBAN}</IBAN></Id></Acct>
    <Ntry><Amt Ccy="EUR">15.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-09-08</Dt></BookgDt><AcctSvcrRef>KPN-1</AcctSvcrRef><NtryDtls><TxDtls><RltdPties><Cdtr><Nm>KPN</Nm></Cdtr></RltdPties><RmtInf><Ustrd>Mobiel</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
    <Ntry><Amt Ccy="EUR">600.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>${date}</Dt></BookgDt><AcctSvcrRef>BATCH-1</AcctSvcrRef><NtryDtls>${subs}</NtryDtls></Ntry>
    <Ntry><Amt Ccy="EUR">20.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-09-18</Dt></BookgDt><AcctSvcrRef>GAMMA-1</AcctSvcrRef><NtryDtls><TxDtls><RltdPties><Cdtr><Nm>Gamma</Nm></Cdtr></RltdPties><RmtInf><Ustrd>Verf</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
  </Stmt></BkToCstmrStmt></Document>`);
}
/** CSV (Knab) over dezelfde dagen, met de verzamelbetaling als één regel op 15 september. */
const KNAB_TOTAL = Buffer.from(['Rekeningnummer;Transactiedatum;Valutacode;CreditDebet;Bedrag;Tegenrekeningnummer;Tegenrekeninghouder;Omschrijving;Betalingskenmerk',
  `${IBAN};08-09-2026;EUR;D;15,00;;KPN;Mobiel;`, `${IBAN};15-09-2026;EUR;D;600,00;;;Verzamelbetaling 3 posten;`, `${IBAN};18-09-2026;EUR;D;20,00;;Gamma;Verf;`].join('\n'));

test('verzamelbetaling: één regel in de CSV en deelposten in de CAMT komen er niet naast elkaar in', async ({ page, problems }) => {
  await onboard(page);
  await nav(page, 'Bank');
  await upload(page, 'afschrift.csv', KNAB_TOTAL);
  await expect(page.locator('.notice.good')).toContainText('3 nieuwe betalingen.');
  await upload(page, 'afschrift.xml', camtBatch('2026-09-15'));
  await expect(page.locator('.notice.good')).toContainText('Geen nieuwe betalingen. 5 stonden er al');
  await expect(page.locator('.notice.warn')).toHaveCount(0);
  expect(await call<unknown[]>(page, 'bank.transactions', {})).toHaveLength(3);

  // de deelposten staan bij wat is overgeslagen, tegenover de ene regel
  await page.locator('.notice.good').getByRole('button', { name: 'Bekijken' }).click();
  const review = page.getByRole('dialog', { name: 'Betalingen die er al stonden' });
  await expect(review.getByText('Deelpost van een verzamelbetaling van € 600,00: dat bedrag stond er al als één regel.')).toHaveCount(3);
  // toch toevoegen: alle deelposten samen; dan staat het bedrag er twee keer in en zegt de app dat
  await review.getByRole('button', { name: 'Toch toevoegen (alle 3 deelposten)' }).first().click();
  await expect(review.getByText('toegevoegd ✓')).toHaveCount(3);
  await review.getByRole('button', { name: 'Sluiten' }).click();
  const warning = page.locator('.notice.warn');
  await expect(warning).toContainText('€ 600,00 staat er waarschijnlijk twee keer in');
  await expect(warning).toContainText('als 3 deelposten');
  expect(problems.apiErrors).toEqual([]);
});

test('verzamelbetaling die er toch twee keer in staat: melding op Vandaag, naast elkaar bekijken, één kant eruit en weer terug', async ({ page, problems }) => {
  await onboard(page);
  const [account] = await call<{ id: number }[]>(page, 'bank.accounts');
  await call(page, 'bank.openingBalance', account!.id, 100000, '2026-09-01');
  await nav(page, 'Bank');
  // de deelposten zijn op 9 september geboekt, de ene regel staat op 15 september: te ver uit elkaar om het zeker te weten
  await upload(page, 'afschrift.xml', camtBatch('2026-09-09'));
  await expect(page.locator('.notice.good')).toContainText('5 nieuwe betalingen.');
  await upload(page, 'afschrift.csv', KNAB_TOTAL);
  await expect(page.locator('.notice.good')).toContainText('1 nieuwe betaling.');
  await expect(page.locator('.notice.warn')).toContainText('€ 600,00 staat er waarschijnlijk twee keer in (Zakelijke rekening): één keer als één regel op 15 september 2026 en één keer als 3 deelposten op 9 september 2026.');

  await nav(page, 'Vandaag');
  const show = page.getByRole('button', { name: /^Toon alle/ });
  if (await show.isVisible()) await show.click();
  const task = page.locator('.task', { hasText: 'staat er waarschijnlijk twee keer in' });
  await expect(task).toContainText('Zakelijke rekening: € 600,00 staat er waarschijnlijk twee keer in');
  await expect(task).toContainText('Op 15 september 2026 staat één regel van € 600,00, en op 9 september 2026 staan 3 deelposten die samen ook € 600,00 zijn.');
  await task.getByRole('button', { name: 'Bekijken' }).click();

  const dlg = page.getByRole('dialog', { name: 'Dit bedrag staat er waarschijnlijk twee keer in' });
  await expect(dlg).toContainText('€ 600,00 telt dubbel');
  await expect(dlg.getByRole('heading', { name: 'Eén regel' })).toBeVisible();
  await expect(dlg.getByRole('heading', { name: '3 deelposten' })).toBeVisible();
  await expect(dlg).toContainText('Totaal € -600,00');
  await expect(dlg).toContainText('Samen € -600,00');
  for (const name of ['Jan', 'Piet', 'Klaas']) await expect(dlg.locator('tr', { hasText: `loon ${name}` })).toBeVisible();
  await expect(dlg.getByRole('button', { name: 'Nee, dit zijn twee verschillende betalingen' })).toBeVisible();
  await expect(dlg.getByRole('button', { name: 'De ene regel houden' })).toBeEnabled();
  await dlg.getByRole('button', { name: 'De deelposten houden' }).click();
  await expect(page.getByText('Opgelost: de ene regel is uit je boekhouding gehaald')).toBeVisible();
  await expect(page.locator('.notice.warn')).toHaveCount(0);

  // het saldo volgens de afschriften klopt weer, en op Vandaag is de melding weg
  expect(await call<{ status: string; duplicate_of: number | null }[]>(page, 'bank.transactions', {}).then((list) => list.filter((t) => t.duplicate_of !== null).length)).toBe(1);
  await nav(page, 'Vandaag');
  await expect(page.locator('.hero')).toBeVisible();
  await expect(page.locator('.task', { hasText: 'staat er waarschijnlijk twee keer in' })).toHaveCount(0);

  // de regel is bewaard en terug te zetten
  await nav(page, 'Bank');
  await page.getByRole('button', { name: /stonden er al: bekijken|stond er al: bekijken/ }).click();
  const review = page.getByRole('dialog', { name: 'Betalingen die er al stonden' });
  await expect(review.getByRole('heading', { name: 'Uit je boekhouding gehaald omdat het bedrag er dubbel in stond' })).toBeVisible();
  await review.locator('tr', { hasText: 'Verzamelbetaling 3 posten' }).getByRole('button', { name: 'Terugzetten' }).click();
  await expect(page.getByText('Teruggezet')).toBeVisible();
  expect(problems.apiErrors).toEqual([]);
});

test('verzamelbetaling dubbel en de ene regel is al verwerkt: die gaat er niet zomaar uit', async ({ page, problems }) => {
  await onboard(page);
  await nav(page, 'Bank');
  await upload(page, 'afschrift.xml', camtBatch('2026-09-09'));
  await expect(page.locator('.notice.good')).toContainText('5 nieuwe betalingen.');
  await upload(page, 'afschrift.csv', KNAB_TOTAL);
  await expect(page.locator('.notice.warn')).toBeVisible();
  const line = (await call<{ id: number; amount: number; description: string }[]>(page, 'bank.transactions', {})).find((t) => t.description === 'Verzamelbetaling 3 posten')!;
  // de gebruiker heeft de ene regel intussen verwerkt
  await call(page, 'bank.book', line.id, { account: 'WBedAutBra', vatCode: 'geen' });
  await nav(page, 'Vandaag');
  await nav(page, 'Bank');

  await page.locator('.notice.warn').getByRole('button', { name: 'Bekijken en oplossen' }).click();
  const dlg = page.getByRole('dialog', { name: 'Dit bedrag staat er waarschijnlijk twee keer in' });
  await expect(dlg).toContainText('De ene regel is al verwerkt. Die haalt de app er niet zomaar uit: haal de deelposten eruit, of maak eerst die verwerking ongedaan (open de regel en kies Ongedaan maken).');
  await expect(dlg.getByRole('button', { name: 'De deelposten houden' })).toBeDisabled();
  await dlg.getByRole('button', { name: 'De ene regel houden' }).click();
  await expect(page.getByText('Opgelost: de deelposten zijn uit je boekhouding gehaald')).toBeVisible();
  await expect(page.locator('.notice.warn')).toHaveCount(0);
  expect(problems.apiErrors).toEqual([]);
});
