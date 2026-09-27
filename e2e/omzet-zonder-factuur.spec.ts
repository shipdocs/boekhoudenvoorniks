import { test, expect, onboard, nav, call } from './fixtures';

const HEAD = '"Datum";"Naam / Omschrijving";"Rekening";"Tegenrekening";"Code";"Af Bij";"Bedrag (EUR)";"Mutatiesoort";"Mededelingen"';
const row = (date: string, ref: string) =>
  `"${date}";"BURANDO SHIPPING AG";"NL91ABNA0417164300";"CH9300762011623852957";"OV";"Bij";"500,00";"Overschrijving";"Naam: BURANDO SHIPPING AG Omschrijving: ${ref} IBAN: CH9300762011623852957"`;
const CSV = [HEAD, row('20260812', 'I-MOL-2026-00343'), row('20260922', 'I-MOL-2026-00344')].join('\n');

test('verkoop via Mollie van een Zwitserse klant: 0% voorgesteld, daarna "net als vorige keer"', async ({ page }) => {
  await onboard(page);
  await call(page, 'relations.create', { name: 'Burando Shipping', country: 'CH', vat_number: 'CHE253742182' });
  await nav(page, 'Bank');
  await page.locator('main input[type=file]').first().setInputFiles({ name: 'afschrift.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });

  // eerste betaling: kiezen
  await page.locator('table.list tbody tr', { hasText: /I-MOL-2026-00343/ }).first().click();
  await page.getByRole('button', { name: /Verkoop via een ander systeem/ }).click();
  await expect(page.locator('label.field', { hasText: 'Hoeveel btw' }).locator('select')).toHaveValue('export');
  await expect(page.getByText(/Voorstel omdat Burando Shipping zit in het buitenland/)).toBeVisible();
  await expect(page.locator('label.field', { hasText: 'Nummer van de factuur' }).locator('input')).toHaveValue('I-MOL-2026-00343');
  await page.locator('label.field', { hasText: 'Via welk systeem' }).locator('input').fill('Mollie');
  await page.getByRole('button', { name: 'Verwerk als verkoop' }).click();
  await expect(page.getByText('Verwerkt ✓').last()).toBeVisible();

  // tweede betaling: één klik
  await page.locator('table.list tbody tr', { hasText: /I-MOL-2026-00344/ }).first().click();
  await expect(page.getByText('Weer een verkoop via Mollie?')).toBeVisible();
  await expect(page.getByText(/klant buiten de EU, 0% btw/)).toBeVisible();
  await page.getByRole('button', { name: 'Klopt, verwerk als verkoop' }).click();
  await expect(page.getByText('Verwerkt ✓').last()).toBeVisible();

  const r = await call<{ rubrieken: { code: string; omzet: number | null; btw: number | null }[] }>(page, 'vat.calculate', '2026-Q3');
  expect(r.rubrieken.find((x) => x.code === '3a')!.omzet).toBe(100000);
  expect(r.rubrieken.find((x) => x.code === '5a')!.btw).toBe(0);
});
