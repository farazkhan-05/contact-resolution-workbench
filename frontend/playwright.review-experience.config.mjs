import safety from './playwright.safety.config.mjs';

// Offline only; the existing similarly named staging configuration is not used.
export default { ...safety, testMatch: ['review-experience.spec.mjs'], outputDir: './.system_generated/phase3d2/review-browser' };
