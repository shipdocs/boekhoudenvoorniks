import { randomBytes, createHash } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, onboard, nav, call } from './fixtures';
import { makeJpeg } from '../tests/fixtures/jpeg';
import { CONTENT_TYPE, ENDPOINT_PATH, decodePairing, encodeFrame, openResponse, sealRequest } from '../src/scanner/protocol';

/**
 * De foto's van de telefoon bij een klus. De test meldt zich als telefoon met echte, versleutelde verzoeken
 * (protocol versie 2) bij het ontvangstpunt van de testserver, net als bonnenscanner.spec.ts: de koppeling loopt via
 * de echte api (scanner.pair), de foto's via de echte FotoOntvangst. Er is geen hulproute voor nodig.
 */
const DAG = 24 * 60 * 60 * 1000;

async function koppel(page: Page, request: APIRequestContext) {
  await call(page, 'scanner.pair');
  const payload = ((await (await request.post('/__scanner', { data: {} })).json()) as { ok: { payload: string } }).ok.payload;
  const p = decodePairing(payload);
  const sleutel = Buffer.from(p.sleutel, 'base64url');
  const deviceId = Buffer.from(p.apparaat, 'base64url');
  const stuur = async (json: Record<string, unknown>, bijlagen: Buffer[] = []) => {
    const nonce = randomBytes(12);
    const body = sealRequest(deviceId, sleutel, encodeFrame({ tijd: Date.now(), ...json }, bijlagen), nonce, 2);
    const res = await fetch(`http://${p.adressen[0]}:${p.poort}${ENDPOINT_PATH}`, { method: 'POST', headers: { 'content-type': CONTENT_TYPE }, body: new Uint8Array(body) });
    return openResponse(Buffer.from(await res.arrayBuffer()), sleutel, nonce);
  };
  expect(await stuur({ soort: 'hallo', naam: 'Pixel van Piet', app: '1.0.0' })).toMatchObject({ ok: true });
  let teller = 0;
  /** een fotowijziging bij een project (klus), met de sha256 van elke foto */
  const foto = async (projectUuid: string, fotos: Buffer[], notitie: string | undefined, tijd: number) => {
    const uuid = `00000000-0000-4000-8000-${String(++teller).padStart(12, '0')}`;
    const velden = { project_uuid: projectUuid, ...(notitie ? { notitie } : {}), fotos: fotos.map((f) => ({ grootte: f.length, sha256: createHash('sha256').update(f).digest('hex') })) };
    const r = await stuur({ soort: 'wijziging', wijziging: { entiteit: 'foto', uuid, revisie: 1, tijd, velden } }, fotos);
    expect(r).toMatchObject({ ok: true, entiteit: 'foto', uitkomst: 'toegepast' });
  };
  return { foto };
}

async function nieuweKlus(page: Page, titel: string) {
  const klant = await call<{ id: number }>(page, 'relations.create', { name: `Klant ${titel}`, email: 'klant@example.nl', address: 'Markt 1', postcode: '1000 AA', city: 'Amsterdam' });
  const klus = await call<{ id: number; uuid: string }>(page, 'jobs.create', { relationId: klant.id, title: titel });
  expect(klus.uuid).toMatch(/^[0-9a-f-]{36}$/);
  return klus;
}

async function openKlus(page: Page, titel: string) {
  await nav(page, 'Klussen');
  await page.locator('.card.clickable', { hasText: titel }).click();
  await expect(page.getByRole('heading', { name: titel, level: 1 })).toBeVisible();
}

test('foto\'s van de telefoon staan bij de klus: voorbeelden, een grote weergave, geen knop om te wijzigen of te verwijderen', async ({ page, request }) => {
  await request.post('/__reset', { data: { phoneScanner: true } });
  await onboard(page);
  const klus = await nieuweKlus(page, 'Stucwerk woonkamer');
  const andere = await nieuweKlus(page, 'Schuur schilderen');
  const telefoon = await koppel(page, request);
  const nu = Date.now();
  await telefoon.foto(klus.uuid, [makeJpeg('voor')], 'Voor het stucen', nu - 3 * DAG);
  await telefoon.foto(klus.uuid, [makeJpeg('na-1'), makeJpeg('na-2')], 'Na het stucen', nu - 2 * DAG);
  await telefoon.foto(andere.uuid, [makeJpeg('schuur')], 'Alleen bij de schuur', nu - DAG);

  await openKlus(page, 'Stucwerk woonkamer');
  const sectie = page.getByRole('region', { name: 'Foto\'s van de telefoon' });
  await expect(sectie.getByRole('heading', { name: 'Foto\'s van de telefoon' })).toBeVisible();
  await expect(sectie.getByText('3 foto\'s')).toBeVisible();
  const tegels = sectie.getByRole('button', { name: /^Foto vergroten/ });
  await expect(tegels).toHaveCount(3);
  // de voorbeelden komen binnen (eerst "Laden…") met de notitie als alt-tekst
  const voor = sectie.getByRole('img', { name: 'Voor het stucen' });
  await expect(voor).toBeVisible();
  await expect.poll(() => voor.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  await expect(sectie.getByRole('img', { name: 'Na het stucen' })).toHaveCount(2);
  await expect(sectie.getByText('Alleen bij de schuur')).toHaveCount(0);

  // een grote weergave in een dialoog: focus op "Sluiten", alt-tekst, geen knop om te wijzigen of weg te halen
  await tegels.first().click();
  const dlg = page.getByRole('dialog', { name: 'Foto van de telefoon' });
  await expect(dlg).toBeVisible();
  const groot = dlg.getByRole('img', { name: 'Voor het stucen' });
  await expect(groot).toBeVisible();
  await expect.poll(() => groot.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  await expect(dlg.getByRole('button', { name: 'Sluiten', exact: true })).toBeFocused();
  await expect(sectie.getByRole('button', { name: /verwijder|wijzig|bewerk|delete|edit/i })).toHaveCount(0);
  await expect(dlg.getByRole('button', { name: /verwijder|wijzig|bewerk|delete|edit/i })).toHaveCount(0);
  const axe = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
  expect(axe.violations.filter((v) => v.impact === 'critical').map((v) => v.id)).toEqual([]);

  // Escape sluit; de focus gaat terug naar de tegel
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  await expect(tegels.first()).toBeFocused();

  // en met de knop "Sluiten"
  await tegels.nth(1).click();
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Sluiten', exact: true }).click();
  await expect(dlg).toBeHidden();
});

test('een klus zonder foto\'s toont geen fotosectie en er gaat niets mis', async ({ page, request }) => {
  await request.post('/__reset', { data: { phoneScanner: true } });
  await onboard(page);
  await nieuweKlus(page, 'Dakgoot vervangen');
  await openKlus(page, 'Dakgoot vervangen');
  await expect(page.getByRole('heading', { name: 'Werk afgerond?' })).toBeVisible();
  await expect(page.getByText('Foto\'s van de telefoon')).toHaveCount(0);
  await expect(page.locator('main .notice.bad')).toHaveCount(0);
});
