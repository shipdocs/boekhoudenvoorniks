import { test, expect, onboard, nav, call } from './fixtures';

/** Een eenvoudige PDF met één regel tekst. */
function pdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
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

/** De namen die het invoerveld voorstelt (de opties van zijn datalist). */
async function suggestions(input: ReturnType<import('@playwright/test').Page['getByLabel']>) {
  const list = await input.getAttribute('list');
  expect(list, 'het veld heeft een lijst met suggesties').toBeTruthy();
  return input.page().locator(`datalist#${list} option`).evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
}

test('leverancier invullen: bekende leveranciers worden voorgesteld, klanten niet', async ({ page }) => {
  await onboard(page);
  await call(page, 'relations.create', { name: 'ShipDocs', type: 'leverancier' });
  await call(page, 'relations.create', { name: 'Gamma', type: 'beide' });
  await call(page, 'relations.create', { name: 'Bakker BV', type: 'klant' });

  // bij een bon die gecontroleerd moet worden
  await nav(page, 'Aankopen & bonnetjes');
  await page.locator('main input[type=file]').first().setInputFiles({ name: 'bon.pdf', mimeType: 'application/pdf', buffer: pdf('Totaal 10,89') });
  await page.getByRole('button', { name: 'Bekijken' }).first().click();
  const skip = page.getByRole('button', { name: /Nee, ik vul bonnen zelf in/ });
  if (await skip.isVisible().catch(() => false)) await skip.click();

  const field = page.getByLabel('Winkel / leverancier');
  await field.fill('shi');
  expect(await suggestions(field)).toEqual(['Gamma', 'ShipDocs']);

  // bij een bonnetje zonder foto
  await nav(page, 'Aankopen & bonnetjes');
  await page.getByRole('button', { name: 'Bonnetje zonder foto' }).click();
  const where = page.getByLabel('Waar gekocht?');
  await where.fill('Gam');
  expect(await suggestions(where)).toEqual(['Gamma', 'ShipDocs']);
});
