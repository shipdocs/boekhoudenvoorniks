import { test, expect, onboard, nav, field, type Problems } from './fixtures';
import type { Page } from '@playwright/test';
import { otherPackage } from '../tests/fixtures/xaf-ander-pakket';
import { kolommenbalans } from '../tests/fixtures/xlsx';

/**
 * De overstap-hulp van begin tot eind, zoals een vakman hem doorloopt: elk hoofdstuk, elk soort
 * bestand dat erop gesleept kan worden, en de controles aan het eind. Alle datums zijn relatief aan
 * dit jaar, zodat de tests niet verlopen.
 */

const year = new Date().getFullYear();
const prev = year - 1;

/** Een hoofdstuk kiezen via de chips bovenin (met of zonder vinkje ervoor). */
async function chapter(page: Page, title: string) {
  await page.locator('.chips button', { hasText: new RegExp(`^(✓ )?${title.replace(/[?]/g, '\\?')}$`) }).click();
  await expect(page.locator('h2').first()).toBeVisible();
}

/** Een bestand op de (eerste) dropzone van het hoofdstuk zetten. */
async function drop(page: Page, name: string, data: string | Uint8Array, mimeType = 'text/plain') {
  await page.locator('main input[type=file]').first().setInputFiles({ name, mimeType, buffer: Buffer.from(data) });
}

const equity = (page: Page) => page.locator('.card', { hasText: 'Wat er van jou in de zaak zit' });

/** Afschrift in het CSV-formaat van ING (de app herkent dat zelf). */
const ING_HEAD = '"Datum";"Naam / Omschrijving";"Rekening";"Tegenrekening";"Code";"Af Bij";"Bedrag (EUR)";"Mutatiesoort";"Mededelingen"';
const ingRow = (date: string, name: string, afBij: 'Af' | 'Bij', amount: string, text: string) =>
  `"${date}";"${name}";"NL91ABNA0417164300";"NL20INGB0001234567";"OV";"${afBij}";"${amount}";"Overschrijving";"Naam: ${name} Omschrijving: ${text}"`;
const ing = (...rows: string[]) => [ING_HEAD, ...rows].join('\n');

const noApiErrors = (problems: Problems) => expect(problems.apiErrors).toEqual([]);

test('nieuwe gebruiker: overstap-hulp later openen via Instellingen', async ({ page, problems }) => {
  await onboard(page);
  // wie net begint, krijgt geen overstap-taak
  await expect(page.getByRole('link', { name: 'Je vorige administratie overzetten' })).toHaveCount(0);

  await nav(page, 'Instellingen');
  await page.getByRole('button', { name: 'Overstap-hulp openen' }).click();
  await expect(page.getByRole('heading', { name: 'Overstappen met een lopende administratie' })).toBeVisible();
  await page.getByRole('button', { name: 'Beginnen' }).click();
  await expect(page.getByRole('heading', { name: 'Overstappen', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Hoe stap je over?' })).toBeVisible();

  // nu staat hij wel op Vandaag, en brengt je terug
  await nav(page, 'Vandaag');
  await page.getByRole('link', { name: 'Je vorige administratie overzetten' }).click();
  await expect(page.getByRole('heading', { name: 'Overstappen', exact: true })).toBeVisible();
  // en in Instellingen heet de knop nu anders
  await nav(page, 'Instellingen');
  await expect(page.getByRole('button', { name: 'Naar de overstap-hulp' })).toBeVisible();
  noApiErrors(problems);
});

test('overstapper op 1 januari: alle hoofdstukken met de hand, controles en klaarzetten', async ({ page, problems }) => {
  await onboard(page, { overstap: true });
  await expect(page.getByText(`1 januari ${year}`).first()).toBeVisible();
  // het lijstje "wat heb je nodig" staat ingeklapt onder de keuze hoe je overstapt
  await page.getByText('Wat heb je nodig?').click();
  await expect(page.getByText(/Bankafschriften vanaf 1 januari/)).toBeVisible();
  // op 1 januari is er geen hoofdstuk "omzet en kosten tot nu toe"
  await expect(page.locator('.chips button', { hasText: 'Omzet en kosten tot nu toe' })).toHaveCount(0);

  // --- bank: beginsaldo en afschriften vanaf de instapdatum
  await page.getByRole('button', { name: /Verder: uit je vorige programma/ }).click();
  await page.getByRole('button', { name: /Verder: bankrekeningen/ }).click();
  await expect(page.getByText('Nog geen afschriften ingelezen.')).toBeVisible();
  await page.getByRole('textbox', { name: /Beginsaldo/ }).fill('1500,00');
  await page.getByRole('button', { name: 'Opslaan', exact: true }).first().click();
  await expect(page.locator('.pill', { hasText: /ingevuld: .*1\.500,00/ })).toBeVisible();

  await drop(page, 'afschrift.csv', ing(
    ingRow(`${prev}1230`, 'Albert Heijn', 'Af', '12,50', 'boodschappen'),
    ingRow(`${year}0110`, 'Shell', 'Af', '45,00', 'tanken'),
  ), 'text/csv');
  await expect(page.getByText(/2 betalingen ingelezen/)).toBeVisible();
  // een betaling van vóór de instapdatum zat al in de vorige administratie
  await expect(page.getByText(/1 betaling is van vóór/)).toBeVisible();
  await page.getByRole('button', { name: 'Overslaan' }).click();
  await expect(page.getByText(/1 betaling is van vóór/)).toHaveCount(0);
  await expect(page.getByText(/Ingelezen: /)).toBeVisible();

  // een extra rekening (potje zonder nummer)
  await page.getByRole('button', { name: /Nog een rekening/ }).click();
  const add = page.locator('.modal');
  await field(page, 'Naam').fill('Spaarrekening');
  await add.getByRole('button', { name: 'Toevoegen' }).click();
  await expect(add).toBeHidden();
  await expect(page.locator('.card', { hasText: 'Spaarrekening' })).toBeVisible();
  const spaar = page.locator('.card', { hasText: 'Spaarrekening' });
  await spaar.getByRole('textbox', { name: /Beginsaldo/ }).fill('0,00');
  await spaar.getByRole('button', { name: 'Opslaan' }).click();
  await expect(spaar.locator('.pill', { hasText: /ingevuld/ })).toBeVisible();

  // --- klanten: openstaande factuur
  await chapter(page, 'Klanten die nog moeten betalen');
  await page.getByRole('button', { name: /Openstaande factuur toevoegen/ }).click();
  let dialog = page.locator('.modal');
  await dialog.getByLabel('Klant').fill('Familie Jansen');
  await dialog.getByLabel(/Factuurnummer/).fill(`${prev}-0099`);
  await dialog.getByLabel(/Nog open/).fill('1210,00');
  await dialog.getByRole('button', { name: 'Opslaan' }).click();
  await expect(page.getByText(`Factuur ${prev}-0099 Familie Jansen`)).toBeVisible();

  // --- leveranciers: openstaande rekening
  await chapter(page, 'Rekeningen die jij nog moet betalen');
  await page.getByRole('button', { name: /Openstaande rekening toevoegen/ }).click();
  dialog = page.locator('.modal');
  await dialog.getByLabel('Leverancier').fill('Gamma');
  await dialog.getByLabel(/Factuurnummer/).fill('F-7781');
  await dialog.getByLabel(/Nog open/).fill('363,00');
  await dialog.getByRole('button', { name: 'Opslaan' }).click();
  await expect(page.getByText(/Gamma/).first()).toBeVisible();
  await expect(page.getByText(/Samen: .*363,00/)).toBeVisible();

  // --- bezit: bus van twee jaar geleden, waarde rekent de app zelf uit
  await chapter(page, 'Bus, auto en gereedschap');
  await page.getByRole('button', { name: '+ Toevoegen' }).click();
  dialog = page.locator('.modal');
  await field(page, 'Wat is het?').fill('Bus Ford Transit');
  await field(page, 'Gekocht op').fill(`${year - 2}-01-15`);
  await field(page, 'Prijs (zonder btw)').fill('30000,00');
  await expect(dialog.getByText(/leeg: de app rekent € 18000,00/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Opslaan' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Bus Ford Transit')).toBeVisible();

  // --- btw van de laatste aangifte
  await chapter(page, 'Btw');
  await page.getByRole('button', { name: 'Ik moest nog betalen' }).click();
  await page.getByRole('textbox', { name: 'Btw-bedrag' }).fill('500,00');
  await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
  await expect(page.locator('.pill', { hasText: /te betalen: .*500,00/ })).toBeVisible();

  // --- lening
  await chapter(page, 'Leningen en overig');
  await page.getByRole('button', { name: '+ Toevoegen' }).click();
  dialog = page.locator('.modal');
  await dialog.getByRole('button', { name: /^Lening/ }).click();
  await field(page, 'Omschrijving').fill('Lening bus Rabobank');
  await dialog.locator('input.num').fill('2000,00');
  await dialog.getByRole('button', { name: 'Opslaan' }).click();
  await expect(page.getByText('Lening bus Rabobank')).toBeVisible();

  // --- startpositie: 1.500 + 1.210 + 18.000 − 363 − 500 − 2.000
  await chapter(page, 'Je startpositie');
  await expect(equity(page).getByText(/17\.847,00/)).toBeVisible();
  const had = page.locator('.card', { hasText: 'Wat je had' });
  await expect(had.getByText(/18\.000,00/)).toBeVisible();
  // vergelijken met de balans van de boekhouder
  await page.getByText('Heb je de balans van je boekhouder?').click();
  await page.getByRole('textbox', { name: 'Eigen vermogen volgens de boekhouder' }).fill('17847,00');
  await page.getByRole('button', { name: 'Vergelijken' }).click();
  await expect(page.getByText('✓ Precies gelijk aan de balans van je boekhouder.')).toBeVisible();

  await page.getByRole('button', { name: 'Klopt, zet klaar' }).click();
  await expect(page.locator('.pill', { hasText: 'Klaar ✓' })).toBeVisible();
  // alle hoofdstukken hebben een vinkje
  await expect(page.locator('.chips button', { hasText: 'Je startpositie' })).toHaveText(/^✓ /);

  // op Vandaag is de taak afgevinkt
  await page.getByRole('button', { name: 'Naar Vandaag' }).click();
  await expect(page.getByRole('link', { name: 'Je vorige administratie overzetten' })).toHaveCount(0);

  // de openstaande factuur staat bij Werk & facturen, maar is niet opnieuw te versturen
  await nav(page, 'Werk & facturen');
  await page.getByText(`${prev}-0099`).first().click();
  await expect(page.getByText(/Deze factuur komt uit je vorige administratie/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Versturen/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'PDF opslaan' })).toHaveCount(0);
  // terug naar de overstap-hulp, bij de klanten
  await page.getByRole('button', { name: 'Aanpassen in de overstap-hulp' }).click();
  await expect(page.getByRole('heading', { name: 'Klanten die je nog moesten betalen' })).toBeVisible();
  noApiErrors(problems);
});

test('overstapper midden in het jaar: omzet tot nu toe, gesplitste btw-periode en andere instapdatum', async ({ page, problems }) => {
  await onboard(page, { overstapDate: `${prev}-08-15` });
  await expect(page.getByText(`15 augustus ${prev}`).first()).toBeVisible();

  // omzet en kosten van 1 januari tot de instapdatum
  await chapter(page, 'Omzet en kosten tot nu toe');
  await field(page, 'Omzet').fill('5000,00');
  await field(page, 'Materiaal, inkoop en onderaannemers').fill('1000,00');
  await page.locator('h2').click(); // veld verlaten
  await expect(page.getByText(/Winst tot nu toe: .*4\.000,00/)).toBeVisible();
  await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
  await expect(page.locator('.pill', { hasText: 'ingevuld' })).toBeVisible();

  // btw: aangiften van vóór de instapdatum deed je elders; het kwartaal wordt gesplitst
  await chapter(page, 'Btw');
  await expect(page.getByText(/deed je in je vorige administratie/)).toBeVisible();
  const split = page.locator('.card', { hasText: 'Omzet en btw van' });
  await expect(split.getByRole('heading')).toHaveText(`Omzet en btw van 1 juli ${prev} tot 15 augustus ${prev}`);
  await split.locator('label.field', { hasText: 'Omzet 21%' }).locator('input').fill('2000,00');
  await split.locator('label.field', { hasText: 'Btw 21%' }).locator('input').fill('420,00');
  await split.getByRole('button', { name: 'Opslaan' }).click();
  await expect(split.locator('.pill', { hasText: 'ingevuld' })).toBeVisible();

  await chapter(page, 'Je startpositie');
  await expect(equity(page).getByText(/Waarvan winst van 1 januari tot .*4\.000,00/)).toBeVisible();

  // instapdatum verzetten naar het begin van het kwartaal: geen gesplitste periode meer
  await chapter(page, 'Hoe stap je over?');
  await page.getByRole('button', { name: 'Andere datum kiezen' }).click();
  await field(page, 'Nieuwe instapdatum').fill(`${prev}-07-01`);
  await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Instapdatum: 1 juli ${prev}` })).toBeVisible();
  await chapter(page, 'Btw');
  await expect(page.locator('.card', { hasText: 'Omzet en btw van' })).toHaveCount(0);
  noApiErrors(problems);
});

test('overstapper: betalingen na de instapdatum worden voorstellen voor oude facturen', async ({ page, problems }) => {
  await onboard(page, { overstap: true });
  await chapter(page, 'Bankrekeningen');
  await drop(page, 'afschrift.csv', ing(ingRow(`${year}0112`, 'Bakker Bouw', 'Bij', '1210,00', `factuur ${prev}-0042`)), 'text/csv');
  await expect(page.getByText(/1 betalingen ingelezen/)).toBeVisible();

  await chapter(page, 'Klanten die nog moeten betalen');
  const tip = page.locator('.card', { hasText: 'Gevonden in je bankafschriften' });
  await expect(tip.getByText(/Betaalde Bakker Bouw hiermee een factuur van vóór/)).toBeVisible();
  await tip.getByRole('button', { name: 'Ja' }).click();
  const dialog = page.locator('.modal');
  await expect(dialog.getByLabel(/Factuurnummer/)).toHaveValue(`${prev}-0042`);
  await dialog.getByRole('button', { name: 'Opslaan' }).click();
  await expect(tip).toHaveCount(0);
  // de factuur staat erin en is meteen betaald
  await expect(page.getByText(`Factuur ${prev}-0042 Bakker Bouw`)).toBeVisible();
  await expect(page.getByText('betaald ✓')).toBeVisible();
  await expect(page.locator('tr', { hasText: `${prev}-0042` }).getByTitle('Al betaald of afgeschreven')).toBeVisible();
  noApiErrors(problems);
});

test('overstapper: openstaande factuur als e-factuur (UBL) erop slepen', async ({ page, problems }) => {
  await onboard(page, { overstap: true });
  await chapter(page, 'Klanten die nog moeten betalen');
  const ubl = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017</cbc:CustomizationID>
  <cbc:ID>${prev}-0077</cbc:ID>
  <cbc:IssueDate>${prev}-12-01</cbc:IssueDate>
  <cbc:DueDate>${prev}-12-15</cbc:DueDate>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty><cac:Party><cac:PartyName><cbc:Name>Stukadoorsbedrijf Piet</cbc:Name></cac:PartyName></cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party><cac:PartyName><cbc:Name>Van Dijk Bouw</cbc:Name></cac:PartyName></cac:Party></cac:AccountingCustomerParty>
  <cac:LegalMonetaryTotal><cbc:TaxExclusiveAmount currencyID="EUR">500.00</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="EUR">605.00</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="EUR">605.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
</Invoice>`;
  await drop(page, 'factuur.xml', ubl, 'application/xml');
  await expect(page.getByText(`Factuur ${prev}-0077 Van Dijk Bouw`)).toBeVisible();
  await expect(page.getByText(/Samen: .*605,00/)).toBeVisible();
  noApiErrors(problems);
});

test('overstapper: auditfile (XAF) uit het vorige programma inlezen', async ({ page, problems }) => {
  await onboard(page, { overstap: true });
  await chapter(page, 'Uit je vorige programma');
  await drop(page, 'export.xaf', otherPackage(year), 'application/xml');
  await expect(page.getByRole('heading', { name: 'Wat de app overneemt' })).toBeVisible();
  await expect(page.getByText(`Factuur ${prev}-050 Bakker Bouw`)).toBeVisible();
  // niet herkend staat standaard uit
  await expect(page.getByRole('checkbox', { name: /Diversen/ })).not.toBeChecked();
  await page.getByRole('button', { name: 'Overnemen' }).click();
  await expect(page.getByText(/onderdelen overgenomen uit je vorige programma/)).toBeVisible();
  await expect(page.locator('.chips button', { hasText: 'Uit je vorige programma' })).toHaveText(/^✓ /);

  await chapter(page, 'Je startpositie');
  await expect(equity(page).getByText(/12\.910,00/)).toBeVisible();
  // Diversen niet overgenomen: het verschil met de vorige administratie wordt gemeld
  await expect(page.getByText(/Verschil met je vorige administratie: .*100,00/)).toBeVisible();
  noApiErrors(problems);
});

test('overstapper: kolommenbalans (Excel) uit DigiBoox inlezen', async ({ page, problems }) => {
  await onboard(page, { overstap: true });
  await chapter(page, 'Uit je vorige programma');
  await drop(page, 'kolommenbalans.xlsx', kolommenbalans(year), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  await expect(page.getByText(/alleen saldi/)).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Bestelbus' })).toBeChecked();
  // kruisposten zijn verdacht: standaard uit
  await expect(page.getByRole('checkbox', { name: /Kruisposten/ })).not.toBeChecked();
  await page.getByRole('checkbox', { name: /Kruisposten/ }).check();
  await page.getByRole('button', { name: 'Overnemen' }).click();
  await chapter(page, 'Je startpositie');
  await expect(equity(page).getByText(/2\.500,00/)).toBeVisible();
  noApiErrors(problems);
});

test('overstapper: saldibalans (CSV) inlezen', async ({ page, problems }) => {
  await onboard(page, { overstap: true });
  await chapter(page, 'Uit je vorige programma');
  const csv = [
    `Proef- en saldibalans per 31-12-${prev}`,
    'Rekening;Omschrijving;Saldo',
    '0100;Bestelbus;5.000,00',
    '0110;Afschrijving bestelbus;-2.000,00',
    '0500;Eigen vermogen;-3.400,00',
    '1002;Bank Knab;1.500,00',
    '1400;Crediteuren;-1.000,00',
    '1800;Te betalen btw;-100,00',
  ].join('\r\n');
  await drop(page, 'saldibalans.csv', csv, 'text/csv');
  await expect(page.getByRole('heading', { name: 'Wat de app overneemt' })).toBeVisible();
  await expect(page.getByText(`31 december ${prev}`).first()).toBeVisible();
  await page.getByRole('button', { name: 'Overnemen' }).click();
  await expect(page.getByText(/onderdelen overgenomen uit je vorige programma/)).toBeVisible();

  // alleen een totaal voor leveranciers: de app wijst op de lijst met losse rekeningen
  await chapter(page, 'Rekeningen die jij nog moet betalen');
  await page.getByRole('button', { name: 'Lijst inlezen' }).click();
  await expect(page.getByRole('heading', { name: 'Uit je vorige programma' })).toBeVisible();

  await chapter(page, 'Je startpositie');
  await expect(equity(page).getByText(/3\.400,00/)).toBeVisible();
  noApiErrors(problems);
});

test('overstapper: lijst met openstaande facturen (CSV) inlezen', async ({ page, problems }) => {
  await onboard(page, { overstap: true });
  await chapter(page, 'Uit je vorige programma');
  const csv = `Naam;Soort;Factuurnummer;Datum;Bedrag\r\nBakker Bouw;klant;${prev}-042;15-12-${prev};1210,00\r\nGamma;leverancier;F-7781;20-12-${prev};363,00\r\n`;
  await drop(page, 'openstaand.csv', csv, 'text/csv');
  await expect(page.getByRole('checkbox', { name: `Factuur ${prev}-042 Bakker Bouw` })).toBeChecked();
  await expect(page.getByText(/Samen .*1\.210,00 wat klanten nog moesten betalen/)).toBeVisible();
  await page.getByRole('button', { name: 'Overnemen' }).click();
  await expect(page.getByText(/onderdelen overgenomen uit je vorige programma/)).toBeVisible();
  await nav(page, 'Werk & facturen');
  await expect(page.getByText(`${prev}-042`).first()).toBeVisible();
  noApiErrors(problems);
});

test('overstapper: onbekende kolommen, één vraag en de keuze wordt onthouden', async ({ page, problems }) => {
  await onboard(page, { overstap: true });
  await chapter(page, 'Uit je vorige programma');
  // het voorbeeldbestand downloaden werkt
  await page.getByRole('link', { name: 'Download het voorbeeldbestand' }).click();

  const csv = `Wie;Factuur;Openstaand\r\nBakker Bouw;${prev}-042;1210,00\r\n`;
  await drop(page, 'export.csv', csv, 'text/csv');
  const ask = page.locator('.card', { hasText: 'Nog even kiezen' });
  await expect(ask).toBeVisible();
  await expect(ask.getByRole('button', { name: 'Verder' })).toBeDisabled();
  await ask.locator('select').first().selectOption({ label: 'Wie (bv. Bakker Bouw)' });
  await expect(ask.getByRole('button', { name: 'Verder' })).toBeEnabled();
  // toch een ander bestand: de keuze van het vorige bestand geldt daar niet
  await drop(page, 'ander.csv', `Persoon;Factuur;Openstaand\r\nGamma;F-1;10,00\r\n`, 'text/csv');
  await expect(ask.locator('select').first().locator('option', { hasText: 'Persoon' })).toHaveCount(1);
  await expect(ask.getByRole('button', { name: 'Verder' })).toBeDisabled();
  await drop(page, 'export.csv', csv, 'text/csv');
  await ask.locator('select').first().selectOption({ label: 'Wie (bv. Bakker Bouw)' });
  await ask.getByRole('button', { name: 'Verder' }).click();
  await expect(page.getByRole('checkbox', { name: `Factuur ${prev}-042 Bakker Bouw` })).toBeChecked();
  await page.getByRole('button', { name: 'Overnemen' }).click();
  await expect(page.getByText(/onderdelen overgenomen uit je vorige programma/)).toBeVisible();

  // hetzelfde soort bestand nog eens: meteen het voorstel
  await drop(page, 'export2.csv', csv, 'text/csv');
  await expect(page.getByRole('heading', { name: 'Wat de app overneemt' })).toBeVisible();
  await expect(page.locator('.card', { hasText: 'Nog even kiezen' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Annuleren' }).click();

  // iets wat de app niet kan lezen: een duidelijke melding
  await drop(page, 'raar.csv', 'a;b\r\n1;2\r\n', 'text/csv');
  // (het woord "voorbeeldbestand" staat al in de downloadlink: wacht op de melding zelf)
  await expect(page.getByText(/Dit bestand herkennen we niet/)).toBeVisible();
  await expect.poll(() => problems.apiErrors.map((e) => e.error)).toEqual([expect.stringMatching(/voorbeeldbestand/)]);
});

test('overstapper zonder programma: zelf invullen, "had ik niet" en een rekening die je niet gebruikt', async ({ page, problems }) => {
  await onboard(page, { overstap: true });
  await expect(page.getByText(/0 van \d+ klaar/)).toBeVisible();
  // route kiezen: zelf invullen slaat het inlezen over en gaat naar de bank
  await page.getByRole('button', { name: /Ik vul het zelf in/ }).click();
  await expect(page.getByRole('heading', { name: 'Bankrekeningen' })).toBeVisible();
  await expect(page.locator('.chips button', { hasText: 'Uit je vorige programma' })).toHaveText(/^✓ /);
  await expect(page.locator('.chips button', { hasText: 'Hoe stap je over?' })).toHaveText(/^✓ /);

  // de rekening van het instellen gebruik je niet meer: beginsaldo 0, geen afschriften nodig
  await page.getByRole('button', { name: 'Deze rekening gebruik ik niet' }).click();
  await expect(page.getByText(/gebruik je niet \(beginsaldo € 0\)/)).toBeVisible();
  await expect(page.locator('.chips button', { hasText: 'Bankrekeningen' })).toHaveText(/^✓ /);
  await page.getByRole('button', { name: 'Toch gebruiken' }).click();
  await expect(page.getByRole('button', { name: 'Deze rekening gebruik ik niet' })).toBeVisible();
  await page.getByRole('button', { name: 'Deze rekening gebruik ik niet' }).click();

  // lege hoofdstukken afvinken; "verder" springt naar wat nog open staat
  await chapter(page, 'Klanten die nog moeten betalen');
  await page.getByRole('button', { name: 'Er stond niets open' }).click();
  await expect(page.getByRole('heading', { name: 'Rekeningen die jij nog moest betalen' })).toBeVisible();
  await expect(page.locator('.chips button', { hasText: 'Klanten die nog moeten betalen' })).toHaveText(/^✓ /);
  await page.getByRole('button', { name: 'Er stond niets open' }).click();
  await expect(page.getByRole('heading', { name: 'Bus, auto en gereedschap' })).toBeVisible();
  await page.getByRole('button', { name: 'Heb ik niet' }).click();
  await expect(page.getByRole('heading', { name: 'Btw', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Alles was al betaald' }).click();
  await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
  await chapter(page, 'Leningen en overig');
  await page.getByRole('button', { name: 'Heb ik niet' }).click();
  await expect(page.getByRole('heading', { name: /Je startpositie/ })).toBeVisible();
  await expect(page.getByText(/\d+ van \d+ klaar/)).toBeVisible();
  await expect(page.getByText('✓ Alles klopt.')).toBeVisible();
  await page.getByRole('button', { name: 'Klopt, zet klaar' }).click();
  await expect(page.getByText('Alles klaar ✓')).toBeVisible();
  noApiErrors(problems);
});
