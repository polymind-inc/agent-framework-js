import { definePackageBuild } from '../../scripts/tsdown-config.ts';

export default definePackageBuild({
  entry: [
    'src/index.ts',
    'src/testing.ts',
    'src/node.ts',
    'src/openai.ts',
    'src/anthropic.ts',
    'src/mcp.ts',
    'src/a2a.ts',
    'src/foundry.ts',
    'src/foundry/hosting.ts',
    'src/agentserver.ts',
    'src/agentserver/node.ts',
    'src/agentserver/observability.ts',
  ],
  platform: 'node',
  neverBundle: [
    '@polymind-inc/agent-framework-a2a',
    '@polymind-inc/agent-framework-agentserver',
    '@polymind-inc/agent-framework-anthropic',
    '@polymind-inc/agent-framework-core',
    '@polymind-inc/agent-framework-foundry',
    '@polymind-inc/agent-framework-mcp',
    '@polymind-inc/agent-framework-openai',
  ],
});
