import { definePackageBuild } from '../../scripts/tsdown-config.ts';

export default definePackageBuild({
  entry: ['src/index.ts', 'src/internal.ts'],
  platform: 'neutral',
  neverBundle: ['@polymind-inc/agent-framework-core', 'openai'],
});
