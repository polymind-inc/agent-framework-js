import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

function source(path: string): string {
  return fileURLToPath(new URL(`../packages/${path}`, import.meta.url));
}

// Subpaths precede their package roots so Vite's prefix matching always selects the exact entry.
const workspaceAliases = {
  '@polymind-inc/agent-framework-core/testing': source('core/src/testing.ts'),
  '@polymind-inc/agent-framework-core/node': source('core/src/node.ts'),
  '@polymind-inc/agent-framework-core': source('core/src/index.ts'),
  '@polymind-inc/agent-framework-foundry/hosting': source('foundry/src/hosting.ts'),
  '@polymind-inc/agent-framework-foundry': source('foundry/src/index.ts'),
  '@polymind-inc/agent-framework-agentserver/node': source('agentserver/src/node.ts'),
  '@polymind-inc/agent-framework-agentserver/observability': source('agentserver/src/observability.ts'),
  '@polymind-inc/agent-framework-agentserver/internal': source('agentserver/src/internal.ts'),
  '@polymind-inc/agent-framework-agentserver': source('agentserver/src/index.ts'),
  '@polymind-inc/agent-framework-openai/internal': source('openai/src/internal.ts'),
  '@polymind-inc/agent-framework-openai': source('openai/src/index.ts'),
  '@polymind-inc/agent-framework-anthropic': source('anthropic/src/index.ts'),
  '@polymind-inc/agent-framework-mcp': source('mcp/src/index.ts'),
  '@polymind-inc/agent-framework-a2a': source('a2a/src/index.ts'),
};

/** Shared source aliases and test discovery for a package's unit tests. */
export function definePackageTests() {
  return defineConfig({
    resolve: { alias: workspaceAliases },
    test: { include: ['src/**/*.test.ts'] },
  });
}
