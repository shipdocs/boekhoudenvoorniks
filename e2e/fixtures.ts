import { test as base, expect, type Page } from '@playwright/test';

/** Wat er tijdens een test misging in de pagina: crashes, console-fouten en foutmeldingen van de api. */
export interface Problems {
  pageErrors: string[];
  consoleErrors: string[];
  apiErrors: { method: string; error: string }[];
}

/**
 * Elke test: een lege administratie, een bridge naar de testserver (in plaats van Electron) en
 * een logboek van fouten. Een crash of console-fout laat de test falen; api-fouten (bv. "Vul een
 * bedrag in") worden bijgevoegd, want die zijn soms juist de bedoeling.
 */
export const test = base.extend<{ problems: Problems }>({
  problems: [async ({ page, request }, use, testInfo) => {
    await request.post('/__reset');
    const problems: Problems = { pageErrors: [], consoleErrors: [], apiErrors: [] };
    page.on('pageerror', (e) => problems.pageErrors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.consoleErrors.push(m.text());
    });
    await page.exposeFunction('__e2eApiError', (method: string, error: string) => problems.apiErrors.push({ method, error }));
    await page.addInitScript(() => {
      const toJson = (v: unknown): unknown => {
        if (v instanceof Uint8Array) {
          let s = '';
          for (let i = 0; i < v.length; i++) s += String.fromCharCode(v[i]!);
          return { __bytes: btoa(s) };
        }
        if (Array.isArray(v)) return v.map(toJson);
        if (v && typeof v === 'object' && !(v instanceof Date)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJson(x)]));
        return v;
      };
      const fromJson = (v: unknown): unknown => {
        if (v && typeof v === 'object' && typeof (v as { __bytes?: unknown }).__bytes === 'string') {
          const bin = atob((v as { __bytes: string }).__bytes);
          return Uint8Array.from(bin, (c) => c.charCodeAt(0));
        }
        if (Array.isArray(v)) return v.map(fromJson);
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromJson(x)]));
        return v;
      };
      (window as unknown as { bridge: unknown }).bridge = {
        call: async (method: string, args: unknown[]) => {
          const r = await (await fetch('/api', { method: 'POST', body: JSON.stringify({ method, args: toJson(args) }) })).json();
          if (r.error) {
            void (window as unknown as { __e2eApiError: (m: string, e: string) => void }).__e2eApiError(method, r.error);
            throw new Error(r.error);
          }
          return fromJson(r.ok);
        },
        onEvent: () => () => undefined,
      };
    });
    await use(problems);
    if (problems.apiErrors.length) await testInfo.attach('api-fouten', { body: JSON.stringify(problems.apiErrors, null, 2), contentType: 'application/json' });
    expect(problems.pageErrors, 'crash in de pagina').toEqual([]);
    expect(problems.consoleErrors, 'fout in de console').toEqual([]);
  }, { auto: true }],
});

export { expect };

/** Roept de api direct aan (zoals de app zelf doet), bv. om snel gegevens klaar te zetten. */
export async function call<T = unknown>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(([m, a]) => (window as unknown as { bridge: { call: (m: string, a: unknown[]) => Promise<unknown> } }).bridge.call(m as string, a as unknown[]), [method, args] as const) as Promise<T>;
}

/** Naar een scherm via het menu links. */
export async function nav(page: Page, label: string | RegExp) {
  await page.locator('nav.nav button', { hasText: label }).first().click();
}

/** De hele onboarding doorlopen zoals een nieuwe gebruiker. Eindigt op Vandaag. */
export async function onboard(page: Page, opts: { kor?: boolean } = {}) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welkom 👋' })).toBeVisible();
  await page.getByPlaceholder('Voornaam').fill('Piet');
  await page.locator('.chips button').first().click();
  await page.getByRole('button', { name: 'Verder' }).click();
  // de stappen hangen af van de antwoorden; loop ze door tot "Klaar"
  for (let i = 0; i < 12; i++) {
    const h1 = (await page.locator('h1').first().textContent())?.trim() ?? '';
    if (/Werk je alleen/.test(h1)) await page.getByRole('button', { name: 'Ja, ik werk alleen' }).click();
    else if (/Je bedrijf/.test(h1)) {
      await field(page, 'Bedrijfsnaam').fill('Stukadoorsbedrijf Piet');
      await field(page, 'Straat en huisnummer').fill('Kalkweg 1');
      await field(page, 'Postcode').fill('1234 AB');
      await field(page, 'Plaats').fill('Utrecht');
      await field(page, 'KvK-nummer').fill('12345678');
      await field(page, 'E-mailadres').fill('piet@example.nl');
      await page.getByRole('button', { name: 'Verder' }).click();
    } else if (/Reken je btw/.test(h1)) {
      if (opts.kor) await page.getByRole('button', { name: /Nee, ik gebruik de kleineondernemersregeling/ }).click();
      else await page.getByPlaceholder('NL123456789B01').fill('NL123456782B01');
      await page.getByRole('button', { name: 'Verder' }).click();
    } else if (/zakelijke bankrekening/.test(h1)) {
      await page.getByPlaceholder('NL00 BANK 0123 4567 89').fill('NL91ABNA0417164300');
      await page.getByRole('button', { name: 'Verder' }).click();
    } else if (/Auto en startjaar/.test(h1)) {
      await page.getByRole('button', { name: /Met mijn privéauto/ }).click();
      await field(page, 'In welk jaar ben je gestart?').fill('2020');
      await page.getByRole('button', { name: 'Verder' }).click();
    } else if (/Telefoon, internet en werkplek/.test(h1)) {
      await page.getByRole('button', { name: 'Half-half' }).click();
      await page.getByRole('button', { name: 'Nee', exact: true }).click();
      await page.getByRole('button', { name: 'Verder' }).click();
    } else if (/Hoeveel mag de app zelf doen/.test(h1)) {
      await page.getByRole('button', { name: 'Verder' }).click();
    } else if (/eerder gefactureerd/.test(h1)) {
      const terms = page.locator('input[type=checkbox]');
      for (const cb of await terms.all()) await cb.check();
      await page.getByRole('button', { name: 'Klaar', exact: true }).click();
      break;
    } else break;
  }
  const done = page.getByRole('button', { name: 'Naar Vandaag' });
  if (await done.isVisible().catch(() => false)) await done.click();
  await expect(page.locator('nav.nav')).toBeVisible();
}

/** De demo starten vanaf het welkomstscherm. */
export async function startDemo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /Bekijk de demo/ }).click();
  await expect(page.getByText('Je bekijkt de demo.')).toBeVisible();
  await acceptTerms(page);
}

/** "Even iets belangrijks": de gebruiksvoorwaarden (komen na de demo of een nieuwe versie). */
export async function acceptTerms(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Gebruiksvoorwaarden' });
  if (!(await dialog.isVisible({ timeout: 4000 }).catch(() => false))) return;
  for (const cb of await dialog.locator('input[type=checkbox]').all()) await cb.check();
  await dialog.getByRole('button', { name: 'Akkoord' }).click();
  await expect(dialog).toBeHidden();
}

/** Een invoerveld via de tekst van zijn label (onze Field zet het veld in het label). */
export function field(page: Page, label: string) {
  return page.locator('label.field', { has: page.locator(`span:text-is("${label}")`) }).locator('input, select, textarea').first()
    .or(page.locator('label.field', { hasText: label }).locator('input, select, textarea').first()).first();
}
