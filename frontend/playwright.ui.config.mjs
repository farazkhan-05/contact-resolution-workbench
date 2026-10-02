import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './smoke', testMatch: 'ui.spec.mjs', workers: 1, retries: 0,
  timeout: 30_000, reporter: 'line', outputDir: '../.system_generated/ui-browser-results',
  use: { browserName: 'chromium', baseURL: 'http://127.0.0.1:5173', screenshot: 'only-on-failure' },
  webServer: { command: 'npm.cmd run dev -- --host 127.0.0.1', url: 'http://127.0.0.1:5173', reuseExistingServer: true },
});
