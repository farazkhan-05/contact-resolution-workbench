import { defineConfig } from '@playwright/test';
import safety from './playwright.safety.config.mjs';

// Real AuthProvider, mocked Firebase SDK and API responses, local server only.
export default defineConfig({ ...safety, testMatch: 'auth-shell.spec.mjs',
  outputDir: './.system_generated/phase3c/browser',
  webServer: safety.webServer.map(server => ({ ...server, env: {
    VITE_API_BASE_URL: 'http://127.0.0.1:5177',
    VITE_FIREBASE_API_KEY: 'synthetic-config', VITE_FIREBASE_AUTH_DOMAIN: 'synthetic.invalid',
    VITE_FIREBASE_PROJECT_ID: 'synthetic', VITE_FIREBASE_APP_ID: 'synthetic',
  } })),
});
