import { ConfigurationError, UserInputRequiredError } from '../errors.js';
import type { FunctionTool, ToolContext } from '../tools/tool.js';
import { tool } from '../tools/tool.js';
import type { AgentLike } from './agent.js';
import { AgentSession } from './session.js';

/**
 * The part of an agent {@link agentAsTool} drives.
 *
 * Structural rather than `AgentLike` itself, so a custom agent can satisfy its own `asTool` member
 * by delegating here without the type becoming self-referential.
 */
export type ToolableAgent = Pick<AgentLike, 'name' | 'description' | 'run'>;

/** Options for {@link agentAsTool} / `Agent.asTool`. */
export interface AgentAsToolOptions {
  /**
   * The tool's name. Defaults to the agent's name, sanitized into something a provider accepts.
   *
   * @throws {ConfigurationError} When neither this nor `agent.name` is set.
   */
  name?: string;
  /** Shown to the model. Defaults to the agent's `description`, then to the empty string. */
  description?: string;
  /** The name of the single string argument the tool declares. Default `'task'`. */
  argName?: string;
  /**
   * Share the calling agent's conversation state with the sub-agent. Default `false`.
   *
   * When `false` the sub-agent runs with no session, so each call starts from a clean slate and
   * the delegation is a pure function of the argument. When `true` the sub-agent runs against a
   * session that shares the caller's `state` object, so both agents see the same transcript.
   */
  propagateSession?: boolean;
}

/**
 * Turns an agent name into something usable as a tool name.
 *
 * Ports Python `_sanitize_agent_name`: non-word characters become `_`, runs collapse, the ends are
 * trimmed, an empty result becomes `'agent'`, and a leading digit gets an `_` prefix.
 */
function sanitizeAgentName(agentName: string): string {
  const collapsed = agentName.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_');
  // Runs are already collapsed, so at most one `_` can sit at either end. Matching a single
  // character keeps the trim linear; `/_+$/` would rescan the tail from every position.
  const trimmed = collapsed.replace(/^_/, '').replace(/_$/, '');
  if (trimmed === '') {
    return 'agent';
  }
  return /^[0-9]/.test(trimmed) ? `_${trimmed}` : trimmed;
}

/**
 * The session the sub-agent runs with when `propagateSession` is on.
 *
 * A *child* session rather than the caller's own object, matching Python: it keeps the caller's
 * `sessionId` and shares its `state` by reference — so the sub-agent reads and writes the same
 * transcript — but starts with no `serviceSessionId`. The sub-agent talks to a different model
 * deployment, or a different service conversation altogether, and adopting the parent's
 * service-side conversation id would append its turns to the caller's server-stored transcript.
 * Not mutating the caller's session in place also keeps concurrent tool calls that share one
 * session from racing on it.
 */
function childSessionOf(parent: AgentSession): AgentSession {
  return new AgentSession({ sessionId: parent.sessionId, state: parent.state });
}

/**
 * Exposes an agent as a {@link FunctionTool} another agent can call.
 *
 * ```ts
 * const researcher = new Agent({ client, name: 'researcher', description: 'Looks things up.' });
 * const writer = new Agent({ client, tools: [agentAsTool(researcher)] });
 * ```
 *
 * The tool declares one required string argument and returns the sub-agent's `response.text`. All
 * three reference implementations do exactly this: .NET `AsAIFunction` returns `response.Text`,
 * Python `as_tool` returns `final_response.text`, Go `agenttool` returns the concatenated text of
 * the response. Rich content the sub-agent produced is therefore *not* forwarded — the sub-agent's
 * prose is the answer, and a caller who needs more should drive it directly.
 *
 * Errors are not caught: whatever the sub-agent throws reaches the calling agent's function-calling
 * loop, which reports it to the model as a failed `function_result` like any other tool error
 * (.NET and Python both let them propagate). The exception is a sub-agent that stopped for a human
 * — see {@link UserInputRequiredError}.
 *
 * ## Security considerations
 *
 * The argument is written by the *calling* model, so a sub-agent used as a tool is reachable by
 * anything that can influence the caller's context window. It inherits none of the caller's
 * authorization; give it its own tools and its own limits, and remember that with
 * `propagateSession: true` the sub-agent reads the caller's whole transcript.
 *
 * @throws {ConfigurationError} When no tool name can be resolved, or `argName` is empty.
 */
export function agentAsTool(
  agent: ToolableAgent,
  options: AgentAsToolOptions = {},
): FunctionTool<Record<string, unknown>, string> {
  const explicitName = options.name;
  const toolName =
    explicitName !== undefined && explicitName !== ''
      ? explicitName
      : agent.name === undefined
        ? undefined
        : sanitizeAgentName(agent.name);
  if (toolName === undefined) {
    throw new ConfigurationError(
      'Cannot use this agent as a tool: it has no name. Give the agent a name, or pass one as ' +
        "asTool({ name: '…' }).",
    );
  }
  const explicitDescription = options.description;
  const description =
    explicitDescription !== undefined && explicitDescription !== ''
      ? explicitDescription
      : (agent.description ?? '');

  const argName = options.argName ?? 'task';
  if (argName === '') {
    throw new ConfigurationError('Cannot use this agent as a tool: argName must not be empty.');
  }
  const propagateSession = options.propagateSession ?? false;

  return tool({
    name: toolName,
    description,
    parameters: {
      type: 'object',
      properties: {
        [argName]: { type: 'string', description: `Task for ${toolName}` },
      },
      required: [argName],
      additionalProperties: false,
    },
    execute: async (input: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
      const raw = input[argName];
      const task = raw === undefined || raw === null ? '' : String(raw);
      const parent = propagateSession ? ctx.session : undefined;
      const response = await agent.run(task, {
        ...(parent === undefined ? {} : { session: childSessionOf(parent) }),
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
      if (response.userInputRequests.length > 0) {
        // The sub-agent is waiting on an approval or a consent link. There is no answer to hand
        // back, and the calling model cannot grant one, so the run stops here for the caller to
        // settle (Python raises `UserInputRequiredException` at the same point).
        throw new UserInputRequiredError(
          response.userInputRequests,
          `Agent tool '${toolName}' stopped because its sub-agent is waiting for human input.`,
        );
      }
      return response.text;
    },
  });
}
