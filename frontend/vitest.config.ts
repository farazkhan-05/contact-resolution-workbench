import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'jsdom', include: ['src/**/*.test.tsx'], clearMocks: true, setupFiles: ['src/test-support/setup.ts'] },
});
