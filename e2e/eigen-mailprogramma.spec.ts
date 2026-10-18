import { test, expect, onboard, nav, call } from './fixtures';
import type { Page } from '@playwright/test';

/** Een factuur voor Familie Jansen, geopend in het verstuurvenster. Geen SMTP: dit gaat om het eigen mailprogramma (#450). */
async function openVerstuurvenster(page: Page) {
  await onboard(page);
  const klant = await call<{ id: number }>(page, 'relations.create', { name: 'Familie Jansen', email: 'jansen@example.nl', address: 'Dorpsstraat 5', postcode: '3511 AA', city: 'Utrecht' });
  const inv = await call<{ id: number }>(page, 'invoices.createDraft', {
    relationId: klant.id,
    invoiceDate: '2026-01-01',
    lines: [{ description: 'Stucwerk wanden', quantity: 1, unitPrice: 50000, vatCode: 'hoog' }],
  });
  await page.reload();
  await nav(page, 'Werk & facturen');
  await page.locator('tr', { hasText: 'Familie Jansen' }).first().click();
  await page.getByRole('button', { name: 'Versturen', exact: true }).click();
  return { id: inv.id, dialog: page.getByRole('dialog', { name: 'Factuur versturen' }) };
}

const sentAt = async (page: Page, id: number) => (await call<{ sent_at: string | null; reminder_count: number }>(page, 'invoices.get', id));
const ownMail = async (page: Page, mode?: string) => {
  const r = await page.request.post('/__ownmail', mode ? { data: { mode } } : {});
  return (await r.json()).ok as { to: string; subject: string; body: string; pdfExists: boolean }[];
};

test('mailprogramma lukt: eerst de vraag, en pas na Ja is de factuur verstuurd', async ({ page }) => {
  const { id, dialog } = await openVerstuurvenster(page);
  await ownMail(page, 'ok');
  await dialog.getByRole('button', { name: 'Versturen met je eigen mailprogramma' }).click();

  await expect(dialog.getByText('Is de factuur verstuurd?')).toBeVisible();
  // de webmail-keuze staat er altijd naast, ook als het doorgeven lukte
  await expect(dialog.getByText('Gmail / Outlook op het web')).toBeVisible();
  const calls = await ownMail(page);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ to: 'jansen@example.nl', pdfExists: true });
  expect(calls[0]!.subject).toContain('Factuur');

  // nog niets gemarkeerd, ook niet na "Nog niet"
  expect((await sentAt(page, id)).sent_at).toBeNull();
  await dialog.getByRole('button', { name: 'Nog niet' }).click();
  await expect(dialog).toBeHidden();
  expect(await sentAt(page, id)).toMatchObject({ sent_at: null, reminder_count: 0 });
});

test('Ja markeert de factuur als verstuurd', async ({ page }) => {
  const { id, dialog } = await openVerstuurvenster(page);
  await dialog.getByRole('button', { name: 'Versturen met je eigen mailprogramma' }).click();
  await dialog.getByRole('button', { name: 'Ja', exact: true }).click();
  await expect(page.getByText('Als verstuurd gemarkeerd ✓')).toBeVisible();
  await expect.poll(async () => (await sentAt(page, id)).sent_at).not.toBeNull();
});

test('mailprogramma lukt niet: de webmail-keuze verschijnt, niets wordt gemarkeerd', async ({ page }) => {
  const { id, dialog } = await openVerstuurvenster(page);
  await ownMail(page, 'no-handler');
  await dialog.getByRole('button', { name: 'Versturen met je eigen mailprogramma' }).click();

  await expect(dialog.getByText('Je mailprogramma kon niet worden geopend.')).toBeVisible();
  await expect(dialog.getByText('Gmail / Outlook op het web')).toBeVisible();
  await expect(dialog.getByText('Is de factuur verstuurd?')).toHaveCount(0);
  expect(await sentAt(page, id)).toMatchObject({ sent_at: null, reminder_count: 0 });

  // webmail: de link heeft alles ingevuld en de PDF wordt getoond; pas daarna komt de vraag, en pas na Ja geldt hij als verstuurd
  await dialog.getByRole('button', { name: 'Gmail' }).click();
  await expect(dialog.getByText('Is de factuur verstuurd?')).toBeVisible();
  const opened = (await (await page.request.post('/__opened')).json()).ok as { url?: string; revealed?: string }[];
  const url = opened.find((o) => o.url)?.url ?? '';
  expect(url).toContain('https://mail.google.com/');
  expect(new URL(url).searchParams.get('to')).toBe('jansen@example.nl');
  expect(opened.some((o) => o.revealed && o.revealed.endsWith('.pdf'))).toBe(true);
  expect((await sentAt(page, id)).sent_at).toBeNull();
  await dialog.getByRole('button', { name: 'Ja', exact: true }).click();
  await expect.poll(async () => (await sentAt(page, id)).sent_at).not.toBeNull();
});

test('mailvenster zelf gesloten (geannuleerd): geen vraag, geen webmail, niets gemarkeerd', async ({ page }) => {
  const { id, dialog } = await openVerstuurvenster(page);
  await ownMail(page, 'cancelled');
  await dialog.getByRole('button', { name: 'Versturen met je eigen mailprogramma' }).click();
  await expect.poll(async () => (await ownMail(page)).length).toBe(1);
  await expect(dialog.getByText('Is de factuur verstuurd?')).toHaveCount(0);
  await expect(dialog.getByText('Je mailprogramma kon niet worden geopend.')).toHaveCount(0);
  expect(await sentAt(page, id)).toMatchObject({ sent_at: null, reminder_count: 0 });
});
