import safety from './playwright.safety.config.mjs';

// The maintained local server and offline boundary; no provider or staging access.
export default { ...safety, testMatch: ['cases.spec.mjs'], outputDir: './.system_generated/phase3d1/cases-browser' };
