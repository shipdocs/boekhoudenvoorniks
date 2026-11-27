import { test, expect, onboard, nav, call } from './fixtures';

/**
 * Een afschrijving zonder bon op Vandaag: na "Zakelijk" eerst de vraag of je de bon hebt. Het btw-tarief kies je pas
 * met de bon erbij (of als je zeker weet wat erop stond). Bedragen en tegenpartijen zijn verzonnen.
 */

const CSV = [
  '"Datum";"Naam / Omschrijving";"Rekening";"Tegenrekening";"Code";"Af Bij";"Bedrag (EUR)";"Mutatiesoort";"Mededelingen"',
  '"20260915";"GAMMA VOORBEELDSTAD";"NL91ABNA0417164300";"";"BA";"Af";"60,50";"Betaalautomaat";"Pinbetaling"',
].join('\n');

function pdf(...lines: string[]): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td ${lines.map((l, i) => `${i ? '0 -30 Td ' : ''}(${l}) Tj`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function openPicker(page: import('@playwright/test').Page) {
  await onboard(page);
  await call(page, 'bank.importFile', 'pin.csv', CSV);
  await page.reload();
  await nav(page, 'Vandaag');
  const task = page.locator('div.task', { hasText: /GAMMA/ });
  await expect(task).toBeVisible();
  await task.getByRole('button', { name: 'Zakelijk', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'Waar was deze betaling voor?' });
  await expect(dlg.getByTestId('bon-vraag')).toBeVisible();
  // zonder bon nog geen btw-tarief, en opslaan kan pas na een antwoord
  await expect(dlg.getByText('Stond er btw op?')).toHaveCount(0);
  await expect(dlg.getByRole('button', { name: 'Opslaan', exact: true })).toBeDisabled();
  return { dlg, task };
}

test('Vandaag: "De bon komt nog" haalt de vraag een week weg', async ({ page }) => {
  const { dlg, task } = await openPicker(page);
  await dlg.getByRole('button', { name: /De bon komt nog/ }).click();
  await expect(dlg).toBeHidden();
  await expect(page.getByText(/We vragen het je op .* weer/).last()).toBeVisible();
  await expect(task).toHaveCount(0);
});

test('Vandaag: bon toevoegen, daarna het btw-tarief met de bon erbij', async ({ page }) => {
  const { dlg, task } = await openPicker(page);
  await dlg.getByTestId('bon-bestand').setInputFiles({ name: 'gamma.pdf', mimeType: 'application/pdf', buffer: pdf('Gamma Totaal 60,50') });
  await expect(dlg.getByTestId('bon-gekoppeld')).toContainText('gamma.pdf');
  await expect(dlg.getByText('Stond er btw op?')).toBeVisible();
  await dlg.getByRole('button', { name: 'Opslaan', exact: true }).click();
  await expect(dlg).toBeHidden();
  await expect(task).toHaveCount(0);
});

test('Vandaag: "Nee, geen bon" boekt zonder btw-aftrek', async ({ page }) => {
  const { dlg, task } = await openPicker(page);
  await dlg.getByRole('button', { name: /Nee, geen bon/ }).click();
  await expect(dlg.getByText('Vind je de bon later terug?')).toBeVisible();
  await dlg.getByRole('button', { name: 'Opslaan', exact: true }).click();
  await expect(dlg).toBeHidden();
  await expect(task).toHaveCount(0);
  const balances = await call<{ rgs_code: string; balance: number }[]>(page, 'ledger.balances');
  expect(balances.find((b) => b.rgs_code === 'BSchBepBtwVoo')?.balance ?? 0).toBe(0);
});

test('Vandaag: de bon staat op de kaart, met de betaling die erbij hoort', async ({ page }) => {
  await onboard(page);
  await nav(page, 'Aankopen & bonnetjes');
  await page.locator('main input[type=file]').first().setInputFiles({ name: 'bon.pdf', mimeType: 'application/pdf', buffer: pdf('Rare Winkel Zoveel', 'Datum 10-09-2026', 'Totaal 121,00') });
  await expect(page.getByRole('button', { name: 'Bekijken' }).first()).toBeVisible();
  const csv = [
    '"Datum";"Naam / Omschrijving";"Rekening";"Tegenrekening";"Code";"Af Bij";"Bedrag (EUR)";"Mutatiesoort";"Mededelingen"',
    '"20260911";"RARE WINKEL ZOVEEL";"NL91ABNA0417164300";"";"BA";"Af";"121,00";"Betaalautomaat";"Pinbetaling"',
  ].join('\n');
  await call(page, 'bank.importFile', 'pin.csv', csv);
  await page.reload();
  await nav(page, 'Vandaag');
  const card = page.locator('div.task', { has: page.getByTestId('bon-voorbeeld') }).first();
  await expect(card).toBeVisible();
  // de eerste pagina van de bon, getekend op de kaart
  await expect(card.getByTestId('bon-voorbeeld').locator('canvas')).toBeVisible();
  await expect(card.getByTestId('bon-betaling')).toContainText('121,00');
  await expect(card.getByTestId('bon-betaling')).toContainText('RARE WINKEL ZOVEEL');
  // de betaling heeft geen eigen vraag naast de bon
  await expect(page.locator('div.task', { hasText: 'Was dit zakelijk' })).toHaveCount(0);
  // klikken op de bon opent hem groot, met de betaling erbij
  await card.getByTestId('bon-voorbeeld').click();
  const dlg = page.getByRole('dialog', { name: 'Bon bekijken' });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('Hoort bij je betaling van');
});

test('Vandaag: bon en betaling die bijna passen, één vraag "Hoort deze betaling bij de bon?"', async ({ page }) => {
  await onboard(page);
  await nav(page, 'Aankopen & bonnetjes');
  await page.locator('main input[type=file]').first().setInputFiles({ name: 'bon.pdf', mimeType: 'application/pdf', buffer: pdf('Rare Winkel Zoveel', 'Datum 10-09-2026', 'Totaal 121,00') });
  await expect(page.getByRole('button', { name: 'Bekijken' }).first()).toBeVisible();
  // zelfde bedrag, maar twee weken later en met de naam van een betaaldienst: niet zeker genoeg om vanzelf te koppelen
  const csv = [
    '"Datum";"Naam / Omschrijving";"Rekening";"Tegenrekening";"Code";"Af Bij";"Bedrag (EUR)";"Mutatiesoort";"Mededelingen"',
    '"20260925";"BETAALDIENST VOORBEELD";"NL91ABNA0417164300";"";"BA";"Af";"121,00";"Betaalautomaat";"Kaartbetaling"',
  ].join('\n');
  await call(page, 'bank.importFile', 'kaart.csv', csv);
  await page.reload();
  await nav(page, 'Vandaag');
  const card = page.locator('div.task', { hasText: 'Hoort deze betaling bij de bon?' });
  await expect(card).toBeVisible();
  await expect(card.getByTestId('bon-voorbeeld')).toBeVisible();
  await expect(card.getByTestId('bon-betaling')).toContainText('BETAALDIENST VOORBEELD');
  await expect(card.getByTestId('bon-betaling')).not.toContainText('Die gaat mee');
  // geen losse vraag bij de betaling
  await expect(page.locator('div.task', { hasText: 'Was dit zakelijk' })).toHaveCount(0);
  await card.getByRole('button', { name: 'Ja, hoort erbij' }).click();
  // nu de gewone vraag bij de bon, met de betaling die meegaat
  const next = page.locator('div.task', { has: page.getByTestId('bon-voorbeeld') }).first();
  await expect(next.getByTestId('bon-betaling')).toContainText('Die gaat mee als je de bon boekt');
  await expect(page.locator('div.task', { hasText: 'Hoort deze betaling bij de bon?' })).toHaveCount(0);
});
