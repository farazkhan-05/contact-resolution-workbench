import safety from './playwright.safety.config.mjs';

// Ingestion presentation and recovery checks are local and fully mocked.
export default { ...safety, testMatch: ['ingestion.spec.mjs'], outputDir: './.system_generated/phase3e2/browser' };
