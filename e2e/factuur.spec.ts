import { test, expect, onboard, nav, call, field } from './fixtures';

test('klant aanmaken, factuur maken, versturen, betaald melden; komt in de btw', async ({ page, request }) => {
  await onboard(page);
  // e-mail instellen (de testserver verstuurt niets echt, maar houdt bij wat er "verstuurd" is)
  await call(page, 'settings.update', { smtp: { host: 'smtp.example.nl', port: 587, secure: false, user: '', fromName: 'Piet', fromEmail: 'piet@example.nl', bcc: '', replyTo: '' } });
  await page.reload();

  await nav(page, 'Werk & facturen');
  await page.getByRole('button', { name: '+ Nieuwe factuur' }).click();
  await page.getByRole('button', { name: '+ Nieuw' }).click();
  const dlg = page.getByRole('dialog', { name: 'Nieuwe klant' });
  await dlg.locator('label.field', { hasText: 'Naam' }).locator('input').fill('Familie Jansen');
  await dlg.getByPlaceholder('Straat en huisnummer').fill('Dorpsstraat 5');
  await dlg.locator('label.field', { hasText: 'Postcode' }).locator('input').fill('3511 AA');
  await dlg.locator('label.field', { hasText: 'Plaats' }).locator('input').fill('Utrecht');
  await dlg.locator('label.field', { hasText: 'E-mail' }).locator('input').fill('jansen@example.nl');
  await dlg.getByRole('button', { name: 'Toevoegen' }).click();
  await expect(dlg).toBeHidden();

  await field(page, 'Omschrijving / klus').fill('Woonkamer stucen');
  await page.getByPlaceholder('bv. Stucwerk wanden').first().fill('Stucwerk wanden');
  const row = page.locator('.lines-table tbody tr').first();
  await row.locator('input.num').first().fill('20');
  await row.locator('input.num').nth(1).fill('25,00');
  await expect(row.locator('td.num')).toContainText('500,00');
  await page.getByRole('button', { name: 'Versturen' }).click();
  const send = page.getByRole('dialog', { name: 'Factuur versturen' });
  await expect(send.locator('input[type=email]')).toHaveValue('jansen@example.nl');
  await send.getByRole('button', { name: 'Versturen' }).click();
  await expect(page.getByText('Verstuurd ✓')).toBeVisible();
  const sent = (await (await request.post('/__sent')).json()).ok as { to: string; subject: string }[];
  expect(sent).toHaveLength(1);
  expect(sent[0]!.to).toBe('jansen@example.nl');

  // de factuur staat in de btw: 20 × € 25 = € 500 omzet, € 105 btw
  await nav(page, 'Belasting');
  await page.locator('table.sumtable tr', { hasText: 'Omzet' }).click();
  const details = page.getByRole('dialog', { name: 'Omzet' });
  await expect(details).toContainText('Familie Jansen');
  await expect(details).toContainText('factuur');
  await expect(details.locator('tfoot')).toContainText('500,00');
  await details.getByRole('button', { name: 'Bekijken' }).click();
  await expect(page.getByRole('heading', { name: /Factuur/ })).toBeVisible();

  // betaling ontvangen (contant)
  await page.getByRole('button', { name: 'Betaling ontvangen' }).click();
  const pay = page.getByRole('dialog', { name: 'Betaling ontvangen' });
  await pay.getByRole('button', { name: 'Opslaan' }).click();
  await expect(pay).toBeHidden();
  await expect(page.locator('.pill', { hasText: /betaald/i }).first()).toBeVisible();
});

test('lege factuur: duidelijke melding, niets kapot', async ({ page, problems }) => {
  await onboard(page);
  await nav(page, 'Werk & facturen');
  await page.getByRole('button', { name: '+ Nieuwe factuur' }).click();
  // zonder klant: meteen een begrijpelijke melding, geen crash
  await page.getByRole('button', { name: 'Versturen' }).click();
  await expect(page.locator('.toast.error')).toContainText('Kies eerst een klant');
  expect(problems.pageErrors).toEqual([]);
});
