import { definePackageBuild } from '../../scripts/tsdown-config.ts';

export default definePackageBuild({
  entry: ['src/index.ts', 'src/hosting.ts'],
  platform: 'node',
  neverBundle: [
    '@polymind-inc/agent-framework-agentserver',
    '@polymind-inc/agent-framework-core',
    '@polymind-inc/agent-framework-openai',
    '@azure/identity',
    '@modelcontextprotocol/client',
    'openai',
  ],
});
