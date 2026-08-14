/**
 * `@polymind-inc/agent-framework-agentserver` — the Microsoft Foundry Responses container protocol v2.0.0,
 * as a server.
 *
 * Independent of the Agent Framework: an implementation supplies a {@link ResponseHandler} that
 * yields protocol events, and this package owns routing, SSE framing, sequence numbers, the
 * lifecycle contract, id generation, the header contract, storage and error shapes. The
 * Agent Framework adapter lives in `@polymind-inc/agent-framework-foundry/hosting`.
 *
 * The Node adapter is in the `./node` subpath, so the protocol itself stays on Web standards.
 */

export { readJsonBody } from './body.js';
export { isHosted, maxBodyBytes, projectEndpoint, stateRoot } from './config.js';
export type { RequestContext } from './context.js';
export {
  createRequestContext,
  getRequestContext,
  HEADERS,
  platformHeaders,
  runWithRequestContext,
} from './context.js';
export type { ErrorSource, ProtocolErrorOptions } from './errors.js';
export {
  badRequest,
  conflict,
  methodNotAllowed,
  notFound,
  notImplemented,
  ProtocolError,
  requestTooLarge,
  routeNotFound,
  serverError,
  toProtocolError,
  unavailable,
  upstreamError,
} from './errors.js';
export { ID_PREFIX, invalidIdReason, isValidId, newId, newResponseId, partitionKeyOf } from './ids.js';
export type {
  InvocationContext,
  InvocationHandler,
  InvocationsServerConfig,
} from './invocations.js';
export { INVOCATION_ID_HEADER, InvocationsServer } from './invocations.js';
export type {
  AgentReference,
  ApiError,
  ApiErrorDetail,
  ApiErrorResponse,
  CreateResponseRequest,
  DeletedResponse,
  IncompleteDetails,
  InputItemList,
  JsonObject,
  OutputItem,
  ResponseEvent,
  ResponseLifecycleEvent,
  ResponseObject,
  ResponseStatus,
  ResponseUsage,
  TerminalEventType,
} from './wire.js';
export { isTerminalEventType, TERMINAL_EVENT_TYPES } from './wire.js';
// The remaining config getters, the SSE framing internals (sse.ts) and the lifecycle
// enforcement machinery (lifecycle.ts values) are internal — the server owns those
// responsibilities and handlers must not re-implement them.

export type { LifecycleViolation } from './lifecycle.js';

export type {
  HandlerContext,
  ResponseHandler,
  ResponsesServerConfig,
  ResponsesServerLimits,
} from './server.js';
export { ResponsesServer } from './server.js';
export type { AgentSessionIdOptions } from './session-id.js';
export { resolveAgentReference, resolveAgentSessionId } from './session-id.js';
export { FileResponseProvider } from './store/file.js';
export type { InMemoryResponseProviderConfig } from './store/memory.js';
export { InMemoryResponseProvider } from './store/memory.js';
export type {
  ResponseGeneration,
  ResponseOwner,
  ResponseProvider,
  StoredResponse,
} from './store/provider.js';
export {
  assertWritable,
  historyOf,
  isCurrentGeneration,
  isOwnedBy,
  ownedOrUndefined,
  sameOwner,
} from './store/provider.js';
export { conversationIdOf } from './validation.js';
