/**
 * Wire types for the Microsoft Foundry Responses container protocol v2.0.0.
 *
 * ## Provenance
 *
 * These are hand-authored from the generated Python types in
 * `azure-sdk-for-python/sdk/agentserver/azure-ai-agentserver-responses/azure/ai/agentserver/
 * responses/models/_generated/types.py`, which are themselves emitted from TypeSpec at
 * `Azure/azure-rest-api-specs` commit **486f5dcc2ca1d2b23d7ad4b35b4e8763db6a9d68**, directory
 * `specification/ai-foundry/data-plane/Foundry/src/sdk-service-agentserver-contracts`.
 *
 * Generating them from TypeSpec was tried first and does not currently work:
 * the spec at that commit fails to compile against the only published version of its
 * `@azure-tools/openai-typespec` dependency (354 `invalid-ref` errors), the pin file its
 * `tsp-location.yaml` names does not exist in the repo, and the emitters it configures produce a
 * C# client and an OpenAPI document — no TypeScript, and a *client* rather than a server.
 *
 * This is a **subset**: the shapes this server has to read, write or route on. Everything else
 * passes through as unmodelled JSON, which is why most shapes carry an index signature — a newer
 * platform must not be broken by a field this version does not know.
 */

/** JSON as it arrives: unmodelled fields survive a round trip. */
export type JsonObject = Record<string, unknown>;

// region request

/** Which Foundry agent should answer, when the container hosts more than one. */
export interface AgentReference {
  type: 'agent_reference';
  name: string;
  version?: string;
}

/**
 * `POST /responses` — the OpenAI `CreateResponse` body plus the Foundry extensions.
 *
 * Only the fields the protocol layer itself acts on are named; a handler reads the rest straight
 * off the object.
 */
export interface CreateResponseRequest extends JsonObject {
  input?: unknown;
  model?: string;
  instructions?: string;
  stream?: boolean;
  background?: boolean;
  store?: boolean;
  previous_response_id?: string;
  conversation?: string | { id?: string };
  metadata?: Record<string, string>;
  stream_options?: JsonObject;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  parallel_tool_calls?: boolean;
  tools?: JsonObject[];
  tool_choice?: unknown;
  text?: JsonObject;
  include?: string[];

  // Foundry extensions
  agent_reference?: AgentReference;
  agent_session_id?: string;
  response_id?: string;
  structured_inputs?: JsonObject;
  context_management?: unknown[];
}

// endregion
// region response

/** Lifecycle states a response moves through. Exactly one of the last three is terminal. */
export type ResponseStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'incomplete' | 'cancelled';

/** Why a response stopped short of completing. */
export interface IncompleteDetails {
  reason?: string;
}

/** Token accounting reported on a finished response. */
export interface ResponseUsage extends JsonObject {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: JsonObject;
  output_tokens_details?: JsonObject;
}

/** One entry of a response's `output` array: a message, a tool call, reasoning, … */
export interface OutputItem extends JsonObject {
  type: string;
  id?: string;
}

/** The response resource, as returned by every route that produces one. */
export interface ResponseObject extends JsonObject {
  id: string;
  object: 'response';
  created_at: number;
  status: ResponseStatus;
  output: OutputItem[];
  error?: ApiError | null;
  incomplete_details?: IncompleteDetails | null;
  model?: string;
  usage?: ResponseUsage;
  metadata?: Record<string, string>;
  previous_response_id?: string;
  conversation?: { id: string } | null;
  /**
   * Stamped `true` on a background response, absent otherwise. Persisted, because the replay and
   * cancel routes decide their error shapes by it long after the run is gone (Python
   * `_endpoint_handler._handle_get_fallback` reads `persisted["background"]` the same way).
   */
  background?: boolean;

  // Foundry extensions
  agent?: JsonObject;
  agent_session_id?: string;
  agent_reference?: AgentReference;
}

/** `DELETE /responses/{id}`. */
export interface DeletedResponse {
  id: string;
  object: 'response';
  deleted: true;
}

/** `GET /responses/{id}/input_items`. */
export interface InputItemList {
  object: 'list';
  data: OutputItem[];
  first_id?: string | null;
  last_id?: string | null;
  has_more: boolean;
}

// endregion
// region errors

/** One field-level problem inside an {@link ApiError}. */
export interface ApiErrorDetail {
  code?: string;
  message: string;
  /** JSON path into the request body, for example `$.input`. */
  param?: string;
  /** Always `invalid_request_error` on the wire; filled in when the envelope is rendered. */
  type?: string;
}

/** The error object the protocol returns; never carries internal diagnostics. */
export interface ApiError {
  code: string;
  message: string;
  type: string;
  param?: string | null;
  details?: ApiErrorDetail[];
  additionalInfo?: JsonObject;
}

/** The error response envelope. */
export interface ApiErrorResponse {
  error: ApiError;
}

// endregion
// region events

/** The three events that end a response. Exactly one may be emitted per stream. */
export const TERMINAL_EVENT_TYPES: readonly ['response.completed', 'response.failed', 'response.incomplete'] =
  ['response.completed', 'response.failed', 'response.incomplete'] as const;

/** An event that ends a response. */
export type TerminalEventType = (typeof TERMINAL_EVENT_TYPES)[number];

const TERMINAL_SET: ReadonlySet<string> = new Set(TERMINAL_EVENT_TYPES);

/** Whether `type` ends the response. */
export function isTerminalEventType(type: string): type is TerminalEventType {
  return TERMINAL_SET.has(type);
}

/**
 * One protocol event.
 *
 * `sequence_number` is stamped by the SSE writer, not by the handler: it has to be a single
 * gap-free sequence per stream so a client can resume with `starting_after`.
 */
export interface ResponseEvent extends JsonObject {
  type: string;
  sequence_number?: number;
}

/** A lifecycle event, which always carries the response resource. */
export interface ResponseLifecycleEvent extends ResponseEvent {
  response: ResponseObject;
}

// endregion
