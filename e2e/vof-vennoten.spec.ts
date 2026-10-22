import { test, expect, onboard, nav, call } from './fixtures';

/** Vof met vennoten: een privéboeking buiten de bank vraagt van welke vennoot, en komt op diens privérekening. */
test('vof met vennoten: een rit vraagt wie reed en komt op de privé-stortingen van die vennoot', async ({ page, problems }) => {
  await onboard(page);
  await call(page, 'settings.update', { legalForm: 'vof', taxCheckAcknowledgedYear: new Date().getFullYear() });
  await call(page, 'settings.update', { partners: [{ no: 1, name: 'Anna', sharePct: 60 }, { no: 2, name: 'Bram', sharePct: 40 }], partnerAllocationFromYear: 2026 });
  await page.reload();
  await nav(page, 'Belasting');
  await page.getByRole('button', { name: 'Aftrek, investeringen en kilometers' }).click();
  await page.getByRole('button', { name: 'Kilometers', exact: true }).click();

  const form = page.locator('.card', { hasText: 'Waarheen / waarvoor' });
  await form.locator('label.field', { hasText: 'Kilometers' }).locator('input').fill('100');
  await form.getByPlaceholder(/klant Jansen/).fill('Klant Utrecht');
  // zonder vennoot kan het niet: de app weet niet van wie de vergoeding is
  await expect(form.getByRole('button', { name: 'Toevoegen' })).toBeDisabled();
  await form.getByTestId('vennoot-select').selectOption({ label: 'Bram' });
  await form.getByRole('button', { name: 'Toevoegen' }).click();
  await expect(page.getByText('Rit toegevoegd')).toBeVisible();

  const balances = await call<{ rgs_code: string; balance: number }[]>(page, 'ledger.balances');
  const of = (rgs: string) => balances.find((b) => b.rgs_code === rgs)?.balance ?? 0;
  expect(of('BEivKa2PrsOps')).toBeLessThan(0);
  expect(of('BEivPriStr')).toBe(0);
  expect(problems.apiErrors).toEqual([]);
});
