import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, onboard, nav, call } from './fixtures';

const CSV = readFileSync(join(__dirname, '..', 'tests', 'fixtures', 'ing.csv'));

test('bankafschrift inlezen en een betaling indelen met een eigen categorie', async ({ page }) => {
  await onboard(page);
  await nav(page, 'Bank');
  await page.locator('main input[type=file]').first().setInputFiles({ name: 'afschrift.csv', mimeType: 'text/csv', buffer: CSV });
  await expect(page.getByText(/betalingen ingelezen|ingelezen/).first()).toBeVisible();
  const row = page.locator('table.list tbody tr', { hasText: /SHELL/i }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByRole('heading', { name: 'Was dit zakelijk?' })).toBeVisible();

  await page.getByRole('button', { name: '+ Eigen categorie', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'Eigen categorie' });
  await dlg.locator('label.field', { hasText: 'Naam' }).locator('input').fill('Tanken aggregaat');
  await dlg.locator('label.field', { hasText: 'Hoort bij' }).locator('select').selectOption('materiaal');
  await dlg.getByRole('button', { name: 'Opslaan' }).click();
  await expect(dlg).toBeHidden();
  await expect(page.locator('.chips button.selected')).toHaveText('Tanken aggregaat');
  await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
  await expect(page.getByText('Verwerkt ✓')).toBeVisible();
  // de categorie is er ook bij de bonnetjes
  const cats = await call<{ categories: { label: string }[] }>(page, 'categories.all');
  expect(cats.categories.map((c) => c.label)).toContain('Tanken aggregaat');
});

test('bonnetje zonder foto invoeren; Esc in het categorievenster sluit alleen dat venster', async ({ page }) => {
  await onboard(page);
  await nav(page, 'Aankopen & bonnetjes');
  await page.getByRole('button', { name: 'Bonnetje zonder foto' }).click();
  const dlg = page.getByRole('dialog', { name: 'Aankoop toevoegen' });
  await dlg.getByPlaceholder('bv. Gamma').fill('Gamma');
  await dlg.locator('label.field', { hasText: 'Bedrag op de bon' }).locator('input').fill('121,00');

  // genest venster: Esc hoort alleen het bovenste te sluiten
  await dlg.getByRole('button', { name: '+ Eigen categorie', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Eigen categorie' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Eigen categorie' })).toBeHidden();
  await expect(dlg, 'het aankoopvenster (met ingevulde gegevens) blijft open').toBeVisible();

  await dlg.getByRole('button', { name: 'Contant', exact: true }).click();
  await dlg.getByRole('button', { name: 'Opslaan', exact: true }).click();
  await expect(page.getByText('Aankoop verwerkt ✓')).toBeVisible();
  await expect(page.locator('table.list tbody tr', { hasText: 'Gamma' })).toBeVisible();
});

test('categorieën: aanpassen en verbergen in Instellingen', async ({ page }) => {
  await onboard(page);
  await nav(page, 'Instellingen');
  await page.locator('main .chips').first().getByRole('button', { name: 'Categorieën' }).click();
  await page.getByRole('button', { name: 'Categorieën bekijken en aanpassen' }).click();
  const dlg = page.getByRole('dialog', { name: 'Categorieën' });
  await dlg.locator('tr', { hasText: 'Werkkleding' }).getByRole('button', { name: 'Verbergen' }).click();
  await expect(dlg.locator('tr', { hasText: 'Werkkleding' })).toHaveCount(0);
  await dlg.getByLabel(/Toon verborgen/).check();
  await expect(dlg.locator('tr', { hasText: 'Werkkleding' })).toContainText('verborgen');
  // "Overige kosten" kan niet weg
  await expect(dlg.locator('tr', { hasText: 'Overige kosten' }).getByRole('button', { name: 'Verbergen' })).toHaveCount(0);
});
