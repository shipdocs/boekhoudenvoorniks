import { test, expect, onboard, nav, call } from './fixtures';
import { makePdf } from '../tests/pdf';

// datums rond vandaag, zodat de test niet verloopt
const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000);
const nl = (d: Date) => `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
const ing = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

/** Een bon van Gamma met tekstlaag; `extra` maakt er een ander bestand van. */
const bon = (daysAgo: number, extra = '') =>
  Buffer.from(makePdf(['Gamma', `Datum ${nl(day(daysAgo))}`, 'Verf 100,00', 'BTW 21% 100,00 21,00', 'Totaal 121,00', ...(extra ? [extra] : [])]));

async function upload(page: import('@playwright/test').Page, name: string, buffer: Buffer) {
  await page.locator('main input[type=file]').first().setInputFiles({ name, mimeType: 'application/pdf', buffer });
}

test('exact hetzelfde bestand: "Dit document stond er al in" met "Bestaand document bekijken"', async ({ page, problems }) => {
  await onboard(page);
  await nav(page, 'Aankopen & bonnetjes');
  const file = bon(10);
  await upload(page, 'gamma.pdf', file);
  const added = page.getByTestId('toegevoegd');
  await expect(added.getByText('Nog controleren')).toBeVisible();

  // nog een keer, onder een andere naam: geweigerd, er komt geen tweede document bij
  await upload(page, 'gamma-nog-een-keer.pdf', file);
  await expect(added.getByText('Dit document stond er al in.')).toBeVisible();
  await expect(added.getByText('Er is niets opnieuw geboekt.')).toBeVisible();
  expect(await call<unknown[]>(page, 'documents.list')).toHaveLength(1);
  await expect(page.locator('.card .task', { hasText: 'Klopt alles?' })).toHaveCount(1);

  await added.getByRole('button', { name: 'Bestaand document bekijken' }).click();
  await expect(page.getByRole('heading', { name: 'Gamma', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Klopt, verwerken' })).toBeVisible();
  expect(problems.apiErrors).toEqual([]);
});

test('mogelijk dubbel: beide naast elkaar, en Later, Nee en Ja doen wat ze zeggen', async ({ page, problems }) => {
  await onboard(page);
  await nav(page, 'Aankopen & bonnetjes');
  // de eerste bon wordt een aankoop
  await upload(page, 'gamma-1.pdf', bon(10));
  await page.getByTestId('toegevoegd').getByRole('button', { name: 'Bekijken' }).click();
  await page.getByRole('button', { name: 'Klopt, verwerken' }).click();
  await expect(page.locator('.toasts').getByText('Nieuwe aankoop geboekt ✓')).toBeVisible();
  await expect(page.locator('table.list tbody tr', { hasText: 'Gamma' })).toHaveCount(1);

  // zelfde winkel en bedrag, een dag later, zonder nummer: de app vraagt het eerst
  await upload(page, 'gamma-2.pdf', bon(9, 'Bedankt en tot ziens'));
  await expect(page.getByTestId('toegevoegd').getByText('Nog controleren')).toBeVisible();
  await page.getByTestId('toegevoegd').getByRole('button', { name: 'Bekijken' }).click();
  const proposal = page.getByTestId('voorstel');
  await expect(proposal.getByText(/Lijkt op de aankoop bij Gamma.*Is dit dezelfde aankoop\?/)).toBeVisible();
  await expect(proposal.getByRole('heading', { name: 'Deze bon' })).toBeVisible();
  await expect(proposal.getByRole('heading', { name: 'Wat er al staat' })).toBeVisible();
  // de aankoop die er al staat: leverancier, datum en bedrag
  await expect(proposal.getByRole('row', { name: /Aankoop bij Gamma/ })).toBeVisible();
  await expect(proposal.getByRole('row', { name: /Bedrag € 121,00/ })).toHaveCount(2);
  await expect(proposal.getByText('gamma-1.pdf')).toBeVisible();
  // zolang de vraag openstaat is er niets te boeken
  await expect(page.getByRole('button', { name: 'Klopt, verwerken' })).toHaveCount(0);

  // Later: terug naar Aankopen, de bon wacht nog
  await proposal.getByRole('button', { name: 'Later' }).click();
  await expect(page.getByRole('heading', { name: 'Even controleren' })).toBeVisible();
  expect(await call<unknown[]>(page, 'purchases.list')).toHaveLength(1);

  // op Vandaag staat dezelfde vraag, met de drie keuzes
  await nav(page, 'Vandaag');
  const task = page.locator('.task', { hasText: /Is dit dezelfde aankoop\?/ });
  await expect(task.getByRole('button', { name: 'Ja, dezelfde aankoop' })).toBeVisible();
  await expect(task.getByRole('button', { name: 'Nee, andere aankoop' })).toBeVisible();
  await task.getByRole('button', { name: 'Bekijken' }).click();

  // Nee: het voorstel is weg en de gewone controle gaat verder
  await page.getByTestId('voorstel').getByRole('button', { name: 'Nee, andere aankoop' }).click();
  await expect(page.getByTestId('voorstel')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Klopt, verwerken' })).toBeVisible();
  expect(await call<unknown[]>(page, 'purchases.list')).toHaveLength(1);

  // een derde bon die er ook op lijkt: Ja, dezelfde aankoop → bewaard, niet geboekt
  await nav(page, 'Aankopen & bonnetjes');
  await upload(page, 'gamma-3.pdf', bon(11, 'Kopie voor de klant'));
  await page.getByTestId('toegevoegd').getByRole('button', { name: 'Bekijken' }).click();
  await page.getByTestId('voorstel').getByRole('button', { name: 'Ja, dezelfde aankoop' }).click();
  await expect(page.getByTestId('uitkomst')).toHaveText('Dubbel document — niet geboekt');
  await expect(page.getByTestId('koppeling').getByText(/Hoort bij de aankoop bij Gamma/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Klopt, verwerken' })).toHaveCount(0);
  expect(await call<unknown[]>(page, 'purchases.list')).toHaveLength(1);
  expect(problems.apiErrors).toEqual([]);
});

test('bon bij een betaling die al geboekt is: eerst de vraag, daarna alleen bewijs; koppeling ongedaan maken zet hem terug', async ({ page, problems }) => {
  await onboard(page);
  // een betaling die rechtstreeks als kosten geboekt is
  const csv = [
    '"Datum";"Naam / Omschrijving";"Rekening";"Tegenrekening";"Code";"Af Bij";"Bedrag (EUR)";"Mutatiesoort";"Mededelingen"',
    `"${ing(day(9))}";"GAMMA UTRECHT";"NL91ABNA0417164300";"";"BA";"Af";"121,00";"Betaalautomaat";"Pasvolgnr: 001"`,
  ].join('\n');
  await call(page, 'bank.importFile', 'afschrift.csv', csv);
  const [payment] = await call<{ id: number }[]>(page, 'bank.transactions', { status: 'nieuw' });
  await call(page, 'bank.book', payment!.id, { account: 'WKprInkMat', vatCode: 'hoog' });
  const booked = async () => (await call<{ id: number; status: string; matched_journal_entry_id: number | null }[]>(page, 'bank.transactions')).find((t) => t.id === payment!.id)!;
  const before = await booked();

  await nav(page, 'Aankopen & bonnetjes');
  await upload(page, 'gamma.pdf', bon(10));
  // niet stil gekoppeld en niet geboekt: de bon wacht op een antwoord
  await expect(page.getByTestId('toegevoegd').getByText('Nog controleren')).toBeVisible();
  await expect(page.locator('.task .q', { hasText: 'Deze betaling is al geboekt. Wil je deze bon alleen als bewijsstuk koppelen?' })).toBeVisible();
  expect(await call<unknown[]>(page, 'purchases.list')).toHaveLength(0);

  await page.getByTestId('toegevoegd').getByRole('button', { name: 'Bekijken' }).click();
  const proposal = page.getByTestId('voorstel');
  await expect(proposal.getByText('Deze betaling is al geboekt. Wil je deze bon alleen als bewijsstuk koppelen?')).toBeVisible();
  await expect(proposal.getByText(/er komt geen nieuwe kosten- of btw-boeking bij/)).toBeVisible();
  await expect(proposal.getByRole('heading', { name: 'De betaling die al geboekt is' })).toBeVisible();
  await expect(proposal.getByRole('row', { name: /Betaald aan GAMMA UTRECHT/ })).toBeVisible();
  await expect(proposal.getByRole('button', { name: 'Later' })).toBeVisible();
  await expect(proposal.getByRole('button', { name: 'Nee, andere aankoop' })).toBeVisible();

  await proposal.getByRole('button', { name: 'Ja, alleen als bewijs' }).click();
  await expect(page.getByTestId('uitkomst')).toHaveText('Bewijs gekoppeld — niet opnieuw geboekt');
  await expect(page.getByTestId('koppeling').getByText(/Hoort bij de betaling aan GAMMA UTRECHT/)).toBeVisible();
  expect(await call<unknown[]>(page, 'purchases.list')).toHaveLength(0);
  expect(await booked()).toEqual(before);

  // vanaf de betaling is de bon te vinden
  await page.getByTestId('koppeling').getByRole('button', { name: 'Naar de betaling' }).click();
  await expect(page.getByRole('heading', { name: 'Bon of factuur bij deze betaling' })).toBeVisible();
  await page.getByRole('button', { name: 'Bon bekijken' }).click();

  // koppeling ongedaan maken: terug naar "Nog controleren", de betaling blijft geboekt zoals hij was
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('koppeling').getByRole('button', { name: 'Koppeling ongedaan maken' }).click();
  await expect(page.getByTestId('koppeling')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Klopt, verwerken' })).toBeVisible();
  expect(await booked()).toEqual(before);
  expect(await call<unknown[]>(page, 'documents.list', 'controle')).toHaveLength(1);
  expect(problems.apiErrors).toEqual([]);
});
