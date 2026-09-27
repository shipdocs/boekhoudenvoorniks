import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests: de echte schermen in een browser, met de echte services via e2e/server.cjs.
 * Eerst `npm run build`. Lokaal met een eigen Chromium: PW_CHROMIUM=/pad/naar/chrome.
 */
const PORT = Number(process.env.E2E_PORT || 5190);

export default defineConfig({
  testDir: 'e2e',
  // één administratie op de server: tests na elkaar
  workers: 1,
  fullyParallel: false,
  timeout: 45_000,
  expect: { timeout: 7_000 },
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]] : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1360, height: 900 },
    locale: 'nl-NL',
    timezoneId: 'Europe/Amsterdam',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  outputDir: 'e2e-results',
  webServer: {
    command: 'node e2e/server.cjs',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    env: { E2E_PORT: String(PORT) },
  },
});
