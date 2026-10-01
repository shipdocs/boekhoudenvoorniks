import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jsQR from 'jsqr';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, onboard, nav } from './fixtures';
import { makeJpeg } from '../tests/fixtures/jpeg';
import { CONTENT_TYPE, ENDPOINT_PATH, decodePairing, encodeFrame, openResponse, sealRequest, type PairingPayload } from '../src/scanner/protocol';

async function openScannerSettings(page: Page) {
  await nav(page, 'Instellingen');
  await page.locator('main .chips').first().getByRole('button', { name: 'Telefoon & bonnenmap' }).click();
  await expect(page.getByRole('heading', { name: 'Telefoon koppelen' })).toBeVisible();
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
  await onboard(page);
  await openScannerSettings(page);
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
  await openScannerSettings(page);
  page.once('dialog', (d) => void d.accept());
  await page.locator('table.list tbody tr', { hasText: 'Pixel van Piet' }).getByRole('button', { name: 'Ontkoppelen' }).click();
  await expect(page.getByText('Ontvangen staat uit: er is geen telefoon gekoppeld.')).toBeVisible();
  await expect(page.locator('table.list tbody tr', { hasText: 'Pixel van Piet' })).toHaveCount(0);
  await expect(send({ soort: 'hallo', naam: 'Pixel van Piet' })).rejects.toThrow();
});

test('de QR-code sluiten zonder te scannen zet het ontvangen weer uit', async ({ page, request }) => {
  await onboard(page);
  await openScannerSettings(page);
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
  await request.post('/__reset', { data: { scannerPlatform: 'win32' } });
  await onboard(page);
  await openScannerSettings(page);
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

test('in de demo is koppelen en de bonnenmap uitgeschakeld, met uitleg', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Bekijk de demo/ }).click();
  await expect(page.getByText('Je bekijkt de demo.')).toBeVisible();
  const terms = page.getByRole('dialog', { name: 'Gebruiksvoorwaarden' });
  if (await terms.isVisible({ timeout: 4000 }).catch(() => false)) {
    for (const cb of await terms.locator('input[type=checkbox]').all()) await cb.check();
    await terms.getByRole('button', { name: 'Akkoord' }).click();
  }
  await openScannerSettings(page);
  await expect(page.getByText('In de demo kun je geen telefoon koppelen en geen bonnenmap gebruiken.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Telefoon koppelen' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Map kiezen…' })).toBeDisabled();
});
