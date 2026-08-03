import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'neutral',
  dts: { oxc: true, sourcemap: false },
  clean: true,
  treeshake: true,
  target: 'es2024',
  sourcemap: true,
  deps: { neverBundle: ['@polymind-inc/agent-framework-core', '@anthropic-ai/sdk'] },
});
