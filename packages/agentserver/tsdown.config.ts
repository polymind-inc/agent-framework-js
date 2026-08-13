import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/node.ts', 'src/observability.ts', 'src/internal.ts'],
  format: ['esm'],
  platform: 'node',
  // The gRPC exporters are optional peers, but they are also devDependencies so the tests can
  // exercise the code that loads them — and tsdown inlines devDeps. Without this they end up
  // bundled (a ~1.2 MB chunk carrying @grpc/grpc-js), which makes the "not installed → warn and
  // drop that signal" fallback in `observability/setup.ts` unreachable in a published build.
  deps: {
    neverBundle: ['@opentelemetry/exporter-metrics-otlp-grpc', '@opentelemetry/exporter-trace-otlp-grpc'],
  },
  dts: { oxc: true, sourcemap: false },
  clean: true,
  treeshake: true,
  target: 'es2024',
  sourcemap: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
