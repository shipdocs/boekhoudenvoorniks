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
  await expect(task).toContainText('volgens de app € 1.806,43. Er mist waarschijnlijk een betaling van € 25,00.');
  await expect(task.getByRole('button', { name: 'Afschrift inlezen' })).toBeVisible();
  await task.getByRole('button', { name: 'Dit klopt, negeren' }).click();
  await expect(page.locator('.task', { hasText: 'het saldo klopt niet' })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.hero')).toBeVisible();
  await expect(page.locator('.task', { hasText: 'het saldo klopt niet' })).toHaveCount(0);
  expect(problems.apiErrors).toEqual([]);
});
