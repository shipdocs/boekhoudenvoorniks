import { test, expect, onboard, nav, call, field } from './fixtures';

test('bv: BV-rekeningen erbij, eigen rekening toevoegen met RGS-code, hernoemen en gebruiken in een memoriaal', async ({ page, problems }) => {
  await onboard(page);
  await call(page, 'settings.update', { advancedMode: true, advancedModeAgreedAt: '2026-10-15', legalForm: 'bv' });
  await page.reload();
  await nav(page, 'Boekhouding');
  await page.getByRole('button', { name: 'Rekeningschema', exact: true }).click();
  const table = page.getByTestId('rekeningschema');
  await expect(table).toContainText('Af te dragen loonheffing');
  await expect(table).toContainText('Rekening-courant directeur-grootaandeelhouder');

  // eigen rekening: zoeken in de officiële lijst
  await page.getByRole('button', { name: '+ Rekening toevoegen' }).click();
  const dlg = page.getByRole('dialog', { name: 'Rekening toevoegen' });
  await dlg.getByPlaceholder('zoeken in de officiële lijst').fill('managementvergoeding');
  await dlg.locator('tr', { hasText: 'WOvbOnmOnm' }).getByRole('button', { name: 'Kiezen' }).click();
  await expect(dlg.getByTestId('gekozen-rgs')).toContainText('WOvbOnmOnm');
  await field(page, 'Naam van de rekening').fill('Managementvergoeding ontvangen');
  await dlg.getByRole('button', { name: 'Toevoegen', exact: true }).click();
  await expect(dlg).toBeHidden();
  await expect(table.locator('tr', { hasText: 'Managementvergoeding ontvangen' })).toContainText('WOvbOnmOnm');

  // omzet kun je niet zelf toevoegen
  await page.getByRole('button', { name: '+ Rekening toevoegen' }).click();
  await dlg.getByPlaceholder('zoeken in de officiële lijst').fill('WOmzNodOdh');
  await expect(dlg.getByText(/Niets gevonden/)).toBeVisible();
  await dlg.getByRole('button', { name: 'Annuleren' }).click();

  // hernoemen
  await table.locator('tr', { hasText: 'Lonen en salarissen' }).getByRole('button', { name: 'Hernoemen' }).click();
  const ren = page.getByRole('dialog', { name: 'Rekening hernoemen' });
  await ren.locator('input').fill('Lonen personeel');
  await ren.getByRole('button', { name: 'Opslaan' }).click();
  await expect(table).toContainText('Lonen personeel');

  // de nieuwe rekeningen staan in de correctieboeking
  await page.getByRole('button', { name: 'Journaal', exact: true }).click();
  await page.getByRole('button', { name: 'Correctieboeking', exact: true }).click();
  const memo = page.getByRole('dialog', { name: 'Correctieboeking (memoriaal)' });
  await memo.locator('input[type=date]').fill('2026-03-31');
  await memo.locator('input').nth(1).fill('Loon maart');
  await memo.locator('select').nth(0).selectOption('WPerLesSld');
  await memo.locator('input[placeholder=debet]').nth(0).fill('5000');
  await memo.locator('select').nth(1).selectOption('BSchBepLhe');
  await memo.locator('input[placeholder=credit]').nth(1).fill('5000');
  await memo.getByRole('button', { name: 'Boeken', exact: true }).click();
  await expect(page.locator('.toasts').getByText('Geboekt')).toBeVisible();
  expect(problems.pageErrors).toEqual([]);
});
