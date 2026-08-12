import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // The subpath alias must come first: a bare prefix match would otherwise rewrite
      // `@polymind-inc/agent-framework-agentserver/internal` into a path inside index.ts.
      '@polymind-inc/agent-framework-agentserver/internal': fileURLToPath(
        new URL('../agentserver/src/internal.ts', import.meta.url),
      ),
      '@polymind-inc/agent-framework-agentserver': fileURLToPath(
        new URL('../agentserver/src/index.ts', import.meta.url),
      ),
      // The subpath alias must come first: a bare prefix match would otherwise rewrite
      // `@polymind-inc/agent-framework-core/testing` into a path inside index.ts.
      '@polymind-inc/agent-framework-core/testing': fileURLToPath(
        new URL('../core/src/testing.ts', import.meta.url),
      ),
      '@polymind-inc/agent-framework-core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@polymind-inc/agent-framework-mcp': fileURLToPath(new URL('../mcp/src/index.ts', import.meta.url)),
      // Subpath alias first, for the same reason as `core/testing` above.
      '@polymind-inc/agent-framework-openai/internal': fileURLToPath(
        new URL('../openai/src/internal.ts', import.meta.url),
      ),
      '@polymind-inc/agent-framework-openai': fileURLToPath(
        new URL('../openai/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
