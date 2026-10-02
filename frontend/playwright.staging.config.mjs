import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './smoke',
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: 'line',
  outputDir: '../.system_generated/e3-browser-results',
  use: {
    browserName: 'chromium',
    baseURL: 'https://contact-resolution-workbench-productization-v1.vercel.app',
    viewport: { width: 1440, height: 1000 },
    // Never persist Firebase tokens in traces, videos or storage snapshots.
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
