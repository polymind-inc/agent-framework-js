import type {
  Content,
  FunctionApprovalRequestContent,
  FunctionApprovalResponseContent,
  FunctionCallContent,
} from '../types/content.js';

/**
 * Derives the approval request id for a tool call.
 *
 * The `ficc_` prefix and the derivation from the call id match Go's `composeApprovalRequestID`,
 * so an approval request serialized by one implementation pairs with a response produced by
 * another.
 */
export function approvalRequestId(callId: string): string {
  return `ficc_${callId}`;
}

/** Wraps a tool call in the approval request the caller sees on `response.userInputRequests`. */
export function functionApprovalRequestContent(
  functionCall: FunctionCallContent,
  id: string = approvalRequestId(functionCall.callId),
): FunctionApprovalRequestContent {
  return { type: 'function_approval_request', id, functionCall, userInputRequest: true };
}

/**
 * Answers a pending tool approval.
 *
 * Include the result in the next `run()` input to resume the interrupted loop:
 *
 * ```ts
 * const response = await agent.run('delete everything', { session });
 * const [request] = response.userInputRequests;
 * const decision = approvalResponse(request, await confirmWithHuman(request));
 * const resumed = await agent.run(decision, { session });
 * ```
 *
 * ## Security considerations
 *
 * The framework binds the decision back to the request it actually issued, so the approved call
 * always carries the tool name and arguments a human was shown: a response whose `id` was never
 * issued in this session is dropped, and a tampered `functionCall` is replaced by the recorded
 * one. That binding needs the same {@link AgentSession} the request came from — approving through
 * a fresh session silently discards the decision rather than executing an unvetted call.
 */
export function approvalResponse(
  request: FunctionApprovalRequestContent,
  approved: boolean,
  options?: { reason?: string },
): FunctionApprovalResponseContent {
  const response: FunctionApprovalResponseContent = {
    type: 'function_approval_response',
    id: request.id,
    approved,
    functionCall: request.functionCall,
  };
  if (options?.reason !== undefined) {
    response.reason = options.reason;
  }
  return response;
}

/**
 * `true` when the wrapped `functionCall` is present and structurally usable.
 *
 * Deserialization (`deserializeContent`) casts known wire `type`s without validating their
 * fields, so approval content arriving from the wire — replayed history, another implementation,
 * a hosting layer — can be missing its `functionCall` even though the TypeScript type requires
 * it. The approval machinery reads `functionCall.callId` / `.name` / `.additionalProperties` in
 * several places; without this check a single malformed item would crash the whole run with a
 * `TypeError` instead of being ignored.
 */
function hasWellFormedCall(content: { functionCall?: FunctionCallContent | undefined }): boolean {
  const call: unknown = content.functionCall;
  return (
    typeof call === 'object' &&
    call !== null &&
    typeof (call as FunctionCallContent).callId === 'string' &&
    typeof (call as FunctionCallContent).name === 'string'
  );
}

/**
 * Returns `true` when `content` is a well-formed {@link FunctionApprovalRequestContent}.
 *
 * A wire item with the right `type` but a missing or malformed `functionCall` is *not* matched:
 * it cannot be bound, executed or re-materialized, so the approval layers treat it as inert
 * content and pass it through instead of crashing on it.
 */
export function isApprovalRequest(content: Content): content is FunctionApprovalRequestContent {
  return (
    content.type === 'function_approval_request' &&
    typeof content.id === 'string' &&
    hasWellFormedCall(content)
  );
}

/**
 * Returns `true` when `content` is a well-formed {@link FunctionApprovalResponseContent}.
 *
 * See {@link isApprovalRequest} for why malformed wire items are not matched.
 */
export function isApprovalResponse(content: Content): content is FunctionApprovalResponseContent {
  return (
    content.type === 'function_approval_response' &&
    typeof content.id === 'string' &&
    typeof content.approved === 'boolean' &&
    hasWellFormedCall(content)
  );
}

/**
 * Whether an approval request or decision belongs to a **provider-hosted** tool.
 *
 * A hosted MCP server raises its own approvals and is the only thing that can settle them, so the
 * framework's approval machinery has to leave them completely alone: not bind them, not strip them
 * from what the provider sees, and above all not try to execute the call locally — the tool is not
 * registered here, so it would come back as a fabricated "not found" result while the real
 * approval stayed pending forever.
 *
 * The marker is `server_label` on the wrapped call, which is exactly how Python's
 * `_is_hosted_tool_approval` decides.
 */
export function isHostedApproval(content: Content): boolean {
  if (!isApprovalRequest(content) && !isApprovalResponse(content)) {
    return false;
  }
  const label = content.functionCall.additionalProperties?.server_label;
  return typeof label === 'string' && label !== '';
}

/**
 * Marks an approval request raised by a middleware rather than by a tool's `approvalMode`.
 *
 * The bypass half of {@link withToolApproval} suppresses requests for tools declared
 * `never_require` and replays them pre-approved, because the loop surfaces a whole round once any
 * call in it needs a human. A middleware-raised request is about *this* call, not about the tool's
 * declaration, so it must survive that filter — otherwise a policy check would be answered by the
 * framework instead of by a person.
 */
export const MIDDLEWARE_APPROVAL_KEY = 'requiredByMiddleware';

/** Returns `true` when a middleware raised this approval request. See {@link MIDDLEWARE_APPROVAL_KEY}. */
export function isMiddlewareApproval(request: FunctionApprovalRequestContent): boolean {
  return request.additionalProperties?.[MIDDLEWARE_APPROVAL_KEY] === true;
}

/**
 * The reason a caller attached to an approval decision, when there is one.
 *
 * Reads the first-class field, falling back to `additionalProperties.reason` — where earlier
 * serialized transcripts wrote it, and where a transcript from another implementation may still
 * carry it.
 */
export function approvalReason(response: FunctionApprovalResponseContent): string | undefined {
  const candidates: unknown[] = [response.reason, response.additionalProperties?.reason];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate;
    }
  }
  return undefined;
}
