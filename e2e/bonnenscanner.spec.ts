import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jsQR from 'jsqr';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, onboard, nav, call, emit } from './fixtures';
import { makeJpeg } from '../tests/fixtures/jpeg';
import { CONTENT_TYPE, ENDPOINT_PATH, decodePairing, encodeFrame, openResponse, sealRequest, type PairingPayload } from '../src/scanner/protocol';

/**
 * Telefoon koppelen staat in de app nog uit (shared/phone-scanner.ts, tot de Android-app er is). De
 * tests van het koppelen zetten het zelf aan; zonder `phone` is het scherm zoals een gebruiker het nu ziet.
 */
async function openScannerSettings(page: Page, phone = false) {
  await nav(page, 'Instellingen');
  await page.locator('main .chips').first().getByRole('button', { name: phone ? 'Telefoon & bonnenmap' : 'Bonnenmap', exact: true }).click();
  await expect(page.getByRole('heading', { name: phone ? 'Telefoon koppelen' : 'Bonnenmap' })).toBeVisible();
}

/** De QR-code op het scherm lezen, zoals de camera van de telefoon dat doet. */
async function scanQr(page: Page): Promise<string> {
  const img = page.getByAltText('QR-code om je telefoon te koppelen');
  await expect(img).toBeVisible();
  const pixels = await img.evaluate(async (el: HTMLImageElement) => {
    if (!el.complete) await new Promise((r) => el.addEventListener('load', r, { once: true }));
    const size = 560;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(el, 0, 0, size, size);
    return { size, data: Array.from(ctx.getImageData(0, 0, size, size).data) };
  });
  const found = jsQR(new Uint8ClampedArray(pixels.data), pixels.size, pixels.size);
  expect(found, 'de QR-code is leesbaar').not.toBeNull();
  return found!.data;
}

/** De telefoon: echte versleutelde verzoeken naar het ontvangstpunt van de testserver. */
function phone(p: PairingPayload) {
  const key = Buffer.from(p.sleutel, 'base64url');
  const deviceId = Buffer.from(p.apparaat, 'base64url');
  return async (json: Record<string, unknown>, photos: Buffer[] = []) => {
    const nonce = randomBytes(12);
    const body = sealRequest(deviceId, key, encodeFrame({ tijd: Date.now(), ...json }, photos), nonce);
    const res = await fetch(`http://${p.adressen[0]}:${p.poort}${ENDPOINT_PATH}`, { method: 'POST', headers: { 'content-type': CONTENT_TYPE }, body: new Uint8Array(body) });
    const raw = Buffer.from(await res.arrayBuffer());
    return { status: res.status, json: res.headers.get('content-type') === CONTENT_TYPE ? openResponse(raw, key, nonce) : (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) };
  };
}

async function lastPayload(request: APIRequestContext): Promise<string> {
  return ((await (await request.post('/__scanner', { data: {} })).json()) as { ok: { payload: string } }).ok.payload;
}

test('telefoon koppelen met de QR-code, een bon ontvangen en weer ontkoppelen', async ({ page, request }) => {
  await request.post('/__reset', { data: { phoneScanner: true } });
  await onboard(page);
  await openScannerSettings(page, true);
  await expect(page.getByText('Ontvangen staat uit: er is geen telefoon gekoppeld.')).toBeVisible();

  await page.getByRole('button', { name: 'Telefoon koppelen' }).click();
  const dlg = page.getByRole('dialog', { name: 'Telefoon koppelen' });
  await expect(dlg.getByText('Scan deze code.')).toBeVisible();
  // wat de camera leest is precies wat de app bedoelde
  const scanned = await scanQr(page);
  expect(scanned).toBe(await lastPayload(request));
  const pairing = decodePairing(scanned);
  expect(Buffer.from(pairing.sleutel, 'base64url')).toHaveLength(32);
  const send = phone(pairing);

  // de telefoon meldt zich: het venster sluit vanzelf en de telefoon staat in de lijst
  expect((await send({ soort: 'hallo', naam: 'Pixel van Piet', app: '1.0.0' })).json).toMatchObject({ ok: true });
  await expect(dlg).toBeHidden();
  await expect(page.getByText('Pixel van Piet is gekoppeld ✓')).toBeVisible();
  const row = page.locator('table.list tbody tr', { hasText: 'Pixel van Piet' });
  await expect(row).toContainText('vandaag');
  await expect(page.getByText(/Ontvangen staat aan, alleen op je eigen netwerk \(127\.0\.0\.1, poort \d+\)/)).toBeVisible();

  // een bon van de telefoon: contant betaald, met een notitie
  const id = randomUUID();
  const photo = makeJpeg('e2e');
  const bon = { soort: 'bon', id, betaalwijze: 'contant', notitie: 'Schroeven voor de klus bij Jansen', fotos: [{ grootte: photo.length }] };
  expect((await send(bon, [photo])).json).toMatchObject({ ok: true, id, al: false });
  // nog een keer versturen (de telefoon kreeg de bevestiging niet): er komt er geen bij
  expect((await send(bon, [photo])).json).toMatchObject({ ok: true, id, al: true });

  await nav(page, 'Aankopen & bonnetjes');
  const doc = page.getByText(/bon-telefoon-.*\.jpg/);
  await expect(doc).toHaveCount(1);
  await page.getByRole('button', { name: 'Bekijken' }).click();
  await expect(page.getByText('Notitie van je telefoon:')).toBeVisible();
  await expect(page.getByText('Schroeven voor de klus bij Jansen')).toBeVisible();
  // de betaalwijze van de telefoon is het voorstel
  await expect(page.locator('label.field', { hasText: 'Hoe betaald?' }).locator('.chips button.selected')).toHaveText('Contant');

  // ontkoppelen: de sleutel is ingetrokken en er luistert niets meer
  await openScannerSettings(page, true);
  page.once('dialog', (d) => void d.accept());
  await page.locator('table.list tbody tr', { hasText: 'Pixel van Piet' }).getByRole('button', { name: 'Ontkoppelen' }).click();
  await expect(page.getByText('Ontvangen staat uit: er is geen telefoon gekoppeld.')).toBeVisible();
  await expect(page.locator('table.list tbody tr', { hasText: 'Pixel van Piet' })).toHaveCount(0);
  await expect(send({ soort: 'hallo', naam: 'Pixel van Piet' })).rejects.toThrow();
});

test('de QR-code sluiten zonder te scannen zet het ontvangen weer uit', async ({ page, request }) => {
  await request.post('/__reset', { data: { phoneScanner: true } });
  await onboard(page);
  await openScannerSettings(page, true);
  await page.getByRole('button', { name: 'Telefoon koppelen' }).click();
  const dlg = page.getByRole('dialog', { name: 'Telefoon koppelen' });
  await expect(dlg.getByAltText('QR-code om je telefoon te koppelen')).toBeVisible();
  const send = phone(decodePairing(await lastPayload(request)));
  await dlg.getByRole('button', { name: 'Annuleren' }).click();
  await expect(dlg).toBeHidden();
  await expect(page.getByText('Ontvangen staat uit: er is geen telefoon gekoppeld.')).toBeVisible();
  // de sleutel uit de gesloten QR-code werkt niet meer
  await expect(send({ soort: 'hallo', naam: 'Te laat' })).rejects.toThrow();
});

test('Windows: de eerste keer uitleg over de melding van de firewall', async ({ page, request }) => {
  await request.post('/__reset', { data: { scannerPlatform: 'win32', phoneScanner: true } });
  await onboard(page);
  await openScannerSettings(page, true);
  await page.getByRole('button', { name: 'Telefoon koppelen' }).click();
  const hint = page.getByRole('dialog', { name: 'Eerst even dit' });
  await expect(hint.getByText('Klik op "Toestaan" bij de melding van Windows.')).toBeVisible();
  // nog niets aangezet zolang de uitleg er staat
  await expect(page.getByText('Ontvangen staat uit: er is geen telefoon gekoppeld.')).toBeVisible();
  await hint.getByRole('button', { name: 'Verder' }).click();
  const dlg = page.getByRole('dialog', { name: 'Telefoon koppelen' });
  await expect(dlg.getByAltText('QR-code om je telefoon te koppelen')).toBeVisible();
  await dlg.getByRole('button', { name: 'Annuleren' }).click();
  // de tweede keer meteen de QR-code
  await page.getByRole('button', { name: 'Telefoon koppelen' }).click();
  await expect(page.getByRole('dialog', { name: 'Telefoon koppelen' }).getByAltText('QR-code om je telefoon te koppelen')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Eerst even dit' })).toHaveCount(0);
});

test('bonnenmap: een bestand in de map staat binnen 10 seconden in de inbox en gaat naar verwerkt/', async ({ page, request }) => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'bvn-e2e-bonnen-')));
  try {
    await onboard(page);
    await openScannerSettings(page);
    await expect(page.getByText('Er is geen bonnenmap gekozen.')).toBeVisible();
    await request.post('/__scanner', { data: { folder } });
    await page.getByRole('button', { name: 'Map kiezen…' }).click();
    await expect(page.getByText(folder)).toBeVisible();

    writeFileSync(join(folder, 'tankbon.jpg'), makeJpeg('bonnenmap'));
    writeFileSync(join(folder, 'notitie.txt'), 'geen bon');
    await expect(page.getByText(/1 bestand opgehaald sinds de app open is\. Laatste: tankbon\.jpg/)).toBeVisible({ timeout: 10_000 });
    expect(readdirSync(folder).sort()).toEqual(['notitie.txt', 'verwerkt']);
    expect(readdirSync(join(folder, 'verwerkt'))).toEqual(['tankbon.jpg']);

    await nav(page, 'Aankopen & bonnetjes');
    await expect(page.getByText('tankbon.jpg')).toHaveCount(1);

    // stoppen: de app kijkt niet meer in de map
    await openScannerSettings(page);
    await page.getByRole('button', { name: 'Stoppen met deze map' }).click();
    await expect(page.getByText('Er is geen bonnenmap gekozen.')).toBeVisible();
    writeFileSync(join(folder, 'later.jpg'), makeJpeg('later'));
    await page.waitForTimeout(6_500);
    expect(existsSync(join(folder, 'later.jpg'))).toBe(true);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('een bon staat er meteen, ook als het lezen lang duurt: eerst "Wordt gelezen…", daarna de gelezen gegevens', async ({ page, request }) => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'bvn-e2e-bonnen-')));
  try {
    await onboard(page);
    await request.post('/__ocr', { data: { traag: true } });
    await openScannerSettings(page);
    await request.post('/__scanner', { data: { folder } });
    await page.getByRole('button', { name: 'Map kiezen…' }).click();
    writeFileSync(join(folder, 'eerste.jpg'), makeJpeg('eerste bon'));
    await expect(page.getByText(/1 bestand opgehaald sinds de app open is/)).toBeVisible({ timeout: 10_000 });
    writeFileSync(join(folder, 'tweede.jpg'), makeJpeg('tweede bon'));
    // de tweede bon is binnen zonder dat de eerste gelezen is
    await expect(page.getByText(/2 bestanden opgehaald sinds de app open is/)).toBeVisible({ timeout: 10_000 });

    await nav(page, 'Aankopen & bonnetjes');
    const rij = (naam: string) => page.locator('.task', { hasText: naam });
    await expect(rij('eerste.jpg').getByTestId('leesstand')).toHaveText('Wordt gelezen…');
    await expect(rij('eerste.jpg')).toContainText('Deze bon wordt nu gelezen.');
    await expect(rij('tweede.jpg').getByTestId('leesstand')).toHaveText('Wacht op lezen');
    await expect(rij('tweede.jpg')).toContainText('Deze bon wacht op lezen.');
    // ook op Vandaag
    await nav(page, 'Vandaag');
    await expect(page.getByText('Deze bon wordt nu gelezen.')).toBeVisible();

    // de bon openen terwijl hij gelezen wordt: de stand staat erbij, zelf invullen kan
    await nav(page, 'Aankopen & bonnetjes');
    await rij('eerste.jpg').getByRole('button', { name: 'Bekijken' }).click();
    await expect(page.getByTestId('wordt-gelezen')).toContainText('Deze bon wordt nu gelezen.');
    await expect(page.getByTestId('leesstand')).toHaveText('Wordt gelezen…');
    await expect(page.getByRole('button', { name: 'Nu lezen' })).toHaveCount(0);

    // het lezen is klaar: de gegevens staan bij de bon
    const vandaag = new Date().toLocaleDateString('nl-NL', { timeZone: 'Europe/Amsterdam', day: '2-digit', month: '2-digit', year: 'numeric' });
    await request.post('/__ocr', { data: { klaar: ['Bouwmaat Utrecht', `Datum: ${vandaag}`, 'Gips 121,00', 'Totaal 121,00'] } });
    // de bon staat nog open en er is niets ingevuld: de gelezen gegevens komen vanzelf in het formulier
    const gelezen = (naam: string) => expect.poll(async () => (await call<{ original_name: string; extraction_source: string }[]>(page, 'documents.list')).find((x) => x.original_name === naam)?.extraction_source).toBe('ocr:traag');
    await gelezen('eerste.jpg');
    await emit(page, 'auto-processed');
    await expect(page.getByTestId('leesstand')).toHaveText('Gelezen door traag');
    await expect(page.getByLabel('Winkel / leverancier')).toHaveValue('Bouwmaat');
    await expect(page.getByLabel('Totaal (incl. btw)')).toHaveValue('121,00');
    await expect(page.getByTestId('intussen-gelezen')).toHaveCount(0);
    await nav(page, 'Aankopen & bonnetjes');
    await expect(rij('Bouwmaat')).toContainText('121,00');
    await expect(rij('Bouwmaat').getByTestId('leesstand')).toHaveCount(0);
    await expect(rij('tweede.jpg').getByTestId('leesstand')).toHaveText('Wordt gelezen…');

    // de tweede bon openen; het lezen is klaar, en terwijl het scherm de gelezen gegevens ophaalt begint de
    // gebruiker met invullen: zijn invoer blijft staan
    await rij('tweede.jpg').getByRole('button', { name: 'Bekijken' }).click();
    await expect(page.getByTestId('leesstand')).toHaveText('Wordt gelezen…');
    await request.post('/__ocr', { data: { klaar: ['Hornbach Zwolle', `Datum: ${vandaag}`, 'Kit 55,00', 'Totaal 55,00'] } });
    await gelezen('tweede.jpg');
    let traag = true;
    let onderweg: () => void = () => undefined;
    const opgevraagd = new Promise<void>((r) => (onderweg = r));
    await page.route('**/api', async (route) => {
      if (traag && (JSON.parse(route.request().postData() ?? '{}') as { method?: string }).method === 'documents.open') {
        onderweg();
        await new Promise((r) => setTimeout(r, 1_500));
      }
      await route.continue();
    });
    await emit(page, 'auto-processed');
    await opgevraagd;
    await page.getByLabel('Winkel / leverancier').fill('Zelf ingevuld');
    await expect(page.getByTestId('intussen-gelezen')).toContainText('Wat je zelf hebt ingevuld is blijven staan.');
    traag = false;
    await expect(page.getByLabel('Winkel / leverancier')).toHaveValue('Zelf ingevuld');
    await expect(page.getByTestId('leesstand')).toHaveText('Gelezen door traag');
    // op verzoek alsnog de gelezen gegevens
    await page.getByRole('button', { name: 'Gelezen gegevens tonen' }).click();
    await expect(page.getByLabel('Winkel / leverancier')).toHaveValue('Hornbach');
    await expect(page.getByLabel('Totaal (incl. btw)')).toHaveValue('55,00');
    await expect(page.getByTestId('intussen-gelezen')).toHaveCount(0);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('zoals de app nu is: alleen de bonnenmap, telefoon koppelen is nergens te vinden en de api weigert het', async ({ page }) => {
  await onboard(page);
  await nav(page, 'Instellingen');
  await expect(page.locator('main .chips').first().getByRole('button', { name: /[Tt]elefoon/ })).toHaveCount(0);
  await openScannerSettings(page);
  await expect(page.getByText('Er is geen bonnenmap gekozen.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Map kiezen…' })).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Telefoon koppelen' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Telefoon koppelen' })).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText(/QR|koppelen|Ontvangen staat/);
  // ook rechtstreeks via de api: koppelen wordt geweigerd en er gaat niets luisteren
  await expect(call(page, 'scanner.pair')).rejects.toThrow(/kan nog niet/);
  const status = await call<{ running: boolean; port: number | null; phoneAvailable: boolean; devices: unknown[] }>(page, 'scanner.status');
  expect(status).toMatchObject({ running: false, port: null, phoneAvailable: false, devices: [] });
});

test('in de demo is koppelen en de bonnenmap uitgeschakeld, met uitleg', async ({ page, request }) => {
  await request.post('/__reset', { data: { phoneScanner: true } });
  await page.goto('/');
  await page.getByRole('button', { name: /Bekijk de demo/ }).click();
  await expect(page.getByText('Je bekijkt de demo.')).toBeVisible();
  const terms = page.getByRole('dialog', { name: 'Gebruiksvoorwaarden' });
  if (await terms.isVisible({ timeout: 4000 }).catch(() => false)) {
    for (const cb of await terms.locator('input[type=checkbox]').all()) await cb.check();
    await terms.getByRole('button', { name: 'Akkoord' }).click();
  }
  await openScannerSettings(page, true);
  await expect(page.getByText('In de demo kun je geen telefoon koppelen en geen bonnenmap gebruiken.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Telefoon koppelen' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Map kiezen…' })).toBeDisabled();
});

test('telefoon en abonnement: zonder abonnement staat de uitleg er en geeft koppelen de melding; na het afsluiten koppelt de app meteen', async ({ page, request }) => {
  // licenties aan (met de nagebootste licentie-Worker van e2e/server.cjs) en telefoon koppelen aan
  await request.post('/__reset', { data: { phoneScanner: true, licenses: true } });
  await onboard(page);
  await openScannerSettings(page, true);
  const uitleg = page.getByTestId('telefoon-abonnement');
  await expect(uitleg.getByText(/Een nieuwe telefoon koppelen en het bijwerken van klanten, projecten en btw-regels op je telefoon horen bij het abonnement\./)).toBeVisible();
  await expect(uitleg.getByText(/Wat een gekoppelde telefoon stuurt \(bonnen, foto's, klanten, projecten en facturen\), komt altijd aan\./)).toBeVisible();
  // de bonnenmap staat hier los van
  await expect(page.getByRole('button', { name: 'Map kiezen…' })).toBeEnabled();

  // koppelen geeft de melding: geen QR-code en er gaat niets luisteren
  await page.getByRole('button', { name: 'Telefoon koppelen' }).click();
  await expect(page.locator('.toasts').getByText(/horen bij het abonnement.*komt altijd aan/)).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Telefoon koppelen' })).toHaveCount(0);
  await expect(page.getByText('Ontvangen staat uit: er is geen telefoon gekoppeld.')).toBeVisible();

  // de knop gaat naar het abonnement, dat daar ook zonder gekoppelde boekhouder staat
  await uitleg.getByRole('button', { name: 'Naar het abonnement' }).click();
  await expect(page.getByRole('heading', { name: 'Hoe gaat het?' })).toBeVisible();
  const abonnement = page.getByTestId('uitwisseling').getByTestId('abonnement');
  await expect(abonnement).toBeVisible();
  await abonnement.getByRole('checkbox', { name: /Ik sluit dit abonnement af voor mijn bedrijf/ }).check();
  await abonnement.getByRole('button', { name: '4 maanden gratis beginnen' }).click();
  await expect(page.locator('.toasts').getByText('De betaalpagina is geopend in je browser')).toBeVisible();
  await request.post('/__pay');

  // net betaald: Telefoon koppelen haalt eerst de licentie op en koppelt dan gewoon
  await openScannerSettings(page, true);
  await page.getByRole('button', { name: 'Telefoon koppelen' }).click();
  const dlg = page.getByRole('dialog', { name: 'Telefoon koppelen' });
  await expect(dlg.getByAltText('QR-code om je telefoon te koppelen')).toBeVisible();
  await dlg.getByRole('button', { name: 'Annuleren' }).click();
  await expect(page.getByTestId('telefoon-abonnement')).toHaveCount(0);
});

test('abonnement zonder telefoon koppelen: zolang koppelen uit staat is er in de instellingen niets van te zien', async ({ page, request }) => {
  await request.post('/__reset', { data: { licenses: true } });
  await onboard(page);
  await openScannerSettings(page);
  await expect(page.getByTestId('telefoon-abonnement')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText(/abonnement|koppelen/i);
  // zonder verwijzing staat het abonnement op Hoe gaat het? alleen bij een gekoppelde boekhouder, zoals altijd
  await nav(page, 'Hoe gaat het?');
  await expect(page.getByTestId('uitwisseling')).toBeVisible();
  await expect(page.getByTestId('abonnement')).toHaveCount(0);
});

test('Windows, net betaald: Telefoon koppelen haalt de licentie op en toont eerst de uitleg over de firewall, voordat er iets gaat luisteren', async ({ page, request }) => {
  await request.post('/__reset', { data: { scannerPlatform: 'win32', phoneScanner: true, licenses: true } });
  await onboard(page);
  await openScannerSettings(page, true);
  const status = () => call<{ running: boolean; port: number | null; firewallHint: boolean; devices: unknown[]; abonnement: { toegestaan: boolean } }>(page, 'scanner.status');
  expect(await status()).toMatchObject({ running: false, firewallHint: true, devices: [], abonnement: { toegestaan: false } });

  // zonder abonnement: de melding, en geen uitleg over de firewall (er wordt niet gekoppeld)
  await page.getByRole('button', { name: 'Telefoon koppelen' }).click();
  await expect(page.locator('.toasts').getByText(/horen bij het abonnement.*komt altijd aan/)).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Eerst even dit' })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Telefoon koppelen' })).toHaveCount(0);

  // afsluiten en betalen; de app heeft de licentie nog niet opgehaald
  await page.getByTestId('telefoon-abonnement').getByRole('button', { name: 'Naar het abonnement' }).click();
  const abonnement = page.getByTestId('uitwisseling').getByTestId('abonnement');
  await abonnement.getByRole('checkbox', { name: /Ik sluit dit abonnement af voor mijn bedrijf/ }).check();
  await abonnement.getByRole('button', { name: '4 maanden gratis beginnen' }).click();
  await expect(page.locator('.toasts').getByText('De betaalpagina is geopend in je browser')).toBeVisible();
  await request.post('/__pay');
  await openScannerSettings(page, true);
  expect((await status()).abonnement.toegestaan).toBe(false);

  // Telefoon koppelen: de licentie komt binnen, en eerst staat de uitleg er. Er is nog geen QR-code en er luistert niets.
  await page.getByRole('button', { name: 'Telefoon koppelen' }).click();
  const uitleg = page.getByRole('dialog', { name: 'Eerst even dit' });
  await expect(uitleg.getByText('Klik op "Toestaan" bij de melding van Windows.')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Telefoon koppelen' })).toHaveCount(0);
  expect(await status()).toMatchObject({ running: false, port: null, firewallHint: true, devices: [], abonnement: { toegestaan: true } });
  await expect(page.getByTestId('telefoon-abonnement')).toHaveCount(0);

  // pas na Verder begint het koppelen
  await uitleg.getByRole('button', { name: 'Verder' }).click();
  const dlg = page.getByRole('dialog', { name: 'Telefoon koppelen' });
  await expect(dlg.getByAltText('QR-code om je telefoon te koppelen')).toBeVisible();
  expect(await status()).toMatchObject({ running: true, firewallHint: false, abonnement: { toegestaan: true } });
  await dlg.getByRole('button', { name: 'Annuleren' }).click();
});
