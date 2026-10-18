import { expect } from '@playwright/test';
import { nav, onboard, test } from './fixtures';

test('een kwartaal afsluiten: controles, bevestigen, en daarna vast', async ({ page }) => {
  await onboard(page);
  await nav(page, 'Hoe gaat het?');
  const card = page.getByTestId('periode-afsluiten');
  await expect(card.getByRole('heading', { name: /Periode afsluiten/ })).toBeVisible();
  const select = card.getByLabel('Afsluiten t/m');
  // het laatste afgelopen kwartaal staat voorgeselecteerd
  const label = (await select.locator('option:checked').textContent())!;
  const date = label.replace(/ \(.*/, '');
  await expect(card.getByText(`✓ Alles t/m ${date} is verwerkt.`)).toBeVisible();
  await card.getByRole('button', { name: `Afsluiten t/m ${date}` }).click();
  const dialog = page.getByRole('dialog', { name: `Afsluiten t/m ${date}?` });
  await expect(dialog.getByText('Dit kan niet ongedaan gemaakt worden.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Definitief afsluiten' }).click();
  await expect(card.getByText(`Afgesloten t/m ${date}.`)).toBeVisible();
  // de afgesloten periode staat niet meer in de keuzelijst
  await expect(select.locator('option', { hasText: label })).toHaveCount(0);
});
