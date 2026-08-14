import { definePackageBuild } from '../../scripts/tsdown-config.ts';

export default definePackageBuild({
  entry: ['src/index.ts'],
  platform: 'neutral',
  neverBundle: ['@polymind-inc/agent-framework-core', '@a2a-js/sdk'],
});
