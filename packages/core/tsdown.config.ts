import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/testing.ts'],
  format: ['esm'],
  platform: 'neutral',
  dts: { oxc: true, sourcemap: false },
  clean: true,
  treeshake: true,
  target: 'es2024',
  sourcemap: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  deps: { neverBundle: ['@opentelemetry/api'] },
});
