import safety from './playwright.safety.config.mjs';

// Job and activity presentation checks use local fixtures and the offline boundary.
export default { ...safety, testMatch: ['jobs-activity.spec.mjs'], outputDir: './.system_generated/phase3e3a/browser' };
