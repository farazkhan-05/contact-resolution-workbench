import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './smoke', testMatch: 'auth.spec.mjs', workers: 1, retries: 0,
  timeout: 120_000, expect: { timeout: 30_000 }, reporter: 'line',
  outputDir: '../.system_generated/auth-browser-results',
  use: {
    browserName: 'chromium', baseURL: 'https://contact-resolution.vercel.app',
    trace: 'off', screenshot: 'off', video: 'off',
  },
});
