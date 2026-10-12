import safety from './playwright.safety.config.mjs';

// Evidence investigation validation uses synthetic API responses and local Vite only.
export default { ...safety, testMatch: ['investigation.spec.mjs'], outputDir: './.system_generated/phase3e3b/browser' };
