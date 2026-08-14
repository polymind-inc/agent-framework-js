import { definePackageBuild } from '../../scripts/tsdown-config.ts';

export default definePackageBuild({
  entry: ['src/index.ts', 'src/node.ts', 'src/observability.ts', 'src/internal.ts'],
  platform: 'node',
  // The gRPC exporters are optional peers, but they are also devDependencies so the tests can
  // exercise the code that loads them — and tsdown inlines devDeps. Without this they end up
  // bundled (a ~1.2 MB chunk carrying @grpc/grpc-js), which makes the "not installed → warn and
  // drop that signal" fallback in `observability/setup.ts` unreachable in a published build.
  neverBundle: ['@opentelemetry/exporter-metrics-otlp-grpc', '@opentelemetry/exporter-trace-otlp-grpc'],
});
