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
  await expect(page.getByText('Verwerkt ✓').last()).toBeVisible();
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
  // op de naam zelf: eigen categorieën noemen "hoort bij overige kosten"
  const overig = dlg.locator('tr').filter({ has: page.locator('strong', { hasText: /^Overige kosten$/ }) });
  await expect(overig).toHaveCount(1);
  await expect(overig.getByRole('button', { name: 'Verbergen' })).toHaveCount(0);
});

test('betaling op Vandaag aanklikken: alle gegevens van de bank om hem te beoordelen', async ({ page, problems }) => {
  await onboard(page);
  await nav(page, 'Bank');
  await page.locator('main input[type=file]').first().setInputFiles({ name: 'afschrift.csv', mimeType: 'text/csv', buffer: CSV });
  await expect(page.getByText(/betalingen ingelezen|ingelezen/).first()).toBeVisible();
  await nav(page, 'Vandaag');
  const link = page.locator('.task .title-link').first();
  await expect(link).toBeVisible();
  const title = (await link.textContent())!;
  await link.click();
  const dlg = page.getByRole('dialog', { name: 'Betaling bekijken' });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole('row', { name: /Omschrijving/ })).toBeVisible();
  await expect(dlg.getByRole('row', { name: /Rekeningnummer/ })).toBeVisible();
  await expect(dlg.getByRole('heading', { name: /^Eerder/ })).toBeVisible();
  await dlg.getByRole('button', { name: 'Later' }).click();
  await expect(dlg).toBeHidden();
  // niets verwerkt: de taak staat er nog
  await expect(page.locator('.task .title-link', { hasText: title }).first()).toBeVisible();
  expect(problems.apiErrors).toEqual([]);
});

test('Uitzoeken bij geld dat binnenkwam: meteen het scherm om het in te delen, met rente en refund als keuze', async ({ page, problems }) => {
  await onboard(page);
  await nav(page, 'Bank');
  await page.locator('main input[type=file]').first().setInputFiles({ name: 'afschrift.csv', mimeType: 'text/csv', buffer: CSV });
  await expect(page.getByText(/betalingen ingelezen|ingelezen/).first()).toBeVisible();
  await nav(page, 'Vandaag');
  const show = page.getByRole('button', { name: /^Toon alle/ });
  if (await show.isVisible()) await show.click();
  const btn = page.getByRole('button', { name: 'Uitzoeken' }).first();
  await expect(btn).toBeVisible();
  await btn.click();
  await expect(page.getByRole('heading', { name: 'Waar is dit geld voor?' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Rente ontvangen/ })).toBeVisible();
  await page.getByRole('button', { name: /Geld terug van een aankoop/ }).click();
  await expect(page.getByRole('button', { name: 'Het was een privé-aankoop' })).toBeVisible();
  await expect(page.getByText(/Alle gegevens van deze betaling/)).toBeVisible();
  expect(problems.apiErrors).toEqual([]);
});
