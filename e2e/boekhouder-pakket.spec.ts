import { test, expect, onboard, nav, call } from './fixtures';

test('pakket voor je boekhouder: controles vooraf en één ZIP', async ({ page }) => {
  await onboard(page);
  const year = new Date().getFullYear();
  await call(page, 'purchases.recordExpense', { date: `${year}-02-01`, supplierName: 'Gamma', description: 'Materiaal', categoryKey: 'materiaal', grossAmount: 12100, vatCode: 'hoog', paidWith: 'prive' });
  await page.reload();
  await nav(page, 'Hoe gaat het?');

  const card = page.getByTestId('boekhouder-pakket');
  await expect(card).toBeVisible();
  await card.getByLabel('Boekjaar').selectOption(String(year));
  await expect(card).toContainText('Beginbalans is in evenwicht');
  // de aankoop heeft geen bon: dat zie je vóór het maken
  await expect(card).toContainText('Bij elke inkoop zit een bon of factuur');
  await expect(card.getByText('let op').first()).toBeVisible();
  // en je zoekt de bon er meteen bij: de lijst toont de aankoop, met "Bon toevoegen" en "Openen"
  await card.getByRole('button', { name: 'Bonnen erbij zoeken' }).click();
  const missing = page.getByTestId('pakket-ontbrekende-documenten');
  await expect(missing).toContainText('Gamma · Materiaal');
  await expect(missing).toContainText('geen bon of factuur bewaard');
  await expect(missing.getByRole('button', { name: 'Bon toevoegen' })).toBeVisible();
  await missing.getByRole('button', { name: 'Openen' }).click();
  await expect(page.getByRole('heading', { name: 'Aankopen', exact: true })).toBeVisible();
  await nav(page, 'Hoe gaat het?');
  // bon toevoegen: daarna is de controle in orde
  await card.getByRole('button', { name: 'Bonnen erbij zoeken' }).click();
  await page.getByTestId('pakket-ontbrekende-documenten').getByRole('button', { name: 'Bon toevoegen' }).click();
  await page.getByTestId('pakket-ontbrekende-documenten').locator('input[type=file]').setInputFiles('tests/fixtures/ubl-invoice.xml');
  await expect(page.locator('.toasts').getByText(/gekoppeld|Let op: deze bon/)).toBeVisible();
  await expect(card.getByRole('button', { name: 'Bonnen erbij zoeken' })).toHaveCount(0);
  await expect(card.locator('li.ok', { hasText: 'Bij elke inkoop zit een bon of factuur' })).toBeVisible();

  await card.getByRole('button', { name: `Pakket ${year} maken (ZIP)` }).click();
  await expect(card).toContainText(`overdracht-boekhouder-`);
  await expect(card).toContainText(`-${year}.zip`);
});
