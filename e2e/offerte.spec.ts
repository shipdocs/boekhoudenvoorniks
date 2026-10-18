import { test, expect, onboard, nav, call } from './fixtures';

test('offerte maken, klant akkoord: er staat een klus klaar', async ({ page }) => {
  await onboard(page);
  await call(page, 'relations.create', { name: 'Bakker BV', email: 'info@bakker.example', address: 'Markt 1', postcode: '1000 AA', city: 'Amsterdam' });
  await nav(page, 'Werk & facturen');
  await page.getByRole('button', { name: '+ Nieuwe offerte' }).click();
  await expect(page.getByText('Een offerte is een prijsvoorstel')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Wat ga je doen?' })).toBeVisible();
  await page.locator('label.field', { hasText: 'Klant' }).locator('select').selectOption({ label: 'Bakker BV' });
  const row = page.locator('.lines-table tbody tr').first();
  await row.locator('input').first().fill('Plafond stucen');
  await row.locator('input.num').nth(1).fill('750');
  await page.getByRole('button', { name: 'Opslaan' }).click();
  await expect(page.getByRole('button', { name: 'Klant is akkoord' })).toBeVisible();
  await page.getByRole('button', { name: 'Klant is akkoord' }).click();
  // akkoord: er staat een klus klaar; daar maak je later de factuur
  await expect(page.getByText('Klant is akkoord — er staat een klus klaar')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Plafond|Bakker/);
});
