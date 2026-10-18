import { test, expect, onboard, nav, call } from './fixtures';

test('zakelijk deel per leverancier: eerst een lijst om na te kijken, pas na bevestigen verandert er iets', async ({ page }) => {
  await onboard(page);
  await call(page, 'purchases.recordExpense', { date: '2026-02-01', supplierName: 'Dropbox', description: 'Dropbox jaar', categoryKey: 'software', grossAmount: 12100, vatCode: 'hoog', paidWith: 'prive' });
  await nav(page, 'Instellingen');
  await page.locator('main .chips').first().getByRole('button', { name: 'Categorieën' }).click();

  const card = page.locator('.card', { hasText: 'Gemengd gebruik: zakelijk deel per leverancier' });
  await card.getByPlaceholder('bv. Dropbox').fill('Dropbox');
  await card.getByRole('button', { name: 'Opslaan en boekingen bekijken' }).click();

  const dlg = page.getByRole('dialog', { name: 'Boekingen van Dropbox' });
  const row = dlg.locator('tbody tr').first();
  await expect(row).toContainText('100%');
  // het voorstel staat klaar maar er is nog niets veranderd
  await expect(dlg.getByText(/Er verandert pas iets als je onderaan bevestigt/)).toBeVisible();
  const before = await call<{ balances?: unknown }>(page, 'vat.calculate', '2026-Q1');
  expect(JSON.stringify(before)).toContain('2100');

  // een eigen percentage voor deze boeking
  await row.getByLabel('Nieuw zakelijk deel').fill('40');
  await expect(dlg.getByRole('button', { name: 'Bevestig 1 boeking' })).toBeEnabled();
  await dlg.getByRole('button', { name: 'Bevestig 1 boeking' }).click();
  await expect(dlg.getByRole('status')).toContainText('1 boeking aangepast');
  // de lijst laat nu het nieuwe percentage zien
  await expect(dlg.locator('tbody tr').first()).toContainText('40%');
  const after = await call<{ summary: { voorbelasting: number } }>(page, 'vat.calculate', '2026-Q1');
  expect(after.summary.voorbelasting).toBe(840);
});

test('aankopen: het zakelijke deel staat in de lijst en is per aankoop aan te passen', async ({ page }) => {
  await onboard(page);
  await call(page, 'purchases.recordExpense', { date: '2026-02-01', supplierName: 'Dropbox', description: 'Dropbox jaar', categoryKey: 'software', grossAmount: 12100, vatCode: 'hoog', paidWith: 'prive', businessPct: 25 });
  await nav(page, 'Aankopen');
  const row = page.locator('table.list tbody tr', { hasText: 'Dropbox' }).first();
  await expect(row).toContainText('25% zakelijk');
  // niet de hele € 21,00 btw, maar het zakelijke deel
  await expect(row).toContainText('€ 5,25');
  await expect(row).toContainText('€ 21,00');
  await row.getByRole('button', { name: 'Zakelijk deel aanpassen' }).click();
  const dlg = page.getByRole('dialog', { name: 'Hoeveel is zakelijk?' });
  await dlg.getByRole('spinbutton').fill('50');
  await expect(dlg).toContainText('btw die je terugkrijgt € 10,50');
  await dlg.getByRole('button', { name: 'Opslaan' }).click();
  await expect(row).toContainText('50% zakelijk');
});
