import { test, expect, onboard, nav, field, call } from './fixtures';

test('IB: ondernemer, 1.225 uur en starteruitzondering zijn afzonderlijke keuzes', async ({ page }) => {
  await onboard(page);
  await nav(page, 'Instellingen');
  const tabs = page.locator('main .chips').first();
  await tabs.getByRole('button', { name: 'Btw', exact: true }).click();
  const ondernemer = page.getByLabel('Ik ben ondernemer voor de inkomstenbelasting', { exact: false });
  const uren = page.getByLabel('Ik werk minstens 1.225 uur in dit kalenderjaar', { exact: false });
  await expect(ondernemer).not.toBeChecked();
  await expect(uren).not.toBeChecked();
  await ondernemer.check();
  await expect(uren).not.toBeChecked();
  await uren.check();
  await field(page, 'Welke situatie past bij jouw werktijd?').selectOption('starter');
  await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
  expect(await call(page, 'settings.get')).toMatchObject({ ibConfirmed: true, urencriterium: true, ibHoursCondition: 'starter' });
  await page.reload();
  await nav(page, 'Instellingen');
  await tabs.getByRole('button', { name: 'Btw', exact: true }).click();
  await expect(field(page, 'Welke situatie past bij jouw werktijd?')).toHaveValue('starter');
});

test('Stripe: de btw op kosten staat standaard op uitzoeken en is eenvoudig te bevestigen', async ({ page }) => {
  await onboard(page);
  await nav(page, 'Instellingen');
  await page.locator('main .chips').first().getByRole('button', { name: 'Koppelingen', exact: true }).click();
  const stripe = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Stripe', exact: true }) });
  await expect(field(page, 'Welke btw geldt voor je Stripe-kosten?')).toHaveValue('onbekend');
  await stripe.locator('input[type=password]').fill('test');
  await field(page, 'Welke btw geldt voor je Stripe-kosten?').selectOption('vrijgesteld');
  await stripe.getByRole('button', { name: 'Koppelen', exact: true }).click();
  const integrations = await call<{ definition: { id: string }; enabled: boolean; config: Record<string, string> }[]>(page, 'integrations.list');
  expect(integrations.find((i) => i.definition.id === 'stripe')).toMatchObject({ enabled: true, config: { feesTax: 'vrijgesteld' } });
});
