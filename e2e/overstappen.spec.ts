import { test, expect, onboard, nav } from './fixtures';
import { OTHER_PACKAGE } from '../tests/fixtures/xaf-ander-pakket';
import { kolommenbalans } from '../tests/fixtures/xlsx';

test('overstapper: onboarding, beginsaldo, openstaande factuur en startpositie', async ({ page, problems }) => {
  await onboard(page, { overstap: true });
  const year = new Date().getFullYear();
  await expect(page.getByText(`1 januari ${year}`).first()).toBeVisible();
  await expect(page.getByText(/Bankafschriften vanaf 1 januari/)).toBeVisible();

  await page.getByRole('button', { name: /Verder: uit je vorige programma/ }).click();
  await page.getByRole('button', { name: /Verder: bankrekeningen/ }).click();
  await page.getByRole('textbox', { name: /Beginsaldo/ }).fill('1500,00');
  await page.getByRole('button', { name: 'Opslaan', exact: true }).first().click();
  await expect(page.locator('.pill', { hasText: /ingevuld: .*1\.500,00/ })).toBeVisible();

  await page.getByRole('button', { name: /Verder: klanten die nog moeten betalen/ }).click();
  await page.getByRole('button', { name: /Openstaande factuur toevoegen/ }).click();
  const dialog = page.locator('.modal');
  await dialog.getByLabel('Klant').fill('Familie Jansen');
  await dialog.getByLabel(/Factuurnummer/).fill(`${year - 1}-0099`);
  await dialog.getByLabel(/Nog open/).fill('1210,00');
  await dialog.getByRole('button', { name: 'Opslaan' }).click();
  await expect(page.getByText(`Factuur ${year - 1}-0099 Familie Jansen`)).toBeVisible();

  await page.locator('.chips button', { hasText: 'Je startpositie' }).click();
  await expect(page.getByText('Wat er van jou in de zaak zit')).toBeVisible();
  await expect(page.locator('.card', { hasText: 'Wat er van jou in de zaak zit' }).getByText(/2\.710,00/)).toBeVisible();

  // de openstaande factuur staat ook gewoon bij Werk & facturen
  await nav(page, 'Werk & facturen');
  await expect(page.getByText(`${year - 1}-0099`).first()).toBeVisible();
  expect(problems.apiErrors).toEqual([]);
});

test('overstapper: auditfile (XAF) uit het vorige programma inlezen', async ({ page, problems }) => {
  const year = new Date().getFullYear();
  test.skip(year !== 2026, 'de voorbeeld-auditfile is van 2026');
  await onboard(page, { overstap: true });
  await page.getByRole('button', { name: /Verder: uit je vorige programma/ }).click();
  await page.locator('main input[type=file]').first().setInputFiles({ name: 'export.xaf', mimeType: 'application/xml', buffer: Buffer.from(OTHER_PACKAGE) });
  await expect(page.getByRole('heading', { name: 'Wat de app overneemt' })).toBeVisible();
  await expect(page.getByText('Factuur 2025-050 Bakker Bouw')).toBeVisible();
  // niet herkend staat standaard uit
  await expect(page.getByRole('checkbox', { name: /Diversen/ })).not.toBeChecked();
  await page.getByRole('button', { name: 'Overnemen' }).click();
  await expect(page.getByText(/onderdelen overgenomen uit een auditfile/)).toBeVisible();

  await page.locator('.chips button', { hasText: 'Je startpositie' }).click();
  await expect(page.locator('.card', { hasText: 'Wat er van jou in de zaak zit' }).getByText(/12\.910,00/)).toBeVisible();
  // Diversen niet overgenomen: het verschil met de vorige administratie wordt gemeld
  await expect(page.getByText(/Verschil met je vorige administratie: .*100,00/)).toBeVisible();
  expect(problems.apiErrors).toEqual([]);
});

test('overstapper: kolommenbalans (Excel) uit DigiBoox inlezen', async ({ page, problems }) => {
  test.skip(new Date().getFullYear() !== 2026, 'de voorbeeld-kolommenbalans is van 2026');
  await onboard(page, { overstap: true });
  await page.getByRole('button', { name: /Verder: uit je vorige programma/ }).click();
  await page.locator('main input[type=file]').first().setInputFiles({ name: 'kolommenbalans.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(kolommenbalans()) });
  await expect(page.getByText(/alleen saldi/)).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Bestelbus' })).toBeChecked();
  await page.getByRole('checkbox', { name: /Kruisposten/ }).check();
  await page.getByRole('button', { name: 'Overnemen' }).click();
  await page.locator('.chips button', { hasText: 'Je startpositie' }).click();
  await expect(page.locator('.card', { hasText: 'Wat er van jou in de zaak zit' }).getByText(/2\.500,00/)).toBeVisible();
  expect(problems.apiErrors).toEqual([]);
});
