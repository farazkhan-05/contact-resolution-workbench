import auth from './playwright.auth-shell.config.mjs';

// Complete maintained frontend browser suite. Local Vite and synthetic/offline fixtures only.
export default { ...auth, testMatch: [
  'auth-shell.spec.mjs', 'cases.spec.mjs', 'foundations.spec.mjs', 'ingestion.spec.mjs',
  'investigation.spec.mjs', 'jobs-activity.spec.mjs', 'review-experience.spec.mjs',
  'safety.spec.mjs', 'sources-workspace.spec.mjs', 'ui.spec.mjs', 'integrated-quality.spec.mjs',
], outputDir: './.system_generated/phase3f/browser' };
