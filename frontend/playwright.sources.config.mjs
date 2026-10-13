import safety from './playwright.safety.config.mjs';

// Sources validation uses local mocked responses and the maintained offline boundary.
export default { ...safety, testMatch: ['sources-workspace.spec.mjs'], outputDir: './.system_generated/phase3e1/browser' };
