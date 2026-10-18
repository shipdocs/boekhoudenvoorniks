import { test, expect, onboard, nav } from './fixtures';

test('automatisch bijwerken staat standaard aan en is uit te zetten', async ({ page }) => {
  await onboard(page);
  await nav(page, 'Instellingen');
  await page.locator('main .chips').first().getByRole('button', { name: /Back-up/ }).click();
  const toggle = page.getByLabel('Automatisch bijwerken (aanbevolen)');
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText('De app zoekt niet zelf naar nieuwe versies')).toBeVisible();
  await page.reload();
  await nav(page, 'Instellingen');
  await page.locator('main .chips').first().getByRole('button', { name: /Back-up/ }).click();
  await expect(page.getByLabel('Automatisch bijwerken (aanbevolen)')).not.toBeChecked();
});

test('update wordt gedownload: voortgangsbalk met percentage, geen "Nu herstarten"', async ({ page, request }) => {
  await onboard(page);
  await request.post('/__update', { data: { state: 'downloaden', version: '9.9.9', percent: 37 } });
  await page.reload();
  const banner = page.getByRole('status').filter({ hasText: 'wordt gedownload' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('37%');
  await expect(banner.locator('progress')).toHaveJSProperty('value', 37);
  await expect(page.getByRole('button', { name: 'Nu herstarten' })).toHaveCount(0);
  await request.post('/__update', { data: { state: 'downloaden', percent: 82 } });
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'wordt gedownload' })).toContainText('82%');
});

test('update staat klaar: melding bovenaan, "Wat is er nieuw?" en "Nu herstarten"', async ({ page, request }) => {
  await onboard(page);
  await request.post('/__update', { data: { state: 'klaar', version: '9.9.9', notes: '• Bon in de mail\n• Doorsturen werkt' } });
  await page.reload();
  const banner = page.getByRole('status').filter({ hasText: 'Versie 9.9.9 staat klaar' });
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Wat is er nieuw?' }).click();
  const dlg = page.getByRole('dialog', { name: 'Nieuw in versie 9.9.9' });
  await expect(dlg).toContainText('Doorsturen werkt');
  await dlg.getByRole('button', { name: 'Nu herstarten' }).click();
  const r = await (await request.post('/__update', { data: '' })).json();
  expect(r.ok.installed).toBe(true);
});
