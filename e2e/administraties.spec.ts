import { expect } from '@playwright/test';
import { nav, onboard, test } from './fixtures';

test('een tweede administratie aanmaken, openen en terug naar de eerste', async ({ page }) => {
  await onboard(page);
  await nav(page, 'Instellingen');
  await page.getByRole('button', { name: 'Administraties' }).click();
  await expect(page.getByRole('heading', { name: 'Administraties op deze computer' })).toBeVisible();
  const eerste = page.locator('.sumtable tr').first();
  await expect(eerste.getByText('Open')).toBeVisible();

  await page.getByPlaceholder('bv. Bakker Bouw B.V.').fill('Bakker Bouw B.V.');
  await page.getByRole('button', { name: 'Aanmaken en openen' }).click();
  // de app ververst het venster na het wisselen; de testserver niet
  await page.reload();
  // een nieuwe administratie begint bij het welkomstscherm
  await expect(page.getByRole('button', { name: /Bekijk de demo/ })).toBeVisible();

  // terug naar de eerste via de testserver-api (het welkomstscherm heeft geen instellingen)
  const list = await page.evaluate(() => window.bridge.call('administrations.list', []));
  expect((list as { name: string; current: boolean }[]).map((a) => [a.name, a.current])).toEqual([['Stukadoorsbedrijf Piet', false], ['Bakker Bouw B.V.', true]]);
  await page.evaluate(() => window.bridge.call('administrations.open', ['']));
  await page.reload();
  await expect(page.locator('nav.nav')).toBeVisible();
  // met twee administraties staat de open administratie onder de naam van de app
  await expect(page.locator('nav.nav').getByText('Stukadoorsbedrijf Piet')).toBeVisible();
});
