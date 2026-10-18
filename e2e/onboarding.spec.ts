import { test, expect, onboard, startDemo, nav } from './fixtures';

test('nieuwe gebruiker: onboarding van begin tot Vandaag', async ({ page, problems }) => {
  await onboard(page);
  await expect(page.getByRole('heading', { name: /Piet/ })).toBeVisible();
  expect(problems.apiErrors).toEqual([]);
});

test('demo bekijken en daarna wissen: terug naar het welkomstscherm', async ({ page }) => {
  await startDemo(page);
  await nav(page, 'Vandaag');
  await expect(page.getByText(/dingen en je bent klaar|Je bent bij/)).toBeVisible();
  await page.getByRole('button', { name: 'Wis demo en begin echt' }).click();
  const confirm = page.locator('.modal');
  if (await confirm.isVisible().catch(() => false)) await confirm.getByRole('button').last().click();
  await expect(page.getByRole('heading', { name: 'Welkom 👋' })).toBeVisible();
});

test('welkomstscherm: al een administratie? back-up terugzetten, met wachtwoord voor een versleutelde', async ({ page, request }) => {
  await page.goto('/');
  const card = page.getByTestId('backup-terugzetten');
  await expect(card.getByText('Heb je al een administratie?')).toBeVisible();
  await card.getByLabel('Wachtwoord van de back-up').fill('lange zin als wachtwoord');
  await card.getByRole('button', { name: 'Back-up terugzetten…' }).click();
  // het keuzevenster (in de test geannuleerd) kreeg het wachtwoord mee
  await expect.poll(async () => (await (await request.post('/__restore')).json()).ok).toEqual(['lange zin als wachtwoord']);
  await expect(page.getByRole('heading', { name: 'Welkom 👋' })).toBeVisible();
});
