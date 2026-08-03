import { APPROVAL_RESPONSE_METADATA_KEY } from '../client/function-invocation.js';
import { approvalRequestId, MIDDLEWARE_APPROVAL_KEY } from '../tools/approval.js';
import type { AnyFunctionTool } from '../tools/tool.js';
import type { FunctionApprovalRequestContent } from '../types/content.js';
import type { FunctionMiddleware, FunctionMiddlewareContext } from './middleware.js';
import { functionMiddleware } from './middleware.js';

/** What a rule sees when it decides whether a call needs a human. */
export interface ToolApprovalRuleContext {
  readonly tool: AnyFunctionTool;
  /** The validated arguments the tool is about to receive. */
  readonly arguments: unknown;
  readonly callId: string;
}

/** One rule of a {@link toolApprovalMiddleware} policy. */
export interface ToolApprovalRule {
  /** Tool names this rule applies to. Matches every tool when omitted. */
  tools?: string | readonly string[];
  /**
   * Narrows the rule to specific calls — a threshold on an argument, for example.
   *
   * A rule with no `when` matches every call of its tools.
   */
  when?: (ctx: ToolApprovalRuleContext) => boolean | Promise<boolean>;
  /** `'require'` (the default) sends the call to a human; `'allow'` lets it run. */
  decision?: 'require' | 'allow';
  /** Shown with the request, so a human knows which rule stopped the call. */
  reason?: string;
}

function matchesTool(rule: ToolApprovalRule, name: string): boolean {
  if (rule.tools === undefined) {
    return true;
  }
  return typeof rule.tools === 'string' ? rule.tools === name : rule.tools.includes(name);
}

/**
 * Requires human approval for the tool calls a policy selects.
 *
 * Rules are evaluated in order and the first match decides, so a narrow `'allow'` can sit in front
 * of a broad `'require'`:
 *
 * ```ts
 * const policy = toolApprovalMiddleware([
 *   { tools: 'transfer_funds', when: ({ arguments: a }) => (a as { amount: number }).amount < 100, decision: 'allow' },
 *   { tools: ['transfer_funds', 'delete_account'], reason: 'Irreversible operation' },
 * ]);
 * ```
 *
 * A matched call is not executed. It is surfaced on `response.userInputRequests` exactly like a
 * tool declared `approvalMode: 'always_require'`, and answering it with `approvalResponse(request,
 * true)` on the next run executes the call — this middleware only decides, the existing approval
 * layer stores, binds and replays. A call that arrives already approved is passed
 * straight through, so a granted decision is never re-asked.
 *
 * ## Security considerations
 *
 * A rule is a decision, not a sandbox: it runs after the arguments are validated but the tool body
 * is what enforces authority. Prefer `decision: 'require'` as the last, broadest rule so a tool
 * added later is stopped by default rather than allowed by omission.
 */
export function toolApprovalMiddleware(rules: readonly ToolApprovalRule[]): FunctionMiddleware {
  return functionMiddleware(
    async (ctx: FunctionMiddlewareContext, next: () => Promise<void>) => {
      // The human already answered this one; asking again would loop forever.
      if (ctx.metadata[APPROVAL_RESPONSE_METADATA_KEY] !== undefined) {
        await next();
        return;
      }

      const ruleContext: ToolApprovalRuleContext = {
        tool: ctx.tool,
        arguments: ctx.arguments,
        callId: ctx.callId,
      };
      for (const rule of rules) {
        if (!matchesTool(rule, ctx.tool.name)) {
          continue;
        }
        if (rule.when !== undefined && !(await rule.when(ruleContext))) {
          continue;
        }
        if ((rule.decision ?? 'require') === 'allow') {
          break;
        }
        ctx.terminate(approvalRequest(ctx, rule.reason));
      }
      await next();
    },
    { name: 'toolApprovalMiddleware' },
  );
}

/** Builds the request a human answers, carrying the arguments the rule actually saw. */
function approvalRequest(
  ctx: FunctionMiddlewareContext,
  reason: string | undefined,
): FunctionApprovalRequestContent {
  return {
    type: 'function_approval_request',
    id: approvalRequestId(ctx.callId),
    userInputRequest: true,
    functionCall: {
      type: 'function_call',
      callId: ctx.callId,
      name: ctx.tool.name,
      arguments: ctx.arguments as Record<string, unknown>,
    },
    additionalProperties: {
      [MIDDLEWARE_APPROVAL_KEY]: true,
      ...(reason === undefined ? {} : { reason }),
    },
  };
}
