import { test, expect, onboard, nav, call, field } from './fixtures';

/**
 * Verzoek van een bv-gebruiker: het nettoloon en de loonheffing vanaf de bank op de balans zetten, en een rekening
 * makkelijker vinden. Drie onderdelen: het maandvoorstel "Loon … boeken" op Vandaag (nooit vanzelf) met de bankkeuzes
 * voor een bv, de balansrekening in de boekhoudermodus, en het zoekveld in de categoriekeuze.
 */
const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000);
const ing = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
/** de vorige maand als JJJJ-MM en als "september 2026" */
function previousMonth(): { month: string; label: string } {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return { month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: `${MAANDEN[d.getMonth()]} ${d.getFullYear()}` };
}
const csv = (rows: { name: string; amount: string; bij?: boolean; text: string }[]) =>
  [
    '"Datum";"Naam / Omschrijving";"Rekening";"Tegenrekening";"Code";"Af Bij";"Bedrag (EUR)";"Mutatiesoort";"Mededelingen"',
    ...rows.map((r) => `"${ing(day(2))}";"${r.name}";"NL91ABNA0417164300";"";"OV";"${r.bij ? 'Bij' : 'Af'}";"${r.amount}";"Overschrijving";"${r.text}"`),
  ].join('\n');
const balance = async (page: Parameters<typeof call>[0], rgs: string) => (await call<{ rgs_code: string; balance: number }[]>(page, 'ledger.balances')).find((b) => b.rgs_code === rgs)?.balance ?? 0;

test('bv: loon instellen, het maandvoorstel op Vandaag bevestigen en nettoloon en loonheffing vanaf de bank betalen', async ({ page, problems }) => {
  await onboard(page);
  await call(page, 'settings.update', { legalForm: 'bv' });
  await page.reload();
  const prev = previousMonth();

  // instellen: bij de rechtsvorm, alleen bij een bv
  await nav(page, 'Instellingen');
  await page.locator('main .chips').first().getByRole('button', { name: /Btw/ }).click();
  await page.getByRole('checkbox', { name: /Ik krijg elke maand loon uit de bv/ }).check();
  const loon = page.getByTestId('loon-instellingen');
  await loon.locator('label.field', { hasText: 'Bruto per maand' }).locator('input').fill('5000');
  await loon.locator('label.field', { hasText: 'Loonheffing per maand' }).locator('input').fill('1500');
  await loon.locator('label.field', { hasText: 'Netto per maand' }).locator('input').fill('3500');
  await field(page, 'Vanaf welke maand').fill(prev.month);
  await page.getByRole('button', { name: 'Opslaan', exact: true }).first().click();
  await expect(page.getByText('Opgeslagen')).toBeVisible();
  expect((await call<{ loon: unknown }>(page, 'settings.get')).loon).toEqual({ bruto: 500000, loonheffing: 150000, netto: 350000, vanaf: prev.month });

  // op Vandaag: het voorstel voor vorige maand; er is nog niets geboekt
  await nav(page, 'Vandaag');
  const show = page.getByRole('button', { name: /^Toon alle/ });
  if (await show.isVisible()) await show.click();
  const task = page.locator('.task', { hasText: `Loon ${prev.label} boeken` });
  await expect(task).toHaveCount(1);
  await expect(task).toContainText('bruto € 5.000,00, loonheffing € 1.500,00, netto € 3.500,00');
  await expect(task.getByRole('button', { name: 'Bedragen aanpassen' })).toBeVisible();
  expect(await balance(page, 'WPerLesSld')).toBe(0);

  await task.getByRole('button', { name: 'Ja, boek het loon' }).click();
  await expect(page.locator('.task', { hasText: `Loon ${prev.label} boeken` })).toHaveCount(0);
  expect(await balance(page, 'WPerLesSld')).toBe(500000);
  expect(await balance(page, 'BSchSalNet')).toBe(-350000);
  expect(await balance(page, 'BSchBepLhe')).toBe(-150000);

  // de betalingen: op het bankscherm, zonder btw en zonder kosten
  await call(page, 'bank.importFile', 'loon.csv', csv([
    { name: 'P. Jansen', amount: '3500,00', text: 'Salaris' },
    { name: 'Belastingdienst', amount: '1500,00', text: 'Loonheffingen' },
  ]));
  await nav(page, 'Bank');
  await page.locator('table.list tbody tr', { hasText: 'P. Jansen' }).first().click();
  await expect(page.getByRole('heading', { name: 'Was dit zakelijk?' })).toBeVisible();
  // de balansrekening-keuze van de boekhoudermodus staat er niet (die staat uit)
  await expect(page.getByTestId('balansrekening')).toHaveCount(0);
  await page.getByTestId('bv-BSchSalNet').click();
  await expect(page.getByRole('heading', { name: 'Was dit zakelijk?' })).toBeHidden();
  await page.locator('table.list tbody tr', { hasText: 'Belastingdienst' }).first().click();
  await page.getByTestId('bv-BSchBepLhe').click();
  await expect(page.getByRole('heading', { name: 'Was dit zakelijk?' })).toBeHidden();
  expect(await balance(page, 'BSchSalNet')).toBe(0);
  expect(await balance(page, 'BSchBepLhe')).toBe(0);
  expect(await balance(page, 'WPerLesSld')).toBe(500000);
  expect(await balance(page, 'BSchBepBtwVoo')).toBe(0);
  expect(problems.apiErrors).toEqual([]);
});

test('boekhoudermodus: een betaling op een balansrekening zetten (lening ontvangen); gewone gebruikers zien de keuze niet', async ({ page, problems }) => {
  await onboard(page);
  await call(page, 'bank.importFile', 'lening.csv', csv([{ name: 'Bank Lening BV', amount: '10000,00', bij: true, text: 'Zakelijke lening' }]));
  await nav(page, 'Bank');
  await page.locator('table.list tbody tr', { hasText: 'Bank Lening BV' }).first().click();
  await expect(page.getByRole('heading', { name: 'Waar is dit geld voor?' })).toBeVisible();
  await expect(page.getByTestId('balansrekening')).toHaveCount(0);

  await call(page, 'settings.update', { advancedMode: true, advancedModeAgreedAt: '2026-10-15' });
  await page.reload();
  await nav(page, 'Bank');
  await page.locator('table.list tbody tr', { hasText: 'Bank Lening BV' }).first().click();
  await page.getByTestId('balansrekening').click();
  const select = page.getByRole('combobox', { name: 'Balansrekening' });
  // alleen rekeningen zonder eigen knop: geen bank, kas, klanten, leveranciers, btw of privé
  const options = await select.locator('option').allTextContents();
  expect(options.some((o) => /Leningen/i.test(o))).toBe(true);
  expect(options.some((o) => /Debiteuren|Crediteuren|Bank|Kas|Privé|btw/i.test(o))).toBe(false);
  await select.selectOption('BLasLen');
  await field(page, 'Omschrijving (mag leeg)').fill('Lening van de bank ontvangen');
  await page.getByRole('button', { name: 'Op deze rekening zetten' }).click();
  await expect(page.getByRole('heading', { name: 'Waar is dit geld voor?' })).toBeHidden();
  expect(await balance(page, 'BLasLen')).toBe(-1000000);
  // geen omzet en geen btw
  expect(await balance(page, 'WOmzNopOlh')).toBe(0);
  expect(await balance(page, 'BSchBepBtwVoo')).toBe(0);
  expect(problems.apiErrors).toEqual([]);
});

test('categorie kiezen: typen filtert de knoppen; niets gevonden verwijst naar een eigen categorie', async ({ page }) => {
  await onboard(page);
  await call(page, 'bank.importFile', 'kpn.csv', csv([{ name: 'KPN', amount: '121,00', text: 'Telefoon' }]));
  await nav(page, 'Bank');
  await page.locator('table.list tbody tr', { hasText: 'KPN' }).first().click();
  await expect(page.getByRole('heading', { name: 'Was dit zakelijk?' })).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'Zoek een categorie' });
  await expect(page.getByRole('button', { name: 'Materiaal', exact: true })).toBeVisible();
  await search.fill('verf');
  // "Materiaal" blijft staan: verf staat in de uitleg
  await expect(page.getByRole('button', { name: 'Materiaal', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bankkosten', exact: true })).toHaveCount(0);
  await search.fill('telefoon');
  await expect(page.getByRole('button', { name: 'Telefoon & internet', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Kantoorartikelen', exact: true })).toHaveCount(0);
  // de gekozen categorie blijft altijd staan, ook als hij niet op het zoekwoord past
  await expect(page.locator('.chips button.selected')).toHaveCount(1);
  await search.fill('zonnepanelen');
  await expect(page.getByText(/Geen categorie met "zonnepanelen"/)).toBeVisible();
  await expect(page.getByRole('button', { name: '+ Eigen categorie' })).toBeVisible();
  await search.fill('');
  await expect(page.getByRole('button', { name: 'Bankkosten', exact: true })).toBeVisible();
});
