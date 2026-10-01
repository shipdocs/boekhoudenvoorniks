import { readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, onboard, nav, call } from './fixtures';

/**
 * Afschriften uit je downloadmap (#184): de gebruiker zet het aan bij Bank, de app ziet een gedownload
 * afschrift in een map vol andere bestanden en vraagt op Vandaag "Inlezen?". Er gaat niets vanzelf de
 * boeken in en de map blijft zoals hij was.
 */
const IBAN = 'NL91ABNA0417164300';
const CSV = readFileSync(join(__dirname, '..', 'tests', 'fixtures', 'ing.csv'));

const camt = (iban: string, entries: { ref: string; date: string; amount: number; name: string }[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt><Id>1</Id><Acct><Id><IBAN>${iban}</IBAN></Id></Acct>
  ${entries.map((e) => `<Ntry><Amt Ccy="EUR">${Math.abs(e.amount).toFixed(2)}</Amt><CdtDbtInd>${e.amount < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>${e.date}</Dt></BookgDt><AcctSvcrRef>${e.ref}</AcctSvcrRef>
    <NtryDtls><TxDtls><RltdPties><Cdtr><Nm>${e.name}</Nm></Cdtr></RltdPties><RmtInf><Ustrd>betaling ${e.name}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`).join('')}
  </Stmt></BkToCstmrStmt></Document>`;

/** Een bestand in de map zetten dat een minuut geleden klaar was met downloaden. */
function put(dir: string, name: string, content: string | Buffer) {
  writeFileSync(join(dir, name), content);
  const t = new Date(Date.now() - 60_000);
  utimesSync(join(dir, name), t, t);
}

test('een map vol bestanden: alleen het afschrift van je eigen rekening wordt een vraag, en Inlezen leest het in', async ({ page, request, problems }) => {
  await onboard(page);
  const dir = (await (await request.post('/__downloads')).json()).ok as string;
  put(dir, 'CAMT053_september.xml', camt(IBAN, [{ ref: 'S1', date: '2026-09-01', amount: -15, name: 'KPN' }, { ref: 'S2', date: '2026-09-29', amount: -65, name: 'Shell' }]));
  put(dir, 'afschrift-van-iemand-anders.xml', camt('NL20INGB0001234567', [{ ref: 'A1', date: '2026-09-05', amount: -10, name: 'Iemand' }]));
  put(dir, 'factuur-leverancier.xml', readFileSync(join(__dirname, '..', 'tests', 'fixtures', 'ubl-invoice.xml')));
  put(dir, 'klantenlijst.csv', 'naam;plaats\nJansen;Utrecht\n');
  put(dir, 'notities.txt', 'boodschappen: melk, brood');
  put(dir, 'vakantiefoto.jpg', 'geen afschrift');
  put(dir, 'afschrift.xml.crdownload', camt(IBAN, [{ ref: 'D1', date: '2026-09-30', amount: -1, name: 'Nog bezig' }]));
  const before = readdirSync(dir).sort().map((n) => [n, readFileSync(join(dir, n), 'hex')]);

  // standaard uit: op Vandaag staat er niets over een afschrift in de map
  await expect(page.locator('.task', { hasText: 'Nieuw afschrift gevonden' })).toHaveCount(0);
  await nav(page, 'Bank');
  const card = page.locator('.card', { hasText: 'Afschriften vanzelf inlezen' });
  const toggle = card.getByLabel('Kijk in deze map naar nieuwe afschriften');
  await expect(toggle).not.toBeChecked();
  await expect(card).toContainText(dir);
  await expect(card).toContainText('De app verplaatst of verwijdert nooit iets in deze map.');
  // een bestand dat net is binnengekomen laat de app een paar seconden liggen (het kan nog aan het downloaden zijn)
  await page.waitForTimeout(5500);
  await toggle.click();
  await expect(page.getByText('1 afschrift gevonden. De vraag "Inlezen?" staat op Vandaag.')).toBeVisible();
  await expect(toggle).toBeChecked();
  // er is nog niets ingelezen
  expect(await call<unknown[]>(page, 'bank.transactions', {})).toHaveLength(0);

  await nav(page, 'Vandaag');
  const show = page.getByRole('button', { name: /^Toon alle/ });
  if (await show.isVisible()) await show.click();
  const task = page.locator('.task', { hasText: 'Nieuw afschrift gevonden' });
  await expect(task).toHaveCount(1);
  await expect(task).toContainText('Nieuw afschrift gevonden: Zakelijke rekening, 1 september 2026 t/m 29 september 2026');
  await expect(task).toContainText('CAMT053_september.xml staat in je downloadmap, met 2 betalingen. Inlezen?');
  await expect(task.getByRole('button', { name: 'Niet nu' })).toBeVisible();
  await task.getByRole('button', { name: 'Inlezen' }).click();

  // dezelfde samenvatting als na het slepen van een afschrift
  await expect(page.locator('.notice.good')).toContainText('2 nieuwe betalingen.');
  await expect(page.locator('table.list tbody tr', { hasText: 'Shell' }).first()).toBeVisible();
  expect(await call<unknown[]>(page, 'bank.transactions', {})).toHaveLength(2);
  await nav(page, 'Vandaag');
  await expect(page.locator('.hero')).toBeVisible();
  await expect(page.locator('.task', { hasText: 'Nieuw afschrift gevonden' })).toHaveCount(0);

  // de map is niet aangeraakt
  expect(readdirSync(dir).sort().map((n) => [n, readFileSync(join(dir, n), 'hex')])).toEqual(before);
  expect(problems.apiErrors).toEqual([]);
});

test('Niet nu laat het afschrift liggen; een later gedownload afschrift wordt een nieuwe vraag; uitzetten haalt de vragen weg', async ({ page, request, problems }) => {
  await onboard(page);
  const dir = (await (await request.post('/__downloads')).json()).ok as string;
  put(dir, 'afschrift.csv', CSV);
  await nav(page, 'Bank');
  const card = page.locator('.card', { hasText: 'Afschriften vanzelf inlezen' });
  await card.getByLabel('Kijk in deze map naar nieuwe afschriften').click();
  await expect(card.getByLabel('Kijk in deze map naar nieuwe afschriften')).toBeChecked();
  // net binnengekomen bestanden wachten een paar seconden; de app kijkt daarna vanzelf opnieuw
  await expect.poll(async () => (await call<{ waiting: boolean }>(page, 'bank.scanStatements')).waiting, { timeout: 15_000 }).toBe(false);

  await nav(page, 'Vandaag');
  const tasks = page.locator('.task', { hasText: 'Nieuw afschrift gevonden' });
  await expect(tasks).toHaveCount(1);
  await expect(tasks.first()).toContainText('afschrift.csv staat in je downloadmap, met 3 betalingen. Inlezen?');
  await tasks.first().getByRole('button', { name: 'Niet nu' }).click();
  await expect(tasks).toHaveCount(0);
  expect(await call<unknown[]>(page, 'bank.transactions', {})).toHaveLength(0);
  expect(readdirSync(dir)).toEqual(['afschrift.csv']);

  // de gebruiker downloadt een nieuw afschrift; de app kijkt (zoals hij zelf elke paar minuten doet)
  put(dir, 'oktober.xml', camt(IBAN, [{ ref: 'O1', date: '2026-09-30', amount: -20, name: 'Gamma' }]));
  await expect.poll(async () => (await call<{ waiting: boolean }>(page, 'bank.scanStatements')).waiting, { timeout: 15_000 }).toBe(false);
  await page.reload();
  await expect(tasks).toHaveCount(1);
  await expect(tasks.first()).toContainText('oktober.xml');

  // een andere map kiezen: daar staat niets; uitzetten: geen vragen meer
  await nav(page, 'Bank');
  await card.getByRole('button', { name: 'Andere map kiezen' }).click();
  await expect(card).toContainText('Andere map');
  await card.getByLabel('Kijk in deze map naar nieuwe afschriften').click();
  await expect(card.getByLabel('Kijk in deze map naar nieuwe afschriften')).not.toBeChecked();
  await nav(page, 'Vandaag');
  await expect(page.locator('.hero')).toBeVisible();
  await expect(tasks).toHaveCount(0);
  expect(readdirSync(dir).sort()).toEqual(['afschrift.csv', 'oktober.xml']);
  expect(problems.apiErrors).toEqual([]);
});
