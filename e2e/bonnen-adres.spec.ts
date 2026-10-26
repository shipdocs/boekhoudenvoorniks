import { test, expect, onboard, nav } from './fixtures';
import type { Page } from '@playwright/test';

/** Bonnen-adres op post.boekhoudenvoorniks.nl (#450): aanvragen tot actief, tegen een nagebootste licentieserver. */
const server = async (page: Page, opts?: string | { weiger: boolean } | { andereComputer: boolean } | { geenAdres: boolean }) => {
  const data = typeof opts === 'string' ? { status: opts } : opts;
  const r = await page.request.post('/__bonnen', data ? { data } : {});
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
  await expect(card.getByLabel('Voornaam')).toHaveValue('Piet');
  await expect(card.getByLabel('KvK-nummer')).toHaveValue('12345678');
  const submit = card.getByRole('button', { name: 'Bonnen-adres aanvragen' });
  await expect(submit).toBeDisabled();
  await card.getByLabel('Ik heb dit gelezen en ga akkoord met deze afspraken voor het bonnen-adres').check();
  // achternaam is nog leeg; telefoon mag leeg blijven
  await expect(submit).toBeDisabled();
  await expect(card.getByLabel('Telefoon (mag leeg)')).toHaveValue('');
  await card.getByLabel('Achternaam').fill('Jansen');
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect(card.getByText('We stuurden een link naar')).toBeVisible();
  await expect(card.getByText('p***@example.nl')).toBeVisible();
  const calls = await server(page);
  expect(calls[0]).toMatchObject({ op: 'aanmelden', token: null, body: { email: 'piet@example.nl', bedrijfsnaam: 'Stukadoorsbedrijf Piet', kvk: '12345678', voornaam: 'Piet', achternaam: 'Jansen', telefoon: '' } });

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

test('een weigering van de server (app bijwerken) komt als melding in beeld', async ({ page }) => {
  await onboard(page);
  const card = await openEmail(page);
  await card.getByRole('button', { name: 'Bonnen-adres aanvragen' }).click();
  await card.getByLabel('Achternaam').fill('Jansen');
  await card.getByLabel('Telefoon (mag leeg)').fill('0612345678');
  await card.getByLabel('Ik heb dit gelezen en ga akkoord met deze afspraken voor het bonnen-adres').check();
  await server(page, { weiger: true });
  await card.getByRole('button', { name: 'Bonnen-adres aanvragen' }).click();
  await expect(page.getByText('Werk de app bij naar de nieuwste versie', { exact: false })).toBeVisible();
  await expect(card.getByText('We stuurden een link naar')).toHaveCount(0);
});

test('een back-up van een andere computer: hier gebruiken en overnemen zonder KvK, namen en telefoon', async ({ page }) => {
  await onboard(page);
  let card = await openEmail(page);
  await card.getByRole('button', { name: 'Bonnen-adres aanvragen' }).click();
  await card.getByLabel('Achternaam').fill('Jansen');
  await card.getByLabel('Telefoon (mag leeg)').fill('06 1234-5678');
  await card.getByLabel('Ik heb dit gelezen en ga akkoord met deze afspraken voor het bonnen-adres').check();
  await card.getByRole('button', { name: 'Bonnen-adres aanvragen' }).click();
  await expect(card.getByText('We stuurden een link naar')).toBeVisible();

  // de machtiging is hier niet te lezen, zoals na het terugzetten van een back-up
  await server(page, { andereComputer: true });
  await page.reload();
  card = await openEmail(page);
  await expect(card.getByText('hoort bij een andere computer')).toBeVisible();
  await card.getByRole('button', { name: 'Hier gebruiken' }).click();
  const submit = card.getByRole('button', { name: 'Bonnen-adres aanvragen' });
  // overnemen vraagt alleen e-mailadres en bedrijfsnaam, plus akkoord
  await expect(card.getByLabel('Jouw e-mailadres')).toBeVisible();
  await expect(card.getByLabel('Bedrijfsnaam')).toBeVisible();
  for (const label of ['KvK-nummer', 'Voornaam', 'Achternaam', 'Telefoon (mag leeg)']) await expect(card.getByLabel(label)).toHaveCount(0);
  await expect(submit).toBeDisabled();
  await card.getByLabel('Ik heb dit gelezen en ga akkoord met deze afspraken voor het bonnen-adres').check();
  await submit.click();

  await expect(card.getByText('Na bevestigen werkt het op deze computer')).toBeVisible();
  const aanmeldingen = (await server(page)).filter((c) => c.op === 'aanmelden');
  expect(aanmeldingen).toHaveLength(2);
  expect(aanmeldingen[1]).toMatchObject({ token: null, body: { email: 'piet@example.nl', bedrijfsnaam: 'Stukadoorsbedrijf Piet', overnemen: true } });
  for (const key of ['kvk', 'voornaam', 'achternaam', 'telefoon']) expect(aanmeldingen[1]!.body).not.toHaveProperty(key);
});

test('overnemen terwijl het adres niet meer bestaat: melding, dan het volledige formulier en opnieuw aanvragen', async ({ page }) => {
  await onboard(page);
  let card = await openEmail(page);
  await card.getByRole('button', { name: 'Bonnen-adres aanvragen' }).click();
  await card.getByLabel('Achternaam').fill('Jansen');
  await card.getByLabel('Ik heb dit gelezen en ga akkoord met deze afspraken voor het bonnen-adres').check();
  await card.getByRole('button', { name: 'Bonnen-adres aanvragen' }).click();
  await expect(card.getByText('We stuurden een link naar')).toBeVisible();

  await server(page, { andereComputer: true });
  await server(page, { geenAdres: true });
  await page.reload();
  card = await openEmail(page);
  await card.getByRole('button', { name: 'Hier gebruiken' }).click();
  await card.getByLabel('Ik heb dit gelezen en ga akkoord met deze afspraken voor het bonnen-adres').check();
  await card.getByRole('button', { name: 'Bonnen-adres aanvragen' }).click();

  await expect(page.getByText('Dit bonnen-adres bestaat niet meer. Vraag een nieuw bonnen-adres aan.', { exact: true })).toBeVisible();
  // de lokale stand is vergeten: het volledige formulier is terug
  for (const label of ['KvK-nummer', 'Voornaam', 'Achternaam', 'Telefoon (mag leeg)']) await expect(card.getByLabel(label)).toBeVisible();

  // een nieuwe aanvraag gaat zonder overnemen en met de velden naar de server
  await card.getByLabel('Achternaam').fill('Jansen');
  await card.getByLabel('Telefoon (mag leeg)').fill('06 1234-5678');
  await card.getByLabel('Ik heb dit gelezen en ga akkoord met deze afspraken voor het bonnen-adres').check();
  await card.getByRole('button', { name: 'Bonnen-adres aanvragen' }).click();
  // het onbevestigd-scherm, niet het overnemen-scherm (dat heeft geen "Ander e-mailadres")
  await expect(card.getByText('We stuurden een link naar')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Ik heb bevestigd' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Ander e-mailadres' })).toBeVisible();
  const aanmeldingen = (await server(page)).filter((c) => c.op === 'aanmelden');
  expect(aanmeldingen).toHaveLength(3);
  expect(aanmeldingen[1]!.body).toHaveProperty('overnemen', true);
  expect(aanmeldingen[2]).toMatchObject({ token: null, body: { kvk: '12345678', voornaam: 'Piet', achternaam: 'Jansen', telefoon: '0612345678' } });
  expect(aanmeldingen[2]!.body).not.toHaveProperty('overnemen');
});

test('zonder sleutelhanger een uitleg in plaats van het formulier', async ({ page }) => {
  await onboard(page);
  await page.request.post('/__securestorage', { data: { on: false } });
  const card = await openEmail(page);
  await expect(card).toBeVisible();
  await expect(card.getByText('geen sleutelhanger gevonden')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Bonnen-adres aanvragen' })).toHaveCount(0);
});
