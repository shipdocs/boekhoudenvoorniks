import { test, expect, onboard, nav, call } from './fixtures';

const CSV = [
  '"Datum";"Naam / Omschrijving";"Rekening";"Tegenrekening";"Code";"Af Bij";"Bedrag (EUR)";"Mutatiesoort";"Mededelingen"',
  '"20260812";"BURANDO SHIPPING AG";"NL91ABNA0417164300";"CH9300762011623852957";"OV";"Bij";"500,00";"Overschrijving";"Naam: BURANDO SHIPPING AG Omschrijving: I-MOL-2026-00344 IBAN: CH9300762011623852957"',
].join('\n');

test('omzet via Mollie van een Zwitserse klant: 0% voorgesteld, factuurnummer bewaard, rubriek 3a', async ({ page }) => {
  await onboard(page);
  await call(page, 'relations.create', { name: 'Burando Shipping', country: 'CH', vat_number: 'CHE253742182' });
  await nav(page, 'Bank');
  await page.locator('main input[type=file]').first().setInputFiles({ name: 'afschrift.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
  const row = page.locator('table.list tbody tr', { hasText: /BURANDO/ }).first();
  await expect(row).toBeVisible();
  await row.click();
  await page.getByRole('button', { name: /Ik heb iets verkocht/ }).click();
  await expect(page.locator('label.field', { hasText: 'Hoeveel btw' }).locator('select')).toHaveValue('export');
  await expect(page.getByText(/Voorstel omdat Burando Shipping zit in het buitenland/)).toBeVisible();
  await expect(page.locator('label.field', { hasText: 'Nummer van de factuur' }).locator('input')).toHaveValue('I-MOL-2026-00344');
  await page.getByRole('button', { name: 'Verwerk als verkoop' }).click();
  await expect(page.getByText('Verwerkt ✓').last()).toBeVisible();

  const r = await call<{ rubrieken: { code: string; omzet: number | null; btw: number | null }[] }>(page, 'vat.calculate', '2026-Q3');
  expect(r.rubrieken.find((x) => x.code === '3a')!.omzet).toBe(50000);
  expect(r.rubrieken.find((x) => x.code === '5a')!.btw).toBe(0);
});
