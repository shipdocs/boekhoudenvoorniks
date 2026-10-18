import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Sommige tests (PDF maken, mail verwerken) duren lokaal al ~2,5 s; op de tragere
    // Windows-runner van de Release-workflow liepen ze over de standaard van 5 s.
    testTimeout: 30_000,
  },
});
