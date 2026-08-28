import { definePackageBuild } from '../../scripts/tsdown-config.ts';

export default definePackageBuild({
  entry: ['src/index.ts', 'src/testing.ts', 'src/internal.ts', 'src/node.ts'],
  platform: 'neutral',
  neverBundle: ['@opentelemetry/api'],
});
