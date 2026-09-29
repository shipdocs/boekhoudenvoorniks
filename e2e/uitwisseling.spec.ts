import { expect, type Page } from '@playwright/test';
import { nav, onboard, test } from './fixtures';

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
  await page.getByTestId('kantoor').locator('input[type=file]').setInputFiles(exportFile);
  await expect(page.locator('.toasts').getByText('Export ingelezen')).toBeVisible();
  await page.reload(); // de app ververst het venster na het wisselen
  const banner = page.getByTestId('kopie-antwoord');
  await expect(banner.getByText(/Kopie van Stukadoorsbedrijf Piet voor Kantoor De Vries/)).toBeVisible();

  // een correctieboeking, zoals in de expertmodus
  const end = ((await page.evaluate(() => window.bridge.call('app.officeCopy', []))) as { endDate: string }).endDate;
  await page.evaluate((d) => window.bridge.call('ledger.manualEntry', [{ date: d, description: 'Bankkosten vergeten', lines: [{ account: 'WFbeBan', debit: 1500 }, { account: 'BLiqBanRba', credit: 1500 }] }]), end);
  await page.reload();
  await expect(banner.getByText('1 aanpassing')).toBeVisible();
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
  await klaar.getByRole('button', { name: 'Oké' }).click();
  await expect(page.getByTestId('periode-afsluiten').getByText(`Afgesloten t/m ${date}.`)).toBeVisible();
  await expect(page.getByTestId('uitwisseling').getByText(/Laatste antwoord: uitwisseling 1/)).toBeVisible();
});
