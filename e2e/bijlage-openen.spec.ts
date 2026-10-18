import { test, expect, onboard, nav, call } from './fixtures';

/** Een eenvoudige PDF met één pagina tekst. */
function pdf(lines: string[]): Buffer {
  const stream = `BT /F1 18 Tf 72 720 Td ${lines.map((line) => `(${line}) Tj 0 -28 Td`).join(' ')} ET`;
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

test('een bon toevoegen en later openen: het pad in de administratie is relatief, het juiste bestand gaat open', async ({ page, request }) => {
  await onboard(page);
  await nav(page, 'Aankopen & bonnetjes');
  const bon = pdf(['Rare Winkel Zoveel', 'Datum 10-09-2026', 'Totaal 121,00']);
  await page.locator('main input[type=file]').first().setInputFiles({ name: 'bon.pdf', mimeType: 'application/pdf', buffer: bon });
  await page.getByRole('button', { name: 'Bekijken' }).first().click();
  const skip = page.getByRole('button', { name: /Nee, ik vul bonnen zelf in/ });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  // de controleweergave leest het bestand via het opgeslagen pad
  await expect(page.locator('.doc-view canvas')).toHaveCount(1);
  await page.getByRole('button', { name: /Weet ik nog niet: vraag mijn boekhouder/ }).click();
  const date = page.locator('input[type=date]').first();
  if (!(await date.inputValue())) await date.fill('2026-09-10');
  await page.getByRole('button', { name: 'Klopt, verwerken' }).click();
  await expect(page.getByRole('heading', { name: 'Aankopen', exact: true })).toBeVisible();

  // in de administratie staat geen map van deze computer, alleen het pad binnen de administratie
  const purchases = await call<{ attachment_path: string | null }[]>(page, 'purchases.list');
  expect(purchases).toHaveLength(1);
  expect(purchases[0]!.attachment_path).toMatch(/^bijlagen\/\d{4}\/[\w.-]+bon\.pdf$/);

  // de regel aanklikken opent de bon
  await page.locator('tr.clickable', { hasText: 'Rare Winkel Zoveel' }).locator('td').first().click();
  await expect
    .poll(async () => ((await (await request.post('/__opened')).json()) as { ok: { stored: string; content: string }[] }).ok)
    .toEqual([{ stored: purchases[0]!.attachment_path, content: bon.toString('base64') }]);

  // een pad naar buiten de bijlagenmap opent niet
  await expect(call(page, 'app.openAttachment', 'bijlagen/../boekhouding.sqlite')).rejects.toThrow(/Alleen bijlagen van de administratie/);
});
