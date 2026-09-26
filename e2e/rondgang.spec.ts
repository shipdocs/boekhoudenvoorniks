import AxeBuilder from '@axe-core/playwright';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect, startDemo, nav, acceptTerms } from './fixtures';

/** Toegankelijkheid (axe): alles wat gevonden wordt komt in het rapport; "critical" laat de test falen. */
async function a11y(page: Page, testInfo: TestInfo, name: string, found: Map<string, { impact: string; help: string; screens: Set<string>; nodes: number }>) {
  const r = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
  for (const v of r.violations) {
    const f = found.get(v.id) ?? { impact: v.impact ?? '?', help: v.help, screens: new Set(), nodes: 0 };
    f.screens.add(name);
    f.nodes += v.nodes.length;
    found.set(v.id, f);
  }
}

async function noErrorBox(page: Page, where: string) {
  await expect(page.locator('main .notice.bad'), `foutmelding op ${where}`).toHaveCount(0);
}

test('rondgang door alle schermen van de demo: geen crash, geen foutmelding', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const found = new Map<string, { impact: string; help: string; screens: Set<string>; nodes: number }>();
  await startDemo(page);

  const screens = ['Vandaag', 'Werk & facturen', 'Klussen', 'Aankopen & bonnetjes', 'Klanten', 'Bank', 'Belasting', 'Hoe gaat het?'];
  for (const s of screens) {
    await nav(page, s);
    await acceptTerms(page);
    await expect(page.locator('main h1').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    await noErrorBox(page, s);
    await a11y(page, testInfo, s, found);
  }

  // Werk: offertes-tab, een factuur en een offerte openen
  await nav(page, 'Werk & facturen');
  await page.locator('.chips button', { hasText: 'Offertes' }).click();
  await noErrorBox(page, 'offertes');
  await page.locator('.chips button', { hasText: 'Facturen' }).click();
  await page.locator('table.list tbody tr').first().click();
  await expect(page.getByRole('heading', { name: /Factuur/ })).toBeVisible();
  await noErrorBox(page, 'factuur');
  await a11y(page, testInfo, 'factuur', found);
  await page.getByRole('button', { name: 'Voorbeeld' }).click();
  await expect(page.getByRole('dialog', { name: 'Voorbeeld' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Klanten: een klant openen
  await nav(page, 'Klanten');
  await page.locator('table.list tbody tr').first().click();
  await expect(page.getByRole('button', { name: '← Klanten' })).toBeVisible();
  await noErrorBox(page, 'klant');
  await a11y(page, testInfo, 'klant', found);

  // Belasting: aftrek-scherm en de details van de btw
  await nav(page, 'Belasting');
  await page.locator('table.sumtable tr', { hasText: 'Omzet' }).click();
  await expect(page.getByRole('dialog', { name: 'Omzet' }).locator('tbody tr').first()).toBeVisible();
  await a11y(page, testInfo, 'btw-details', found);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Aftrek, investeringen en kilometers' }).click();
  await acceptTerms(page);
  await expect(page.locator('main h1').first()).toBeVisible();
  await noErrorBox(page, 'aangifte');
  await a11y(page, testInfo, 'aangifte', found);

  // Instellingen: elk tabblad
  await nav(page, 'Instellingen');
  const tabs = await page.locator('main .chips').first().locator('button').allTextContents();
  expect(tabs.length).toBeGreaterThan(5);
  for (const t of tabs) {
    await page.locator('main .chips').first().locator('button', { hasText: t }).click();
    await page.waitForLoadState('networkidle');
    await noErrorBox(page, `instellingen/${t}`);
    await a11y(page, testInfo, `instellingen/${t}`, found);
  }

  // zoeken (Ctrl K)
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Jansen');
  await expect(page.getByText('Familie Jansen').first()).toBeVisible();
  await page.keyboard.press('Escape');

  const report = [...found.entries()].map(([id, f]) => ({ id, impact: f.impact, help: f.help, nodes: f.nodes, screens: [...f.screens] }));
  await testInfo.attach('toegankelijkheid', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  console.log(`\nToegankelijkheid (axe), ${report.length} soorten bevindingen:`);
  for (const r of report) console.log(`- [${r.impact}] ${r.id}: ${r.help} (${r.nodes}× op ${r.screens.slice(0, 4).join(', ')}${r.screens.length > 4 ? ', …' : ''})`);
  expect(report.filter((r) => r.impact === 'critical').map((r) => r.id), 'kritieke toegankelijkheidsproblemen').toEqual([]);
});
