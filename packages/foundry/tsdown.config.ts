import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/hosting.ts'],
  format: ['esm'],
  platform: 'node',
  dts: { oxc: true, sourcemap: false },
  clean: true,
  treeshake: true,
  target: 'es2024',
  sourcemap: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  deps: {
    neverBundle: [
      '@polymind-inc/agent-framework-agentserver',
      '@polymind-inc/agent-framework-core',
      '@polymind-inc/agent-framework-openai',
      '@azure/identity',
      '@modelcontextprotocol/client',
      'openai',
    ],
  },
});
