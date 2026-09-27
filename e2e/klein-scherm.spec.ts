import { test, expect, startDemo, nav, acceptTerms } from './fixtures';

test.use({ viewport: { width: 1024, height: 680 } });

test('kleiner laptopscherm: geen scherm schuift opzij', async ({ page }) => {
  test.setTimeout(90_000);
  await startDemo(page);
  const overflow: string[] = [];
  for (const s of ['Vandaag', 'Werk & facturen', 'Klussen', 'Aankopen & bonnetjes', 'Klanten', 'Bank', 'Belasting', 'Hoe gaat het?', 'Instellingen']) {
    await nav(page, s);
    await acceptTerms(page);
    await page.waitForLoadState('networkidle');
    // breder dan het venster = de gebruiker moet horizontaal schuiven
    const wide = await page.evaluate(() => {
      const main = document.querySelector('main')!;
      const out = [...main.querySelectorAll<HTMLElement>('*')]
        .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 2 && getComputedStyle(el).position !== 'fixed' && !el.closest('.lines-scroll'))
        .slice(0, 3)
        .map((el) => `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 60));
      return { scroll: document.documentElement.scrollWidth > window.innerWidth + 2 || main.scrollWidth > main.clientWidth + 2, out };
    });
    if (wide.scroll || wide.out.length) overflow.push(`${s}: ${wide.out.join(', ')}`);
  }
  expect(overflow, 'schermen die breder zijn dan het venster').toEqual([]);
});
