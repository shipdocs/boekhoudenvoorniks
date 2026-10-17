import { expect } from '@playwright/test';
import { nav, onboard, test } from './fixtures';

test('een tweede administratie aanmaken, openen en terug naar de eerste', async ({ page }) => {
  await onboard(page);
  await nav(page, 'Instellingen');
  await page.getByRole('button', { name: 'Administraties' }).click();
  await expect(page.getByRole('heading', { name: 'Administraties op deze computer' })).toBeVisible();
  const eerste = page.locator('.sumtable tr').first();
  await expect(eerste.getByText('Open', { exact: true })).toBeVisible();

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

  // beheren (#444): de naam van de tweede wijzigen zonder hem te openen
  await nav(page, 'Instellingen');
  await page.getByRole('button', { name: 'Administraties' }).click();
  const tweede = page.locator('.sumtable tr').nth(1);
  await expect(tweede).toContainText('Bakker Bouw B.V.');
  await tweede.getByRole('button', { name: 'Naam wijzigen' }).click();
  await page.getByLabel('Nieuwe naam').fill('Bakker Bouw B.V. (oud)');
  await tweede.getByRole('button', { name: 'Opslaan' }).click();
  await expect(page.locator('.sumtable')).toContainText('Bakker Bouw B.V. (oud)');
  // de eerste (open) administratie kan niet weg; de tweede wel, na het typen van de naam
  await expect(page.locator('.sumtable tr').first().getByRole('button', { name: 'Weghalen…' })).toHaveCount(0);
  await page.locator('.sumtable tr').filter({ hasText: 'Bakker Bouw B.V. (oud)' }).getByRole('button', { name: 'Weghalen…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Bakker Bouw B.V. (oud) weghalen' });
  await expect(dlg.getByRole('button', { name: 'Naar de prullenbak' })).toBeDisabled();
  await dlg.getByLabel('Typ de naam van de administratie om te bevestigen').fill('bakker bouw b.v. (oud)');
  await dlg.getByRole('button', { name: 'Naar de prullenbak' }).click();
  await expect(dlg).toBeHidden();
  await expect(page.locator('.sumtable')).not.toContainText('Bakker Bouw');
  expect(((await page.evaluate(() => window.bridge.call('administrations.list', []))) as { name: string }[]).map((a) => a.name)).toEqual(['Stukadoorsbedrijf Piet']);
});
