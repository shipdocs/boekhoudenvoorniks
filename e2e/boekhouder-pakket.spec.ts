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

  await card.getByRole('button', { name: `Pakket ${year} maken (ZIP)` }).click();
  await expect(card).toContainText(`overdracht-boekhouder-`);
  await expect(card).toContainText(`-${year}.zip`);
});
