import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { nav, onboard, test } from './fixtures';

/**
 * Instellingen > Administraties > Waar je gegevens staan (#185). De beoordeling van de gekozen map is
 * de echte (planSwitch, op echte mappen); het keuzevenster en de herstart zijn nagebootst (server.cjs).
 * Het kopiëren en wisselen zelf wordt getest in tests/data-dir-wissel.test.ts.
 */
type Folder = { name: string; kind: 'leeg' | 'vol' | 'compleet' };

async function folderState(request: APIRequestContext, data: { pick?: Folder | null; custom?: boolean; oldStandard?: boolean } = {}) {
  return ((await (await request.post('/__datafolder', { data })).json()) as { ok: { applied: { target: string; action: string } | null; root: string } }).ok;
}

async function openCard(page: Page) {
  await onboard(page);
  await nav(page, 'Instellingen');
  await page.getByRole('button', { name: 'Administraties' }).click();
  await expect(page.getByRole('heading', { name: 'Waar je gegevens staan' })).toBeVisible();
}

test('een lege map kiezen: uitleg wat er gebeurt, en na bevestigen start de app opnieuw', async ({ page, request }) => {
  const { root } = await folderState(request, { pick: { name: 'Boekhouding', kind: 'leeg' } });
  await openCard(page);
  // de standaardmap: geen knop om terug te gaan
  await expect(page.getByText('(de standaardmap)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Terug naar de standaardmap' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Gegevensmap wijzigen…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Gegevensmap wijzigen' });
  await expect(dialog.getByText(`${root}/Boekhouding`)).toBeVisible();
  await expect(dialog.getByText(/kopieert je administraties, bijlagen en back-ups naar deze map/)).toBeVisible();
  await expect(dialog.getByText(/blijft staan; er wordt niets gewist/)).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  // tot de bevestiging is er niets vastgelegd
  expect((await folderState(request)).applied).toBeNull();

  await dialog.getByRole('button', { name: 'Kopiëren en opnieuw starten' }).click();
  await expect(dialog.getByText('De app start opnieuw…')).toBeVisible();
  expect((await folderState(request)).applied).toEqual({ target: `${root}/Boekhouding`, action: 'kopieren' });
});

test('annuleren, in het keuzevenster of in de uitleg, verandert niets', async ({ page, request }) => {
  await folderState(request, { pick: null });
  await openCard(page);
  await page.getByRole('button', { name: 'Gegevensmap wijzigen…' }).click();
  await expect(page.getByRole('dialog', { name: 'Gegevensmap wijzigen' })).toHaveCount(0);

  await folderState(request, { pick: { name: 'Boekhouding', kind: 'leeg' } });
  await page.getByRole('button', { name: 'Gegevensmap wijzigen…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Gegevensmap wijzigen' });
  await dialog.getByRole('button', { name: 'Annuleren' }).click();
  await expect(dialog).toHaveCount(0);
  expect((await folderState(request)).applied).toBeNull();
});

test('een map met andere bestanden: een duidelijke melding en geen knop om door te gaan', async ({ page, request }) => {
  await folderState(request, { pick: { name: 'Fotos', kind: 'vol' } });
  await openCard(page);
  await page.getByRole('button', { name: 'Gegevensmap wijzigen…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Gegevensmap wijzigen' });
  await expect(dialog.getByRole('alert')).toContainText('staan al andere bestanden. Kies een lege map');
  await expect(dialog.getByText(/Er is niets veranderd: je werkt verder vanuit/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Kopiëren|openen/ })).toHaveCount(0);

  // meteen een andere map kiezen kan wel
  await folderState(request, { pick: { name: 'Boekhouding', kind: 'leeg' } });
  await dialog.getByRole('button', { name: 'Andere map kiezen…' }).click();
  await expect(dialog.getByRole('button', { name: 'Kopiëren en opnieuw starten' })).toBeEnabled();
  expect((await folderState(request)).applied).toBeNull();
});

test('een map van OneDrive: waarschuwing, en pas verder na een bewuste keuze', async ({ page, request }) => {
  const { root } = await folderState(request, { pick: { name: 'OneDrive/Boekhouding', kind: 'leeg' } });
  await openCard(page);
  await page.getByRole('button', { name: 'Gegevensmap wijzigen…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Gegevensmap wijzigen' });
  await expect(dialog.getByRole('alert')).toContainText('deze map wordt bijgehouden door OneDrive');
  const go = dialog.getByRole('button', { name: 'Kopiëren en opnieuw starten' });
  await expect(go).toBeDisabled();
  await dialog.getByLabel('Ik ken het risico en wil deze map toch gebruiken').check();
  await go.click();
  await expect(dialog.getByText('De app start opnieuw…')).toBeVisible();
  expect((await folderState(request)).applied).toEqual({ target: `${root}/OneDrive/Boekhouding`, action: 'kopieren' });
});

test('een map waarin al een administratie staat: die wordt geopend, de huidige gegevens gaan niet mee', async ({ page, request }) => {
  const { root } = await folderState(request, { pick: { name: 'Oude-administratie', kind: 'compleet' } });
  await openCard(page);
  await page.getByRole('button', { name: 'Gegevensmap wijzigen…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Gegevensmap wijzigen' });
  await expect(dialog.getByText(/In deze map staat al een administratie \(laatst gewijzigd .* · 1 administratie\)/)).toBeVisible();
  await expect(dialog.getByText('Je huidige gegevens gaan niet mee.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Deze administratie openen' }).click();
  await expect(dialog.getByText('De app start opnieuw…')).toBeVisible();
  expect((await folderState(request)).applied).toEqual({ target: `${root}/Oude-administratie`, action: 'openen' });
});

test('terug naar de standaardmap: de huidige gegevens gaan mee, wat er nog stond wordt bewaard', async ({ page, request }) => {
  const { root } = await folderState(request, { custom: true, oldStandard: true });
  await openCard(page);
  await expect(page.getByText('(de standaardmap)')).toHaveCount(0);
  await expect(page.getByText(/Dit is niet de standaardmap; die is/)).toBeVisible();
  await expect(page.getByText(/Laat die map staan: de app bewaart daar de sleutel van je opgeslagen wachtwoorden/)).toBeVisible();

  await page.getByRole('button', { name: 'Terug naar de standaardmap' }).click();
  const dialog = page.getByRole('dialog', { name: 'Gegevensmap wijzigen' });
  await expect(dialog.getByText(`${root}/home/BoekhoudenVoorNiks`)).toBeVisible();
  await expect(dialog.getByText(/In de standaardmap staat nog een oudere administratie .* Die wordt niet gewist/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Kopiëren en opnieuw starten' }).click();
  await expect(dialog.getByText('De app start opnieuw…')).toBeVisible();
  expect((await folderState(request)).applied).toEqual({ target: `${root}/home/BoekhoudenVoorNiks`, action: 'kopieren' });
});
