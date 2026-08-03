import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // The subpath alias must come first: a bare prefix match would otherwise rewrite
      // `@polymind-inc/agent-framework-core/testing` into a path inside index.ts.
      '@polymind-inc/agent-framework-core/testing': fileURLToPath(
        new URL('../core/src/testing.ts', import.meta.url),
      ),
      '@polymind-inc/agent-framework-core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
