import { test, expect, onboard, nav, call } from './fixtures';

// De echte voorstelknoppen controleren: unit-tests van de tarieven bewijzen niet
// dat DocumentEditor ze gebruikt. Met KOR zet DocumentEditor elke voorstelregel op vrijgesteld,
// dus die varianten toetsen alleen die voorrang, niet het tarief van de voorrijkosten.
for (const vak of [
  { key: 'stukadoor', werk: 'Stucwerk wanden (arbeid)', materiaal: 'Materiaal' },
  { key: 'schilder', werk: 'Schilderwerk binnen (arbeid)', materiaal: 'Verf en materiaal' },
]) {
  for (const kor of [false, true]) {
    test(`${vak.key}: werk en materiaal ${kor ? 'vrijgesteld bij KOR' : 'op 9%'} via voorstelknoppen`, async ({ page }) => {
      await onboard(page, { kor });
      await call(page, 'settings.update', { profile: { trade: vak.key } });
      await page.reload();
      await nav(page, 'Werk & facturen');
      await page.getByRole('button', { name: '+ Nieuwe factuur' }).click();
      await page.getByRole('button', { name: `+ ${vak.werk}`, exact: true }).click();
      await page.getByRole('button', { name: `+ ${vak.materiaal}`, exact: true }).click();
      await expect(page.locator('.lines-table tbody tr')).toHaveCount(2);
      await expect(page.getByLabel('Btw regel 1', { exact: true })).toHaveValue(kor ? 'vrijgesteld' : 'laag');
      await expect(page.getByLabel('Btw regel 2', { exact: true })).toHaveValue(kor ? 'vrijgesteld' : 'laag');
      if (vak.key === 'stukadoor') {
        await page.getByRole('button', { name: '+ Voorrijkosten', exact: true }).click();
        await expect(page.getByLabel('Btw regel 3', { exact: true })).toHaveValue(kor ? 'vrijgesteld' : 'laag');
      }
    });
  }
}

for (const vatCode of ['hoog', 'verlegd']) {
  test(`stukadoor: voorrijkosten volgen handmatig gekozen ${vatCode}`, async ({ page }) => {
    await onboard(page);
    await call(page, 'settings.update', { profile: { trade: 'stukadoor' } });
    await page.reload();
    await nav(page, 'Werk & facturen');
    await page.getByRole('button', { name: '+ Nieuwe factuur' }).click();
    await page.getByRole('button', { name: '+ Stucwerk wanden (arbeid)', exact: true }).click();
    await page.getByLabel('Btw regel 1', { exact: true }).selectOption(vatCode);
    await page.getByRole('button', { name: '+ Voorrijkosten', exact: true }).click();
    await expect(page.getByLabel('Btw regel 2', { exact: true })).toHaveValue(vatCode);
    await expect(page.getByLabel('Btw regel 1', { exact: true })).toHaveValue(vatCode);
  });
}

test('stukadoor: voorrijkosten bij gemengde tarieven geven een melding in plaats van een keuze', async ({ page }) => {
  await onboard(page);
  await call(page, 'settings.update', { profile: { trade: 'stukadoor' } });
  await page.reload();
  await nav(page, 'Werk & facturen');
  await page.getByRole('button', { name: '+ Nieuwe factuur' }).click();
  const melding = page.getByText('Op deze factuur staat werk tegen verschillende btw-tarieven');
  await page.getByRole('button', { name: '+ Stucwerk wanden (arbeid)', exact: true }).click();
  await page.getByRole('button', { name: '+ Plafond spuiten (arbeid)', exact: true }).click();
  await page.getByLabel('Btw regel 1', { exact: true }).selectOption('hoog');
  await page.getByRole('button', { name: '+ Voorrijkosten', exact: true }).click();
  await expect(page.getByLabel('Btw regel 3', { exact: true })).toHaveValue('laag');
  await expect(melding).toBeVisible();
  // alle werk op één tarief: de melding verdwijnt
  await page.getByLabel('Btw regel 2', { exact: true }).selectOption('hoog');
  await expect(melding).toHaveCount(0);
});
