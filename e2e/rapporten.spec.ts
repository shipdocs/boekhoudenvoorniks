import { test, expect, onboard, nav, call } from './fixtures';

test('rapporten voor de boekhouder: kolommenbalans, kaarten, relatiekaarten en periodebalans', async ({ page }) => {
  await onboard(page);
  await call(page, 'settings.update', { advancedMode: true });
  await page.reload();
  await call(page, 'purchases.recordExpense', { date: '2026-02-01', supplierName: 'Gamma', description: 'Materiaal', categoryKey: 'materiaal', grossAmount: 12100, vatCode: 'hoog', paidWith: 'prive' });
  await page.reload();
  await nav(page, 'Boekhouding');

  // kolommenbalans (eerste tabblad), datums staan op dit jaar
  await page.locator('input[type=date]').first().fill('2026-01-01');
  await page.locator('input[type=date]').nth(1).fill('2026-12-31');
  await expect(page.getByText('Debet = credit ✓')).toBeVisible();
  const kosten = page.locator('table.list tbody tr', { hasText: 'Inkoop materialen' }).first();
  await expect(kosten).toBeVisible();
  // klikken opent de grootboekkaart met de boeking
  await kosten.click();
  await expect(page.getByRole('heading', { name: /Inkoop materialen/ })).toBeVisible();
  await expect(page.getByText('Gamma').first()).toBeVisible();

  await page.getByRole('button', { name: 'Relatiekaarten' }).click();
  await page.getByRole('button', { name: /Gamma/ }).click();
  await expect(page.getByText(/Openstaand op/)).toContainText('-');

  await page.getByRole('button', { name: 'Periodebalans' }).click();
  await expect(page.locator('table.list thead')).toContainText('P2');
  await page.getByRole('button', { name: 'Per kwartaal' }).click();
  await expect(page.locator('table.list thead')).toContainText('Q1');
});
