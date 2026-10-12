import { expect, type Page } from '@playwright/test';
import { call, nav, onboard, test } from './fixtures';

/**
 * Het abonnement met licenties AAN, zoals na de release (e2e/server.cjs bootst de licentie-Worker na,
 * met een echte Ed25519-handtekening): zonder abonnement geweigerd, afsluiten, na betalen de licentie
 * ophalen, versturen, opzeggen (versturen kan dan nog t/m de betaalde periode). De tekst van het blok staat in
 * src/shared/subscription-text.ts: zolang telefoon koppelen uit staat (zoals in de app) noemt hij de telefoon niet;
 * de laatste test zet koppelen aan en leest de andere variant.
 */

async function savedPath(page: Page, re: RegExp): Promise<string> {
  const toast = page.locator('.toasts').getByText(re).last();
  await expect(toast).toBeVisible();
  return (await toast.textContent())!.match(re)![1]!;
}

/** Kantoor instellen en de klant (dezelfde "computer") koppelen, zoals in uitwisseling.spec.ts. */
async function linkToOffice(page: Page) {
  await nav(page, 'Instellingen');
  await page.getByRole('button', { name: 'Administraties' }).click();
  const kantoor = page.getByTestId('kantoor');
  await kantoor.locator('input').nth(0).fill('Kantoor De Vries');
  await kantoor.locator('input').nth(1).fill('info@kantoordevries.nl');
  await kantoor.getByRole('button', { name: 'Opslaan' }).click();
  await kantoor.getByRole('button', { name: 'Uitnodiging voor een klant maken' }).click();
  const invite = await savedPath(page, /Uitnodiging bewaard: (.+?)\. Stuur/);
  await nav(page, 'Hoe gaat het?');
  await page.getByTestId('uitwisseling').locator('input[type=file]').setInputFiles(invite);
  await page.getByRole('dialog', { name: 'Koppelen aan je boekhouder?' }).getByRole('button', { name: 'Koppelen' }).click();
  await expect(page.getByTestId('uitwisseling').getByText(/Gekoppeld aan/)).toBeVisible();
}

async function sendAsFile(page: Page) {
  const card = page.getByTestId('uitwisseling');
  await card.getByRole('button', { name: 'Als bestand bewaren' }).click();
  await page.getByRole('dialog', { name: /naar Kantoor De Vries/ }).getByRole('button', { name: 'Bewaren' }).click();
}

test('abonnement: zonder abonnement geweigerd, proefperiode afsluiten, licentie ophalen, versturen', async ({ page, request }) => {
  await request.post('/__reset', { data: { licenses: true } });
  await onboard(page);
  const until = (await call<string[]>(page, 'periods.suggestedDates'))[0]!;
  await call(page, 'purchases.recordExpense', { date: until, supplierName: 'Gamma', description: 'Materiaal', categoryKey: 'materiaal', grossAmount: 12100, vatCode: 'hoog', paidWith: 'prive' });
  await linkToOffice(page);

  const card = page.getByTestId('uitwisseling');
  const abonnement = card.getByTestId('abonnement');
  await expect(abonnement.getByText('Versturen naar je boekhouder is een extra functie van het abonnement.')).toBeVisible();
  await expect(abonnement).toContainText('Met het abonnement steun je de verdere ontwikkeling en krijg je de extra functies. Koppelen, een antwoord inlezen en het pakket voor je boekhouder blijven gratis; alleen het versturen vraagt een abonnement.');
  // telefoon koppelen staat uit: het blok noemt de telefoon niet
  await expect(abonnement).not.toContainText(/telefoon/i);
  await expect(abonnement.getByText('De eerste 4 maanden zijn gratis.')).toBeVisible();
  await expect(abonnement.getByText(/€ 9,00 per maand exclusief btw \(€ 10,89 inclusief\)/)).toBeVisible();

  // versturen zonder abonnement: geweigerd, en er ligt niets vast
  await sendAsFile(page);
  await expect(page.locator('.toasts').getByText(/extra functie van het abonnement/)).toBeVisible();
  await expect(card.getByText(/ligt bij Kantoor De Vries/)).toHaveCount(0);

  // afsluiten: het e-mailadres uit de onboarding staat klaar; de betaalpagina "opent"
  await expect(abonnement.getByLabel('E-mailadres voor het abonnement en de facturen')).toHaveValue('piet@example.nl');
  // eerst akkoord (artikel 8.2/8.3): zonder vinkje kan afsluiten niet
  await expect(abonnement.getByRole('button', { name: '4 maanden gratis beginnen' })).toBeDisabled();
  await expect(abonnement.getByRole('link', { name: 'Download de voorwaarden als PDF' })).toBeVisible();
  await abonnement.getByRole('checkbox', { name: /Ik sluit dit abonnement af voor mijn bedrijf/ }).check();
  await abonnement.getByRole('button', { name: '4 maanden gratis beginnen' }).click();
  await expect(page.locator('.toasts').getByText('De betaalpagina is geopend in je browser')).toBeVisible();

  // nog niet betaald: duidelijke melding, geen licentie
  await abonnement.getByRole('button', { name: 'Ik heb betaald: licentie ophalen' }).click();
  await expect(page.locator('.toasts').getByText(/Nog geen betaald abonnement gevonden/)).toBeVisible();

  // betaald (webhook): de bedrijfsgegevens voor de factuur gingen mee
  const accounts = (await (await request.post('/__pay')).json()).ok as { email: string; bedrijf: Record<string, string> }[];
  expect(accounts).toEqual([expect.objectContaining({ email: 'piet@example.nl', voorwaarden: '2026-09-30', zakelijk: true, bedrijf: expect.objectContaining({ naam: 'Stukadoorsbedrijf Piet', kvk: '12345678', land: 'NL' }) })]);
  await abonnement.getByRole('button', { name: 'Ik heb betaald: licentie ophalen' }).click();
  await expect(page.locator('.toasts').getByText(/Abonnement actief t\/m/)).toBeVisible();
  await expect(card.getByText(/Abonnement actief; de maandelijkse factuur krijg je per e-mail/)).toBeVisible();

  // opzeggen: er wordt niets meer afgeschreven, versturen kan nog t/m de betaalde periode
  await card.getByRole('button', { name: 'Opzeggen', exact: true }).click();
  const opzeggen = page.getByRole('dialog', { name: 'Abonnement opzeggen?' });
  await expect(opzeggen.getByText('Er wordt daarna niets meer afgeschreven. Je kunt nog naar je boekhouder versturen tot het eind van de maand waarvoor je betaald hebt; een antwoord inlezen kan altijd.')).toBeVisible();
  await opzeggen.getByRole('button', { name: 'Opzeggen', exact: true }).click();
  await expect(page.locator('.toasts').getByText(/Opgezegd; versturen kan nog t\/m/)).toBeVisible();
  await expect(card.getByText(/Abonnement opgezegd: je kunt versturen t\/m/)).toBeVisible();

  // en nu versturen: lukt
  await sendAsFile(page);
  await savedPath(page, /Bewaard: (.+?)\. Stuur/);
  await expect(card.getByText(/Uitwisseling 1 ligt bij Kantoor De Vries/)).toBeVisible();
});

test('abonnement met telefoon koppelen aan: het blok en de meldingen noemen ook de telefoon, en wat altijd kan', async ({ page, request }) => {
  // licenties aan en telefoon koppelen aan (in de app staat koppelen nog uit)
  await request.post('/__reset', { data: { licenses: true, phoneScanner: true } });
  await onboard(page);
  const until = (await call<string[]>(page, 'periods.suggestedDates'))[0]!;
  await call(page, 'purchases.recordExpense', { date: until, supplierName: 'Gamma', description: 'Materiaal', categoryKey: 'materiaal', grossAmount: 12100, vatCode: 'hoog', paidWith: 'prive' });
  await linkToOffice(page);

  const card = page.getByTestId('uitwisseling');
  const abonnement = card.getByTestId('abonnement');
  await expect(abonnement.getByText('Versturen naar je boekhouder, een telefoon koppelen en het bijwerken van klanten, projecten en btw-regels op je telefoon zijn extra functies van het abonnement.')).toBeVisible();
  await expect(abonnement).toContainText('Met het abonnement steun je de verdere ontwikkeling en krijg je de extra functies. Koppelen aan je boekhouder, een antwoord inlezen en het pakket voor je boekhouder blijven gratis, en wat een gekoppelde telefoon stuurt, komt altijd aan.');
  await expect(abonnement).not.toContainText('alleen het versturen vraagt een abonnement');
  // de prijs en de proefperiode staan er zoals altijd
  await expect(abonnement.getByText('De eerste 4 maanden zijn gratis.')).toBeVisible();
  await expect(abonnement.getByText(/€ 9,00 per maand exclusief btw \(€ 10,89 inclusief\)/)).toBeVisible();

  // versturen zonder abonnement: geweigerd, met dezelfde zin
  await sendAsFile(page);
  await expect(page.locator('.toasts').getByText(/zijn extra functies van het abonnement\. .*een antwoord inlezen kan altijd, wat een gekoppelde telefoon stuurt komt altijd aan/)).toBeVisible();
  await expect(card.getByText(/ligt bij Kantoor De Vries/)).toHaveCount(0);

  // afsluiten, betalen en opzeggen: ook daar staat de telefoon erbij
  await abonnement.getByRole('checkbox', { name: /Ik sluit dit abonnement af voor mijn bedrijf/ }).check();
  await abonnement.getByRole('button', { name: '4 maanden gratis beginnen' }).click();
  await expect(page.locator('.toasts').getByText('De betaalpagina is geopend in je browser')).toBeVisible();
  await request.post('/__pay');
  await abonnement.getByRole('button', { name: 'Ik heb betaald: licentie ophalen' }).click();
  await expect(card.getByText(/Abonnement actief; de maandelijkse factuur krijg je per e-mail/)).toBeVisible();
  await card.getByRole('button', { name: 'Opzeggen', exact: true }).click();
  const opzeggen = page.getByRole('dialog', { name: 'Abonnement opzeggen?' });
  await expect(opzeggen.getByText('Er wordt daarna niets meer afgeschreven. Je kunt nog naar je boekhouder versturen, een telefoon koppelen en klanten, projecten en btw-regels op je telefoon bijwerken tot het eind van de maand waarvoor je betaald hebt; een antwoord inlezen kan altijd, en wat een gekoppelde telefoon stuurt, komt altijd aan.')).toBeVisible();
  await opzeggen.getByRole('button', { name: 'Opzeggen', exact: true }).click();
  await expect(page.locator('.toasts').getByText(/Opgezegd; de extra functies werken nog t\/m/)).toBeVisible();
  await expect(card.getByText(/Abonnement opgezegd: de extra functies werken t\/m .*; er wordt niets meer afgeschreven\./)).toBeVisible();
});
