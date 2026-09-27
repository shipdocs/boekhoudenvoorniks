import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, onboard, nav } from './fixtures';

const CSV = readFileSync(join(__dirname, '..', 'tests', 'fixtures', 'ing.csv'));

test('"weet ik nog niet" oplossen: de betalingen zien en opnieuw indelen', async ({ page }) => {
  await onboard(page);
  await nav(page, 'Bank');
  await page.locator('main input[type=file]').first().setInputFiles({ name: 'afschrift.csv', mimeType: 'text/csv', buffer: CSV });
  await page.locator('table.list tbody tr', { hasText: /SHELL/i }).first().click();
  await page.getByRole('button', { name: 'Weet ik nog niet (later uitzoeken)' }).click();
  await expect(page.getByText('Verwerkt ✓')).toBeVisible();

  // Belasting: de controle, met "Oplossen" → welke betalingen
  await nav(page, 'Belasting');
  const row = page.locator('ul.checks li', { hasText: 'weet ik nog niet' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Oplossen' }).click();
  const dlg = page.getByRole('dialog', { name: /weet ik nog niet/ });
  await expect(dlg.locator('tbody tr')).toHaveCount(1);
  await expect(dlg).toContainText(/SHELL/i);
  await dlg.getByRole('button', { name: 'Opnieuw indelen' }).click();

  // op de betaling: ongedaan maken en meteen kiezen, zonder terug naar de lijst
  await page.getByRole('button', { name: 'Ongedaan maken' }).click();
  await expect(page.getByRole('heading', { name: 'Was dit zakelijk?' })).toBeVisible();
  await page.locator('.chips button', { hasText: 'Materiaal' }).first().click();
  await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
  await expect(page.getByText('Verwerkt ✓')).toBeVisible();

  await nav(page, 'Belasting');
  await expect(page.locator('ul.checks li', { hasText: 'weet ik nog niet' })).toHaveCount(0);
});
