import { test, expect, onboard, nav, field } from './fixtures';

const jj = String(new Date().getFullYear()).slice(2);

test('laatste factuurnummer uit een vorig pakket: eigen opmaak, volgend nummer zichtbaar en aan te passen', async ({ page, problems }) => {
  await page.goto('/');
  // de welkomststap: "26100" past niet bij {JJJJ}-{NNNN}; de app stelt {JJ}{NNN} voor en laat het volgende nummer zien
  await onboard(page, { lastInvoiceNumber: `${jj}100` });
  expect(problems.apiErrors).toEqual([]);

  await nav(page, 'Instellingen');
  await page.getByRole('button', { name: 'Facturen & offertes' }).click();
  await expect(field(page, 'Opmaak factuurnummer')).toHaveValue('{JJ}{NNN}');
  const card = page.getByTestId('volgend-factuurnummer');
  await expect(card).toContainText(`${jj}101`);
  await card.getByLabel('Volgende volgnummer').fill('120');
  await card.getByRole('button', { name: 'Nummer zetten' }).click();
  await expect(card).toContainText(`${jj}120`);

  // een opmaak zonder accolades: meteen een uitleg, en opslaan lukt niet
  await field(page, 'Opmaak factuurnummer').fill('JJ NNN');
  await expect(page.getByTestId('opmaak-fout')).toContainText('accolades');
  await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
  await expect(page.getByText(/Zet de codes tussen accolades/).last()).toBeVisible();
  await page.getByRole('button', { name: 'Annuleren', exact: true }).click();

  // het concept toont het nummer dat het krijgt
  await nav(page, 'Werk & facturen');
  await page.getByRole('button', { name: '+ Nieuwe factuur' }).click();
  await expect(page.getByTestId('verwacht-nummer')).toContainText(`${jj}120`);
});

test('bonnetje zonder foto met omschrijving: die staat in de lijst', async ({ page }) => {
  await onboard(page);
  await nav(page, 'Aankopen & bonnetjes');
  await page.getByRole('button', { name: 'Bonnetje zonder foto' }).click();
  const dlg = page.getByRole('dialog', { name: 'Aankoop toevoegen' });
  await dlg.getByPlaceholder('bv. Gamma').fill('Bol.com');
  await field(page, 'Wat heb je gekocht?').fill('Kopieerpapier');
  await dlg.locator('label.field', { hasText: 'Bedrag op de bon' }).locator('input').fill('24,20');
  await dlg.getByRole('button', { name: 'Contant', exact: true }).click();
  await dlg.getByRole('button', { name: 'Opslaan', exact: true }).click();
  await expect(dlg).toBeHidden();
  await expect(page.getByText('Kopieerpapier')).toBeVisible();
});
