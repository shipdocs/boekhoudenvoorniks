import { test, expect, onboard, nav, call } from './fixtures';

// De versie uit de Microsoft Store (#181); de testserver bootst hem na met POST /__store.

test('Store-versie: updates komen via de Store, geen schakelaar en geen "Zoek naar updates"', async ({ page, request }) => {
  await onboard(page);
  await request.post('/__store', { data: { on: true } });
  await nav(page, 'Instellingen');
  await page.locator('main .chips').first().getByRole('button', { name: /Back-up/ }).click();
  await expect(page.getByText('Je hebt de versie uit de Microsoft Store. Nieuwe versies komen vanzelf via de Store')).toBeVisible();
  await expect(page.getByText(/^Versie /)).toBeVisible();
  await expect(page.getByLabel('Automatisch bijwerken (aanbevolen)')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Zoek naar updates' })).toHaveCount(0);
});

test('Store-versie: bonnen lezen op deze computer pas na een uitdrukkelijk ja', async ({ page, request }) => {
  await onboard(page);
  await request.post('/__store', { data: { on: true } });
  await nav(page, 'Instellingen');
  await page.getByRole('button', { name: 'Automatisch & herkenning' }).click();
  const local = page.getByRole('button', { name: /Op deze computer/ });
  await expect(local).not.toHaveClass(/selected/);

  // eerst de uitleg: welk programma, welke versie; annuleren verandert niets
  await local.click();
  const dlg = page.getByRole('dialog', { name: 'Bonnen lezen op deze computer' });
  await expect(dlg).toContainText('llama-server');
  await expect(dlg).toContainText('versie b0000');
  await expect(dlg).toContainText('GLM-OCR');
  await dlg.getByRole('button', { name: 'Annuleren' }).click();
  await expect(dlg).toBeHidden();
  let store = (await (await request.post('/__store', { data: '' })).json()).ok;
  expect(store).toMatchObject({ consent: false, installs: 0 });
  expect((await call<{ ocr: { engine: string } }>(page, 'settings.get')).ocr.engine).not.toBe('ingebouwd');

  await local.click();
  await dlg.getByRole('button', { name: 'Ja, downloaden en gebruiken' }).click();
  await expect(dlg).toBeHidden();
  await expect(local).toHaveClass(/selected/);
  store = (await (await request.post('/__store', { data: '' })).json()).ok;
  expect(store).toMatchObject({ consent: true, installs: 1 });
  expect((await call<{ ocr: { engine: string } }>(page, 'settings.get')).ocr.engine).toBe('ingebouwd');
});

test('Store-versie: bij de koppeling staat waar de gewone Windows-versie te vinden is', async ({ page, request }) => {
  await onboard(page);
  await request.post('/__store', { data: { on: true } });
  await nav(page, 'Instellingen');
  await page.getByRole('button', { name: 'Automatisch & herkenning' }).click();
  await expect(page.getByRole('heading', { name: /Vragen stellen over je boekhouding/ })).toBeVisible();
  await expect(page.getByText(/Lukt de koppeling niet in de versie uit de Microsoft Store\? Download dan de gewone Windows-versie op https:\/\/github\.com\/shipdocs\/boekhoudenvoorniks\/releases\/latest/)).toBeVisible();
});

test('Store-versie, overzetten mislukt: melding dat je alleen kunt bekijken, met "Opnieuw proberen"', async ({ page, request }) => {
  await onboard(page);
  await request.post('/__store', { data: { on: true, readOnly: true } });
  await page.reload();
  const banner = page.getByRole('status').filter({ hasText: 'Je kunt je administratie nu alleen bekijken' });
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Opnieuw proberen' }).click();
  await expect.poll(async () => (await (await request.post('/__store', { data: '' })).json()).ok.retried).toBe(true);
});

test('gewone versie: geen Store-meldingen, lokaal lezen zonder extra vraag', async ({ page, request }) => {
  await onboard(page);
  await expect(page.getByText('Je kunt je administratie nu alleen bekijken')).toHaveCount(0);
  await nav(page, 'Instellingen');
  await page.getByRole('button', { name: 'Automatisch & herkenning' }).click();
  await expect(page.getByText(/versie uit de Microsoft Store/)).toHaveCount(0);
  const local = page.getByRole('button', { name: /Op deze computer/ });
  await local.click();
  await expect(page.getByRole('dialog', { name: 'Bonnen lezen op deze computer' })).toHaveCount(0);
  await expect(local).toHaveClass(/selected/);
  expect((await (await request.post('/__store', { data: '' })).json()).ok).toMatchObject({ on: false, installs: 1 });
});
