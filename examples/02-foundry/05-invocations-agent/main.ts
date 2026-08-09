/**
 * A Microsoft Foundry Hosted Agent on the Invocations protocol.
 *
 * `InvocationsHostServer` publishes the agent over `POST /invocations` — the protocol for callers
 * that cannot speak the Responses request shape — and `serve` binds `0.0.0.0:${PORT:-8088}`, the
 * address the platform's readiness probe expects.
 *
 * Locally:
 *   pnpm --filter example-02-foundry build
 *   pnpm --filter example-02-foundry invocations
 *   curl -X POST localhost:8088/invocations -H 'content-type: application/json' -d '{"message":"Hi"}'
 *
 * On Foundry: see README.md.
 */

import { Agent } from '@polymind-inc/agent-framework';
import { serve } from '@polymind-inc/agent-framework/agentserver/node';
import { FoundryChatClient } from '@polymind-inc/agent-framework/foundry';
import { InvocationsHostServer } from '@polymind-inc/agent-framework/foundry/hosting';

const projectEndpoint = process.env.FOUNDRY_PROJECT_ENDPOINT;
if (projectEndpoint === undefined) {
  throw new Error('Set FOUNDRY_PROJECT_ENDPOINT to your Foundry project endpoint.');
}

const agent = new Agent({
  client: new FoundryChatClient({
    projectEndpoint,
    target: { modelDeployment: process.env.AZURE_AI_MODEL_DEPLOYMENT_NAME ?? 'gpt-4o-mini' },
  }),
  name: 'invocations-agent',
  instructions: 'You are a friendly assistant. Keep your answers brief.',
});

// The platform stores no conversation history for this protocol: the conversation lives in this
// process, keyed by the session id. Callers keep a conversation going by pinning the
// `agent_session_id` query parameter to the value the previous response's `x-agent-session-id`
// header reported.
const server = new InvocationsHostServer({ agent });

const { port } = await serve(server);
console.log(`listening on 0.0.0.0:${port}`);
