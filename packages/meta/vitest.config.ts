import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Resolves a sibling package source file, so tests run without a prior build. */
function src(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: {
      // Subpath aliases must come before their bare package name: a bare prefix match would
      // otherwise rewrite the subpath into a path inside the package's index.ts.
      '@polymind-inc/agent-framework-core/testing': src('../core/src/testing.ts'),
      '@polymind-inc/agent-framework-core/node': src('../core/src/node.ts'),
      '@polymind-inc/agent-framework-core': src('../core/src/index.ts'),
      '@polymind-inc/agent-framework-foundry/hosting': src('../foundry/src/hosting.ts'),
      '@polymind-inc/agent-framework-foundry': src('../foundry/src/index.ts'),
      '@polymind-inc/agent-framework-agentserver/node': src('../agentserver/src/node.ts'),
      '@polymind-inc/agent-framework-agentserver/observability': src('../agentserver/src/observability.ts'),
      '@polymind-inc/agent-framework-agentserver/internal': src('../agentserver/src/internal.ts'),
      '@polymind-inc/agent-framework-agentserver': src('../agentserver/src/index.ts'),
      '@polymind-inc/agent-framework-openai/internal': src('../openai/src/internal.ts'),
      '@polymind-inc/agent-framework-openai': src('../openai/src/index.ts'),
      '@polymind-inc/agent-framework-anthropic': src('../anthropic/src/index.ts'),
      '@polymind-inc/agent-framework-mcp': src('../mcp/src/index.ts'),
      '@polymind-inc/agent-framework-a2a': src('../a2a/src/index.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
