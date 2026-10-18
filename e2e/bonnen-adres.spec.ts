import { test, expect, onboard, nav } from './fixtures';
import type { Page } from '@playwright/test';

/** Bonnen-adres op post.boekhoudenvoorniks.nl (#450): aanvragen tot actief, tegen een nagebootste licentieserver. */
const server = async (page: Page, status?: string) => {
  const r = await page.request.post('/__bonnen', status ? { data: { status } } : {});
  return (await r.json()).ok as { op: string; body?: Record<string, string>; token?: string | null }[];
};

async function openEmail(page: Page) {
  await nav(page, 'Instellingen');
  await page.locator('main .chips').first().getByRole('button', { name: 'E-mail' }).click();
  return page.locator('.card', { has: page.getByRole('heading', { name: 'Bonnen-adres (gratis)' }) });
}

test('aanvragen, bevestigen, goedkeuren en stoppen', async ({ page }) => {
  await onboard(page);
  const card = await openEmail(page);
  await card.getByRole('button', { name: 'Bonnen-adres aanvragen' }).click();
  // bedrijfsgegevens staan al ingevuld; zonder akkoord kan het niet
  await expect(card.getByLabel('Jouw e-mailadres')).toHaveValue('piet@example.nl');
  await expect(card.getByText('Wij kijken er niet in.', { exact: false })).toBeVisible();
  const submit = card.getByRole('button', { name: 'Bonnen-adres aanvragen' });
  await expect(submit).toBeDisabled();
  await card.getByLabel('Ik ga hiermee akkoord').check();
  await submit.click();

  await expect(card.getByText('We stuurden een link naar')).toBeVisible();
  await expect(card.getByText('p***@example.nl')).toBeVisible();
  const calls = await server(page);
  expect(calls[0]).toMatchObject({ op: 'aanmelden', token: null, body: { email: 'piet@example.nl', bedrijfsnaam: 'Stukadoorsbedrijf Piet' } });

  await server(page, 'wacht');
  await card.getByRole('button', { name: 'Ik heb bevestigd' }).click();
  await expect(card.getByText('We bekijken je aanvraag')).toBeVisible();

  await server(page, 'actief');
  await card.getByRole('button', { name: 'Opnieuw kijken' }).click();
  await expect(card.getByLabel('Je bonnen-adres')).toHaveValue('bakkerijpi-k7m2q@post.boekhoudenvoorniks.nl');

  page.once('dialog', (d) => void d.accept());
  await card.getByRole('button', { name: 'Stoppen' }).click();
  await expect(card.getByText('Het bonnen-adres is gestopt')).toBeVisible();
  expect((await server(page)).some((c) => c.op === 'stoppen')).toBe(true);
});

test('zonder sleutelhanger een uitleg in plaats van het formulier', async ({ page }) => {
  await onboard(page);
  await page.request.post('/__securestorage', { data: { on: false } });
  const card = await openEmail(page);
  await expect(card).toBeVisible();
  await expect(card.getByText('geen sleutelhanger gevonden')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Bonnen-adres aanvragen' })).toHaveCount(0);
});
