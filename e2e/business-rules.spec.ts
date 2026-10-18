import { test, expect, onboard, nav, call } from './fixtures';

test('creditnota bij twee bedrijfsmiddelen: de keuze werkt door in het register', async ({ page, problems }) => {
  await onboard(page);
  await call(page, 'settings.update', { taxCheckAcknowledgedYear: new Date().getFullYear() });
  for (const [name, amount, date] of [['Machine A', 100000, '2026-02-01'], ['Machine B', 200000, '2026-02-02'], ['Creditnota machine', -20000, '2026-02-03']] as const) {
    await call(page, 'purchases.create', { description: name, invoiceDate: date, lines: [{ account: 'BMvaBedIna', netAmount: amount, vatCode: 'geen' }] }, { allowDuplicate: true });
  }
  await page.reload(); await nav(page, 'Belasting');
  await page.getByRole('button', { name: 'Aftrek, investeringen en kilometers' }).click();
  await page.getByRole('button', { name: 'Investeringen', exact: true }).click();
  const choice = page.locator('.card', { hasText: 'Bij welke investering hoort deze creditnota?' });
  await expect(choice).toBeVisible();
  await choice.getByRole('button', { name: /Machine A/ }).click();
  await expect(choice).toHaveCount(0);
  const rows = await call<{ cost: number }[]>(page, 'assets.list');
  expect(rows.map(a => a.cost).sort((a,b) => a-b)).toEqual([80000,200000]);
  expect(problems.apiErrors).toEqual([]);
});

test('aanschaf-btw en jaarlijkse autokosten-btw zijn apart op te geven', async ({ page }) => {
  await onboard(page);
  await call(page, 'settings.update', { carUse: 'zakelijk', carPrivateUse: true, carVatDeducted: true, carVatMethod: 'forfait' });
  await page.reload(); await nav(page, 'Instellingen');
  await page.locator('main .chips').first().getByRole('button', { name: /Btw/ }).click();
  await page.locator('label.field', { hasText: 'Heb je bij de aanschaf btw afgetrokken?' }).locator('select').selectOption('nee');
  await expect(page.getByText(/Zonder aanschaf-btw geldt 1,5%/).last()).toBeVisible();
  const settings = await call<{ carPurchaseVatDeducted: boolean }>(page, 'settings.get');
  // Het scherm bewaart wijzigingen via de gewone opslaanknop.
  await page.getByRole('button', { name: 'Opslaan', exact: true }).first().click();
  expect((await call<typeof settings>(page, 'settings.get')).carPurchaseVatDeducted).toBe(false);
});
