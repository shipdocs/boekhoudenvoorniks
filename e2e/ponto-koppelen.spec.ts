import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, onboard, nav, call } from './fixtures';

const CSV = readFileSync(join(__dirname, '..', 'tests', 'fixtures', 'ing.csv'));
const CLIENT_ID = 'e2e-client';
const CLIENT_SECRET = 'e2e-secret';
const datePlus = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const secondAccount = {
  id: 'ponto-tweede', iban: 'NL44RABO0123456789', name: 'Ponto tweede rekening', currency: 'EUR',
  balance: '50.00', balanceAt: '2026-10-02T08:00:00.000Z', detailsSynchronizedAt: '2026-10-02T08:00:00.000Z',
  expiresAt: '2026-11-20', deprecated: false,
};

async function provider(request: APIRequestContext, patch: Record<string, unknown> = {}) {
  return (await request.post('/__ponto', { data: patch })).json() as Promise<{ ok: { calls: { path: string; subtype?: string }[] } }>;
}

async function openWizard(page: Page) {
  await nav(page, 'Bank');
  await page.getByRole('button', { name: 'Ponto instellen' }).click();
  return page.getByRole('dialog', { name: 'Ponto-bankkoppeling' });
}

async function reachCredentials(page: Page, visitLinks = false) {
  const dialog = await openWizard(page);
  await expect(dialog.getByText('Stap 0 van 5')).toBeVisible();
  await dialog.getByRole('button', { name: 'Volgende' }).click();
  if (visitLinks) await dialog.getByRole('button', { name: 'Open Ponto-dashboard' }).click();
  await dialog.getByRole('button', { name: 'Volgende' }).click();
  await dialog.getByRole('button', { name: 'Volgende' }).click();
  if (visitLinks) await dialog.getByRole('button', { name: 'Custom integration maken' }).click();
  await dialog.getByRole('button', { name: 'Volgende' }).click();
  await expect(dialog.getByText('Stap 4 van 5')).toBeVisible();
  return dialog;
}

async function testCredentials(dialog: ReturnType<Page['getByRole']>, clientId = CLIENT_ID, secret = CLIENT_SECRET) {
  await dialog.getByLabel('Client ID').fill(clientId);
  await dialog.getByLabel('Client Secret').fill(secret);
  await dialog.getByRole('button', { name: 'Verbinding testen' }).click();
}

async function connectDefault(page: Page) {
  const dialog = await reachCredentials(page);
  await testCredentials(dialog);
  await expect(dialog.getByText('Stap 5 van 5')).toBeVisible();
  await dialog.getByRole('button', { name: 'Koppelen en ophalen' }).click();
  await expect(dialog.getByText('Koppeling opgeslagen en opgehaald')).toBeVisible();
  await dialog.getByRole('button', { name: 'Sluiten' }).click();
}

test('Ponto-wizard: bewezen bestaande rekening, nieuwe rekening incompleet, openbare links en toegankelijke dialoog', async ({ page, request, problems }) => {
  await onboard(page);
  await nav(page, 'Bank');
  await page.locator('main input[type=file]').first().setInputFiles({ name: 'afschrift.csv', mimeType: 'text/csv', buffer: CSV });
  await expect(page.locator('.notice.good')).toContainText('3 nieuwe betalingen');

  await provider(request, {
    accounts: [
      { id: 'ponto-zakelijk', iban: 'NL91ABNA0417164300', name: 'Ponto zakelijke rekening', currency: 'EUR', balance: '1000.00', balanceAt: '2026-10-02T08:00:00.000Z', detailsSynchronizedAt: '2026-10-02T08:00:00.000Z', expiresAt: datePlus(7), deprecated: false },
      secondAccount,
    ],
    transactions: {
      'ponto-zakelijk': [{ id: 'ponto-tx-1', date: '2026-10-01', amount: '-12.34', name: 'EE leverancier', description: 'Aankoop' }],
      'ponto-tweede': [{ id: 'ponto-tx-2', date: '2026-10-01', amount: '25.00', name: 'E2E klant', description: 'Ontvangst' }],
    },
    synchronizedAt: { 'ponto-zakelijk': '2026-10-02T08:05:00.000Z', 'ponto-tweede': '2026-10-02T08:05:00.000Z' },
  });

  const dialog = await reachCredentials(page, true);
  const axe = await new AxeBuilder({ page }).include('.modal').disableRules(['color-contrast']).analyze();
  expect(axe.violations.filter((finding) => finding.impact === 'critical')).toEqual([]);
  await testCredentials(dialog);
  await expect(dialog.getByText(/Sluit aantoonbaar aan op je afschriften/)).toBeVisible();
  const choices = dialog.locator('select');
  await expect(choices.nth(1)).toHaveValue('');
  await choices.nth(1).selectOption('nieuw');
  await expect(dialog.getByText(/Eerdere periode nog onderbouwen/).last()).toBeVisible();
  await dialog.getByRole('button', { name: 'Koppelen en ophalen' }).click();
  await expect(dialog.getByText(/2 nieuwe betalingen/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Sluiten' }).click();

  const opened = await (await request.post('/__opened')).json() as { ok: { url?: string }[] };
  expect(opened.ok.map((item) => item.url).filter(Boolean)).toEqual([
    'https://dashboard.myponto.com',
    'https://dashboard.myponto.com/new-custom-integration?customIntegrationName=BoekhoudenVoorNiks',
  ]);
  expect(problems.apiErrors).toEqual([]);
});

test('ongeldig secret blijft uit foutteksten en uit het veilige providerlog', async ({ page, request, problems }) => {
  await onboard(page);
  const dialog = await reachCredentials(page);
  const wrong = 'GEHEIM-DAT-NOOIT-IN-EEN-LOG-MAG';
  await testCredentials(dialog, CLIENT_ID, wrong);
  await expect(dialog.getByRole('alert')).toContainText(/Ponto/);
  expect(await dialog.getByRole('alert').textContent()).not.toContain(wrong);
  const state = await provider(request);
  expect(JSON.stringify(state)).not.toContain(wrong);
  expect(JSON.stringify(problems.apiErrors)).not.toContain(wrong);
});

test('zonder veilige opslag blijft alleen het afschriftalternatief beschikbaar', async ({ page, request }) => {
  await request.post('/__securestorage', { data: { on: false } });
  await onboard(page);
  const dialog = await openWizard(page);
  await expect(dialog.getByText(/geen veilige opslag/)).toBeVisible();
  await expect(dialog.getByText(/bankafschriften downloaden en inlezen/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Volgende' })).toBeDisabled();
  await expect(dialog.getByLabel('Client ID')).toHaveCount(0);
});

test('onvolledige cursorpaginering importeert veilig maar schuift bewezen dekking niet op', async ({ page, request, problems }) => {
  await onboard(page);
  await nav(page, 'Bank');
  await page.locator('main input[type=file]').first().setInputFiles({ name: 'afschrift.csv', mimeType: 'text/csv', buffer: CSV });
  await expect(page.locator('.notice.good')).toContainText('3 nieuwe betalingen');
  const before = await call<{ completeTo: string | null }[]>(page, 'bank.importStatus');
  await provider(request, {
    transactions: { 'ponto-zakelijk': [
      { id: 'page-1', date: '2026-10-01', amount: '-1.00', name: 'Eerste', description: 'eerste pagina' },
      { id: 'page-2', date: '2026-10-02', amount: '-2.00', name: 'Tweede', description: 'tweede pagina' },
    ] },
    pagination: { pageSize: 1, incomplete: true },
  });
  await connectDefault(page);
  const after = await call<{ completeTo: string | null }[]>(page, 'bank.importStatus');
  expect(after[0]?.completeTo).toBe(before[0]?.completeTo);
  expect(await call<unknown[]>(page, 'bank.transactions')).toHaveLength(4);
  expect(problems.apiErrors).toEqual([]);
});

test('Nu bijwerken vraagt eenmalig privacytoestemming, start beide synchronisaties en toont de 30-minutengrens', async ({ page, request, problems }) => {
  await onboard(page);
  await connectDefault(page);
  await page.getByRole('button', { name: 'Nu bijwerken' }).click();
  const privacy = page.getByRole('dialog', { name: 'Handmatig bijwerken via Ponto' });
  await expect(privacy).toContainText('Cloudflare');
  await expect(privacy).toContainText('publieke IP-adres');
  await privacy.getByRole('button', { name: 'Doorgaan en bijwerken' }).click();
  await expect(page.getByRole('button', { name: /Kan weer om/ })).toBeDisabled();
  const state = await provider(request);
  expect(state.ok.calls.filter((entry) => entry.path === 'cloudflare-trace')).toHaveLength(1);
  expect(state.ok.calls.filter((entry) => entry.path === 'synchronizations').map((entry) => entry.subtype).sort()).toEqual(['accountDetails', 'accountTransactions']);
  expect(problems.apiErrors).toEqual([]);
});

test('mislukte detailsynchronisatie importeert transacties zonder saldotaak; ontkoppelen bewaart ze', async ({ page, request, problems }) => {
  await onboard(page);
  await connectDefault(page);
  const before = (await call<unknown[]>(page, 'bank.transactions')).length;
  await provider(request, {
    transactions: { 'ponto-zakelijk': [
      { id: 'ponto-tx-1', date: '2026-10-01', amount: '-12.34', name: 'E2E leverancier', description: 'E2E aankoop' },
      { id: 'ponto-tx-2', date: '2026-10-02', amount: '-4.56', name: 'E2E leverancier', description: 'Nieuwe aankoop' },
    ] },
    synchronizedAt: { 'ponto-zakelijk': '2026-10-03T08:05:00.000Z' },
    sync: { accountDetails: { status: 'error', pendingPolls: 0 } },
  });
  await page.getByRole('button', { name: 'Nu bijwerken' }).click();
  await page.getByRole('dialog', { name: 'Handmatig bijwerken via Ponto' }).getByRole('button', { name: 'Doorgaan en bijwerken' }).click();
  await expect.poll(async () => (await call<unknown[]>(page, 'bank.transactions')).length).toBe(before + 1);
  await expect(page.getByText(/synchronization-error/)).toBeVisible();
  await nav(page, 'Vandaag');
  await expect(page.locator('.task', { hasText: 'saldo klopt niet' })).toHaveCount(0);
  await nav(page, 'Bank');
  const count = (await call<unknown[]>(page, 'bank.transactions')).length;
  await page.getByRole('button', { name: 'Ontkoppelen' }).click();
  const disconnect = page.getByRole('dialog', { name: 'Ponto ontkoppelen' });
  await expect(disconnect).toContainText(/bestaande transacties/i);
  await disconnect.getByRole('button', { name: 'Ontkoppelen' }).click();
  await expect(page.getByRole('button', { name: 'Ponto instellen' })).toBeVisible();
  expect(await call<unknown[]>(page, 'bank.transactions')).toHaveLength(count);
  expect(problems.apiErrors).toEqual([]);
});

test('verlopende toestemming staat op Vandaag en opent uitsluitend het Ponto-dashboard', async ({ page, request, problems }) => {
  await onboard(page);
  await connectDefault(page);
  await nav(page, 'Vandaag');
  const task = page.locator('.task', { hasText: 'verleng je toestemming' });
  await expect(task).toBeVisible();
  await task.getByRole('button', { name: 'Naar Ponto' }).click();
  const opened = await (await request.post('/__opened')).json() as { ok: { url?: string }[] };
  expect(opened.ok.at(-1)?.url).toBe('https://dashboard.myponto.com');
  expect(JSON.stringify(opened)).not.toContain(CLIENT_SECRET);
  expect(problems.apiErrors).toEqual([]);
});
