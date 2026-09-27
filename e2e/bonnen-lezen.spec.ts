import { test, expect, onboard, nav, call } from './fixtures';

// een heel kleine (1x1) PNG: een "foto" die de app zonder herkenning niet kan lezen
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('eerste foto van een bon: kiezen hoe de app bonnen leest, met uitleg', async ({ page }) => {
  await onboard(page);
  await nav(page, 'Aankopen & bonnetjes');
  await page.locator('main input[type=file]').first().setInputFiles({ name: 'bon.png', mimeType: 'image/png', buffer: PNG });
  await page.getByRole('button', { name: 'Bekijken' }).first().click();

  await expect(page.getByRole('heading', { name: 'Zal de app je bonnen voortaan zelf lezen?' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Op deze computer/ })).toBeEnabled();
  // nog niet gezocht: uit, met uitleg; de app zoekt pas na de knop
  await expect(page.getByRole('button', { name: /Met je eigen Claude Code \(Anthropic\)/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Met je eigen Codex \(OpenAI\)/ })).toContainText('Nog niet gezocht');

  await page.getByRole('button', { name: 'Zoek op deze computer', exact: true }).click();
  await expect(page.getByText('/opt/claude/bin/claude')).toBeVisible();
  await expect(page.getByRole('button', { name: /Met je eigen Claude Code \(Anthropic\)/ })).toBeEnabled();
  await expect(page.getByRole('button', { name: /Met je eigen Codex \(OpenAI\)/ })).toContainText('Niet gevonden op deze computer');
  await page.getByRole('button', { name: 'Controleer', exact: true }).click();
  await expect(page.getByText('Claude Code werkt ✓').last()).toBeVisible();

  await page.getByRole('button', { name: /Nee, ik vul bonnen zelf in/ }).click();
  await expect(page.getByRole('heading', { name: 'Zal de app je bonnen voortaan zelf lezen?' })).toBeHidden();
  const settings = await call<{ ocr: { askedReader: boolean; engine: string; url: string; claudeCodePath: string } }>(page, 'settings.get');
  expect(settings.ocr.askedReader).toBe(true);
  // zelf invullen = elke manier van lezen uit; het gevonden programma blijft onthouden
  expect(settings.ocr.engine).toBe('uit');
  expect(settings.ocr.url).toBe('');
  expect(settings.ocr.claudeCodePath).toBe('/opt/claude/bin/claude');

  // in Instellingen staat de keuze, en is hij te wijzigen
  await nav(page, 'Instellingen');
  await page.getByRole('button', { name: 'Automatisch & herkenning' }).click();
  await expect(page.getByRole('button', { name: /Uit: ik vul bonnen zelf in/ })).toHaveClass(/selected/);
});

test('vragen stellen via Claude Code of Codex: eerst zoeken, dan uitleg en de opdracht', async ({ page }) => {
  await onboard(page);
  await nav(page, 'Instellingen');
  await page.getByRole('button', { name: 'Automatisch & herkenning' }).click();
  await expect(page.getByRole('heading', { name: /Vragen stellen over je boekhouding/ })).toBeVisible();
  await expect(page.getByText(/De assistent kan alleen lezen/)).toBeVisible();
  await expect(page.getByText(/Nog niet gevonden: gebruik hierboven/)).toBeVisible();
  await expect(page.getByText('claude mcp add --scope user gratis-boekhouden -- "/opt/Gratis Boekhouden/gratis-boekhouden" --mcp')).toBeVisible();
  await page.getByRole('button', { name: 'Zoek op deze computer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Toevoegen aan Claude Code' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Toevoegen aan Codex' })).toHaveCount(0);
});
