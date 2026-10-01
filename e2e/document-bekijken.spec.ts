import { test, expect, onboard, nav } from './fixtures';

/** Een eenvoudige PDF met een paar pagina's tekst. */
function pdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((text, i) => {
    const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
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

test('een PDF van meerdere pagina\'s: alle pagina\'s zijn te zien', async ({ page }) => {
  await onboard(page);
  await nav(page, 'Aankopen & bonnetjes');
  await page.locator('main input[type=file]').first().setInputFiles({ name: 'bon.pdf', mimeType: 'application/pdf', buffer: pdf(['Pagina een', 'Pagina twee', 'Totaal 12,50']) });
  await page.getByRole('button', { name: 'Bekijken' }).first().click();
  const skip = page.getByRole('button', { name: /Nee, ik vul bonnen zelf in/ });
  if (await skip.isVisible().catch(() => false)) await skip.click();

  const view = page.locator('.doc-view');
  await expect(view.locator('canvas')).toHaveCount(3);
  await expect(view.getByLabel('Pagina 3')).toBeVisible();

  // het totaal staat op pagina 3: de markering staat op die pagina en komt in beeld
  await page.locator('.fieldcheck').last().click();
  const marker = view.locator('.doc-page').nth(2).locator('.bbox');
  await expect(marker).toHaveCount(1);
  await expect(marker).toBeInViewport();
});

test('bon "weet ik nog niet": apart gezet, en later indelen bij Aankopen', async ({ page }) => {
  await onboard(page);
  await nav(page, 'Aankopen & bonnetjes');
  await page.locator('main input[type=file]').first().setInputFiles({ name: 'bon.pdf', mimeType: 'application/pdf', buffer: pdf(['Rare Winkel Zoveel', 'Datum 10-09-2026', 'Totaal 121,00']) });
  await page.getByRole('button', { name: 'Bekijken' }).first().click();
  const skip = page.getByRole('button', { name: /Nee, ik vul bonnen zelf in/ });
  if (await skip.isVisible().catch(() => false)) await skip.click();

  await page.getByRole('button', { name: /Weet ik nog niet: vraag mijn boekhouder/ }).click();
  await expect(page.getByTestId('vraagpost')).toContainText('zonder btw-aftrek');
  // de btw-keuze doet dan niet mee
  await expect(page.getByText('Btw op de bon')).toHaveCount(0);
  const date = page.locator('input[type=date]').first();
  if (!(await date.inputValue())) await date.fill('2026-09-10');
  await page.getByRole('button', { name: 'Klopt, verwerken' }).click();

  await expect(page.getByRole('heading', { name: 'Aankopen', exact: true })).toBeVisible();
  const row = page.locator('tr', { has: page.locator('.pill', { hasText: 'nog uitzoeken' }) });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Indelen' }).click();
  const dialog = page.getByRole('dialog', { name: /Indelen:/ });
  await dialog.locator('.chips button', { hasText: /^Materiaal$/ }).click();
  await dialog.getByRole('button', { name: 'Indelen' }).click();
  await expect(page.locator('.toasts').getByText('Ingedeeld ✓')).toBeVisible();
  await expect(page.locator('.pill', { hasText: 'nog uitzoeken' })).toHaveCount(0);
  await expect(page.locator('tr', { hasText: 'Materiaal — Rare Winkel Zoveel' })).toBeVisible();
});

test('bon "weet ik nog niet": indelen vanuit de controle bij Belasting, zonder hem bij Aankopen op te zoeken', async ({ page }) => {
  await onboard(page);
  await nav(page, 'Aankopen & bonnetjes');
  await page.locator('main input[type=file]').first().setInputFiles({ name: 'bon.pdf', mimeType: 'application/pdf', buffer: pdf(['Rare Winkel Zoveel', 'Datum 10-09-2026', 'Totaal 121,00']) });
  await page.getByRole('button', { name: 'Bekijken' }).first().click();
  const skip = page.getByRole('button', { name: /Nee, ik vul bonnen zelf in/ });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.getByRole('button', { name: /Weet ik nog niet: vraag mijn boekhouder/ }).click();
  const date = page.locator('input[type=date]').first();
  if (!(await date.inputValue())) await date.fill('2026-09-10');
  await page.getByRole('button', { name: 'Klopt, verwerken' }).click();
  await expect(page.getByRole('heading', { name: 'Aankopen', exact: true })).toBeVisible();

  await nav(page, 'Belasting');
  const check = page.locator('ul.checks li', { hasText: 'weet ik nog niet' });
  await check.getByRole('button', { name: 'Oplossen' }).click();
  const lines = page.getByRole('dialog', { name: /weet ik nog niet/ });
  await expect(lines.locator('tbody tr')).toHaveCount(1);
  await lines.getByRole('button', { name: 'Indelen' }).click();
  const dialog = page.getByRole('dialog', { name: /Indelen:/ });
  await dialog.locator('.chips button', { hasText: /^Materiaal$/ }).click();
  await dialog.getByRole('button', { name: 'Indelen' }).click();
  await expect(page.locator('.toasts').getByText('Ingedeeld ✓')).toBeVisible();
  // het venster met de controle blijft open en is nu leeg
  await expect(lines).toContainText('Hier staat niets (meer) op');
});
