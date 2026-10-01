import { test, expect, onboard, nav, call } from './fixtures';
import { makePdf } from '../tests/pdf';

// datums rond vandaag, zodat de test niet verloopt
const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000);
const nl = (d: Date) => `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
const ing = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

/** Factuur van het eigen bedrijf (de gegevens uit de onboarding in fixtures.ts): verkoper en koper naast elkaar. */
const factuur = (daysAgo: number) =>
  Buffer.from(makePdf([
    'KalkPlanner',
    'Factuur I-MOL-2026-00347',
    `Datum van uitgifte: ${nl(day(daysAgo))}`,
    'Stukadoorsbedrijf Piet Stukadoorsbedrijf Piet',
    'Kalkweg 1 Kalkweg 1',
    'Btw-nummer: NL123456782B01 Btw-nummer: NL123456782B01',
    'KvK: 12345678 KvK: 12345678',
    'Abonnement KalkPlanner 9,00',
    'BTW 21% 9,00 1,89',
    'Totaal 10,89',
  ]));
const afschrift = (daysAgo: number) =>
  [
    '"Datum";"Naam / Omschrijving";"Rekening";"Tegenrekening";"Code";"Af Bij";"Bedrag (EUR)";"Mutatiesoort";"Mededelingen"',
    `"${ing(day(daysAgo))}";"Stukadoorsbedrijf Piet";"NL91ABNA0417164300";"";"ID";"Af";"10,89";"iDEAL";"KalkPlanner abonnement"`,
  ].join('\n');

test('factuur van je eigen bedrijf: uitleg en alleen Privé of Weet ik nog niet; met de betaling één vraag voor allebei', async ({ page, problems }) => {
  await onboard(page);
  await nav(page, 'Aankopen & bonnetjes');
  await page.locator('main input[type=file]').first().setInputFiles({ name: 'factuur.pdf', mimeType: 'application/pdf', buffer: factuur(3) });
  await expect(page.locator('.task .q', { hasText: 'Dit is een factuur van je eigen bedrijf' })).toBeVisible();
  expect(await call<unknown[]>(page, 'purchases.list')).toHaveLength(0);

  // op het scherm van de bon: de uitleg, de twee keuzes, en geen gewone categorie- of btw-keuze
  await page.getByTestId('toegevoegd').getByRole('button', { name: 'Bekijken' }).click();
  const note = page.getByTestId('eigen-bedrijf');
  await expect(note.getByText('Dit is een factuur van je eigen bedrijf')).toBeVisible();
  await expect(note.getByText(/Dat is geen gewone aankoop: de app boekt hem niet als kosten en trekt de btw niet af/)).toBeVisible();
  await expect(note.getByText(/je eigen KvK-nummer staat erop/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Privé', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Weet ik nog niet: vraag mijn boekhouder', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Klopt, verwerken' })).toHaveCount(0);
  await expect(page.getByText('Was dit zakelijk?')).toHaveCount(0);
  await expect(page.getByText('Btw op de bon')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Toch een gewone aankoop' })).toBeVisible();

  // de betaling komt binnen: op Vandaag één vraag voor factuur en betaling samen
  await call(page, 'bank.importFile', 'afschrift.csv', afschrift(2));
  await nav(page, 'Vandaag');
  const show = page.getByRole('button', { name: /^Toon alle/ });
  if (await show.isVisible()) await show.click();
  const task = page.locator('.task', { hasText: 'Factuur van je eigen bedrijf: € 10,89' });
  await expect(task).toHaveCount(1);
  await expect(task.getByText(/de factuur en de betaling gaan samen mee/)).toBeVisible();
  await expect(task.getByRole('button', { name: 'Privé', exact: true })).toBeVisible();
  await expect(page.locator('.task', { hasText: 'KalkPlanner' })).toHaveCount(0);
  expect(await call<unknown[]>(page, 'purchases.list')).toHaveLength(0);

  await task.getByRole('button', { name: 'Weet ik nog niet: vraag mijn boekhouder' }).click();
  await expect(page.locator('.task', { hasText: 'Factuur van je eigen bedrijf' })).toHaveCount(0);
  const purchases = await call<{ total: number; vat_total: number; status: string; question: boolean }[]>(page, 'purchases.list');
  expect(purchases).toEqual([expect.objectContaining({ total: 1089, vat_total: 0, status: 'betaald', question: true })]);
  expect(await call<unknown[]>(page, 'bank.transactions', { status: 'nieuw' })).toHaveLength(0);
  expect(problems.apiErrors).toEqual([]);
});

test('betaling aan je eigen bedrijf komt eerst: de keuze bij de betaling; de factuur komt er later alleen als bewijs bij', async ({ page, problems }) => {
  await onboard(page);
  await call(page, 'bank.importFile', 'afschrift.csv', afschrift(2));
  const [payment] = await call<{ id: number }[]>(page, 'bank.transactions', { status: 'nieuw' });
  // Vandaag stond al open: even weg en terug, zodat de nieuwe betaling erop staat
  await nav(page, 'Bank');
  await nav(page, 'Vandaag');
  const show = page.getByRole('button', { name: /^Toon alle/ });
  if (await show.isVisible()) await show.click();
  const task = page.locator('.task', { hasText: 'betaald aan je eigen bedrijf' });
  await expect(task.getByText(/dat is je eigen bedrijf, geen eigen rekening/)).toBeVisible();
  await task.getByRole('button', { name: 'Bekijken' }).click();

  // op het scherm van de betaling staat dezelfde uitleg met dezelfde twee keuzes
  const note = page.getByTestId('eigen-bedrijf');
  await expect(note.getByText('Dit is een betaling aan je eigen bedrijf')).toBeVisible();
  await expect(note.getByText(/geen kosten en geen btw-aftrek/)).toBeVisible();
  await note.getByRole('button', { name: 'Privé', exact: true }).click();
  await expect(page.locator('.toasts').getByText('Verwerkt ✓')).toBeVisible();
  expect(await call<unknown[]>(page, 'bank.transactions', { status: 'nieuw' })).toHaveLength(0);

  // de factuur komt later: geen nieuwe boeking, alleen de vraag of hij als bewijs bij die betaling hoort
  await nav(page, 'Aankopen & bonnetjes');
  await page.locator('main input[type=file]').first().setInputFiles({ name: 'factuur.pdf', mimeType: 'application/pdf', buffer: factuur(3) });
  await page.getByTestId('toegevoegd').getByRole('button', { name: 'Bekijken' }).click();
  await expect(page.getByTestId('voorstel').getByText('Deze betaling is al geboekt. Wil je deze bon alleen als bewijsstuk koppelen?')).toBeVisible();
  await expect(page.getByText(/Dit is een factuur van je eigen bedrijf: verkoper en koper zijn hetzelfde/)).toBeVisible();
  await page.getByTestId('voorstel').getByRole('button', { name: 'Ja, alleen als bewijs' }).click();
  await expect(page.getByTestId('uitkomst')).toHaveText('Bewijs gekoppeld — niet opnieuw geboekt');
  expect(await call<unknown[]>(page, 'purchases.list')).toHaveLength(0);
  expect(await call<unknown[]>(page, 'documents.forTarget', 'bank', payment!.id)).toHaveLength(1);
  expect(problems.apiErrors).toEqual([]);
});
