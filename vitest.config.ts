import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each package keeps its own vitest.config.ts; this root config only
    // aggregates them so a single run can produce a merged coverage report.
    // The aggregated run schedules every package's suites onto one worker pool, so a cold start
    // can push an individual test past the 5s default; `test:coverage` passes --testTimeout for
    // that reason.
    projects: ['packages/*'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      exclude: [
        '**/*.test.ts',
        // Test doubles shipped for consumers and used only from tests here.
        'packages/core/src/testing.ts',
        'packages/core/src/client/test-support.ts',
        'packages/a2a/src/test-support.ts',
        'packages/mcp/src/test-server.ts',
      ],
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
});
