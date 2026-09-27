import { test, expect, onboard, nav } from './fixtures';

test('overstapper: onboarding, beginsaldo, openstaande factuur en startpositie', async ({ page, problems }) => {
  await onboard(page, { overstap: true });
  const year = new Date().getFullYear();
  await expect(page.getByText(`1 januari ${year}`).first()).toBeVisible();
  await expect(page.getByText(/Bankafschriften vanaf 1 januari/)).toBeVisible();

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
