import { defineConfig } from '@playwright/test';

// Local, mocked API tests only. Production/staging test configurations are not used.
export default defineConfig({
  testDir: './smoke', testMatch: ['ui.spec.mjs', 'safety.spec.mjs'], workers: 1, retries: 0,
  timeout: 30_000, reporter: 'line', outputDir: './.system_generated/phase2a/browser',
  use: { browserName: 'chromium', baseURL: 'http://127.0.0.1:5177',
    trace: 'off', screenshot: 'off', video: 'off', serviceWorkers: 'block' },
  webServer: [
    { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5177 --strictPort', url: 'http://127.0.0.1:5177', reuseExistingServer: false },
  ],
});
