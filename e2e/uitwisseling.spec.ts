import { expect, type Page } from '@playwright/test';
import { call, nav, onboard, test } from './fixtures';

/** Het pad uit een melding als "… bewaard: /pad/naar/bestand. Stuur …". */
async function savedPath(page: Page, re: RegExp): Promise<string> {
  const toast = page.locator('.toasts').getByText(re).last();
  await expect(toast).toBeVisible();
  return (await toast.textContent())!.match(re)![1]!;
}

async function administrationsTab(page: Page) {
  await nav(page, 'Instellingen');
  await page.getByRole('button', { name: 'Administraties' }).click();
}

test('uitwisseling: uitnodigen, versturen, corrigeren bij de boekhouder, antwoord inlezen', async ({ page }) => {
  await onboard(page);
  // een aankoop in de periode die straks naar de boekhouder gaat
  const until = (await call<string[]>(page, 'periods.suggestedDates'))[0]!;
  await call(page, 'purchases.recordExpense', { date: until, supplierName: 'Gamma', description: 'Materiaal', categoryKey: 'materiaal', grossAmount: 12100, vatCode: 'hoog', paidWith: 'prive' });

  // het kantoor (voor de test op dezelfde computer als de klant)
  await administrationsTab(page);
  const kantoor = page.getByTestId('kantoor');
  await kantoor.locator('input').nth(0).fill('Kantoor De Vries');
  await kantoor.locator('input').nth(1).fill('info@kantoordevries.nl');
  await kantoor.getByRole('button', { name: 'Opslaan' }).click();
  const code = (await kantoor.locator('code').filter({ hasText: /^[A-Z2-9]{4}-[A-Z2-9]{4}$/ }).textContent())!;
  await kantoor.getByRole('button', { name: 'Uitnodiging voor een klant maken' }).click();
  const invite = await savedPath(page, /Uitnodiging bewaard: (.+?)\. Stuur/);

  // de klant opent de uitnodiging en ziet dezelfde controlecode
  await nav(page, 'Hoe gaat het?');
  const card = page.getByTestId('uitwisseling');
  await card.locator('input[type=file]').setInputFiles(invite);
  const koppelen = page.getByRole('dialog', { name: 'Koppelen aan je boekhouder?' });
  await expect(koppelen.getByText(code)).toBeVisible();
  await koppelen.getByRole('button', { name: 'Koppelen' }).click();
  await expect(card.getByText(/Gekoppeld aan/)).toBeVisible();

  // versturen t/m het laatste afgelopen kwartaal
  const label = (await card.getByLabel('Sturen t/m').locator('option:checked').textContent())!;
  const date = label.replace(/ \(.*/, '');
  await card.getByRole('button', { name: 'Als bestand bewaren' }).click();
  await page.getByRole('dialog', { name: new RegExp(`T/m ${date} naar Kantoor De Vries`) }).getByRole('button', { name: 'Bewaren' }).click();
  const exportFile = await savedPath(page, /Bewaard: (.+?)\. Stuur/);
  await expect(card.getByText(/Uitwisseling 1 ligt bij Kantoor De Vries/)).toBeVisible();
  await expect(page.getByTestId('periode-afsluiten').getByText(`T/m ${date} ligt bij je boekhouder`)).toBeVisible();

  // de boekhouder leest de export in: een aparte administratie, de kopie
  await administrationsTab(page);
  await page.getByTestId('kantoor').locator('input[type=file][accept=".gbpakket"]').setInputFiles(exportFile);
  await expect(page.locator('.toasts').getByText('Export ingelezen')).toBeVisible();
  await page.reload(); // de app ververst het venster na het wisselen
  const banner = page.getByTestId('kopie-antwoord');
  await expect(banner.getByText(/Kopie van Stukadoorsbedrijf Piet voor Kantoor De Vries/)).toBeVisible();

  // corrigeren in de expertmodus, zoals een boekhouder dat doet
  await call(page, 'settings.update', { advancedMode: true });
  await page.reload();
  await nav(page, 'Boekhouding');
  await page.locator('input[type=date]').first().fill(`${until.slice(0, 4)}-01-01`);
  await page.locator('input[type=date]').nth(1).fill(`${until.slice(0, 4)}-12-31`);
  await page.getByRole('button', { name: 'Journaal', exact: true }).click();
  // de aankoop van de klant terugdraaien (geen memoriaalpost: in de kopie kan elke post in de periode terug)
  const aankoop = page.locator('.card.flat', { hasText: 'Inkoop: Materiaal' }).filter({ has: page.getByRole('button', { name: 'Terugdraaien' }) }).first();
  page.once('dialog', (d) => void d.accept());
  await aankoop.getByRole('button', { name: 'Terugdraaien' }).click();
  await expect(page.locator('.toasts').getByText('Tegenboeking gemaakt')).toBeVisible();
  // en een correctieboeking; de datum staat al op de einddatum van de uitwisseling
  await page.getByRole('button', { name: 'Correctieboeking' }).click();
  const memo = page.getByRole('dialog', { name: 'Correctieboeking (memoriaal)' });
  await expect(memo.locator('input[type=date]')).toHaveValue(until);
  await memo.locator('input').nth(1).fill('Bankkosten vergeten');
  await memo.locator('select').nth(0).selectOption('WFbeBan');
  await memo.locator('input[placeholder=debet]').nth(0).fill('15');
  await memo.locator('select').nth(1).selectOption('BLiqBanRba');
  await memo.locator('input[placeholder=credit]').nth(1).fill('15');
  await memo.getByRole('button', { name: 'Boeken' }).click();
  await expect(page.locator('.toasts').getByText('Geboekt')).toBeVisible();
  await page.reload();
  await expect(banner.getByText('2 aanpassingen')).toBeVisible();
  await banner.getByRole('button', { name: 'Antwoord maken' }).click();
  const answer = await savedPath(page, /Antwoord bewaard: (.+?)\. Stuur/);
  await expect(banner.getByText(/Antwoord gemaakt op/)).toBeVisible();

  // terug bij de klant: antwoord inlezen
  await page.evaluate(() => window.bridge.call('administrations.open', ['']));
  await page.reload();
  await nav(page, 'Hoe gaat het?');
  await page.getByTestId('uitwisseling').locator('input[type=file]').setInputFiles(answer);
  const klaar = page.getByRole('dialog', { name: 'Antwoord van Kantoor De Vries ingelezen' });
  await expect(klaar.getByText(/Correctieboeking .*Bankkosten vergeten/)).toBeVisible();
  await expect(klaar.getByText(/^Teruggedraaid: /)).toBeVisible();
  await klaar.getByRole('button', { name: 'Oké' }).click();
  await expect(page.getByTestId('periode-afsluiten').getByText(`Afgesloten t/m ${date}.`)).toBeVisible();
  await expect(page.getByTestId('uitwisseling').getByText(/Laatste antwoord: uitwisseling 1/)).toBeVisible();
});

test('kantoorsleutel delen met een collega: met wachtwoord, en dezelfde controlecode', async ({ page }) => {
  await onboard(page);
  await administrationsTab(page);
  const kantoor = page.getByTestId('kantoor');
  await kantoor.locator('input').nth(0).fill('Kantoor De Vries');
  await kantoor.getByRole('button', { name: 'Opslaan' }).click();
  const code = (await kantoor.locator('code').filter({ hasText: /^[A-Z2-9]{4}-[A-Z2-9]{4}$/ }).textContent())!;

  const collega = page.getByTestId('collega');
  await collega.locator('summary').click();
  await collega.locator('input[type=password]').first().fill('lange zin als wachtwoord');
  await collega.getByRole('button', { name: 'Kantoorsleutel bewaren voor een collega' }).click();
  const file = await savedPath(page, /Kantoorsleutel bewaard: (.+?)\. Geef/);

  // bij de collega: eerst een eigen (andere) sleutel, dan die van het kantoor inlezen
  await call(page, 'exchange.saveOffice', 'Kantoor De Vries', '', true);
  await page.reload();
  await administrationsTab(page);
  await expect(page.getByTestId('kantoor').locator('code').filter({ hasText: code })).toHaveCount(0);
  await collega.locator('summary').click();
  await collega.locator('input[type=password]').last().fill('verkeerd wachtwoord!');
  await collega.locator('input[type=file]').setInputFiles(file);
  await expect(page.getByText('Verkeerd wachtwoord, of het bestand is beschadigd')).toBeVisible();
  await collega.locator('input[type=password]').last().fill('lange zin als wachtwoord');
  await collega.locator('input[type=file]').setInputFiles(file);
  await expect(page.locator('.toasts').getByText('Kantoorsleutel overgenomen')).toBeVisible();
  await expect(page.getByTestId('kantoor').locator('code').filter({ hasText: code })).toBeVisible();
});
