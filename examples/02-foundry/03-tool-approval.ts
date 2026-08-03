/**
 * 03 — Human-in-the-loop tool approval.
 *
 * A tool declared `approvalMode: 'always_require'` interrupts the run instead of executing. The
 * call is surfaced on `response.userInputRequests`, and the run resumes when the decision is
 * passed back in — which is what makes the flow survive a process restart, since the pending
 * request lives in the session.
 *
 * This one runs entirely locally against a scripted client, so it needs no credentials:
 *   pnpm --filter example-02-foundry approval
 */
import type {
  ChatClient,
  ChatOptions,
  ChatResponse,
  ChatResponseStream,
  ChatResponseUpdate,
  Message,
} from '@polymind-inc/agent-framework-core';
import {
  Agent,
  AgentSession,
  approvalResponse,
  chatResponseUpdate,
  createResponseStream,
  mergeChatUpdates,
  textContent,
  tool,
} from '@polymind-inc/agent-framework-core';

const deleteEverything = tool({
  name: 'delete_everything',
  description: 'Permanently delete every file in the workspace',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  // Without this the model's request would simply run.
  approvalMode: 'always_require',
  execute: async () => 'Deleted 1,204 files.',
});

/** Stands in for a model: asks for the tool, then comments on the outcome. */
class ScriptedClient implements ChatClient<ChatOptions> {
  readonly metadata = { providerName: 'scripted', modelId: 'scripted' };
  #turn = 0;

  getResponse(_messages: Message[]): ChatResponseStream {
    const turn = this.#turn++;
    const update =
      turn === 0
        ? chatResponseUpdate({
            contents: [
              { type: 'function_call', callId: 'call_1', name: 'delete_everything', arguments: '{}' },
            ],
            role: 'assistant',
            messageId: 'msg_1',
            finishReason: 'tool_calls',
          })
        : chatResponseUpdate({
            contents: [textContent('Done — the workspace is empty.')],
            role: 'assistant',
            messageId: `msg_${turn + 1}`,
            finishReason: 'stop',
          });

    return createResponseStream<ChatResponseUpdate, ChatResponse<undefined>>({
      start: async function* () {
        yield update;
      },
      finalize: (updates) => mergeChatUpdates<undefined>(updates),
    });
  }
}

const agent = new Agent({
  client: new ScriptedClient(),
  instructions: 'You are a workspace assistant.',
  tools: [deleteEverything],
});

const session = agent.createSession();

// The run stops here rather than executing.
const paused = await agent.run('Clean up the workspace.', { session });
// `userInputRequests` can also carry OAuth consent requests, so narrow to the approval kind.
const [request] = paused.userInputRequests;
if (request?.type !== 'function_approval_request') {
  throw new Error('Expected an approval request.');
}
console.log('[paused] the agent wants to call:', request.functionCall.name);
console.log('[paused] arguments:', request.functionCall.arguments);

// The decision usually arrives on a later turn, from a different process. Only the serialized
// session bridges the two, and it is what the framework checks the decision against.
const restored = AgentSession.fromJSON(JSON.parse(JSON.stringify(session)));

const approved = await agent.run(approvalResponse(request, true), { session: restored });
console.log('[approved]', approved.text);

// Denying instead reports a refusal to the model rather than executing the tool.
const denialSession = agent.createSession();
const pausedAgain = await new Agent({
  client: new ScriptedClient(),
  tools: [deleteEverything],
}).run('Clean up the workspace.', { session: denialSession });

const secondRequest = pausedAgain.userInputRequests[0];
if (secondRequest?.type !== 'function_approval_request') {
  throw new Error('Expected an approval request.');
}
const denied = await agent.run(approvalResponse(secondRequest, false, { reason: 'Not authorized.' }), {
  session: denialSession,
});
console.log('[denied]', JSON.stringify(denied.messages.at(-2)?.contents));
