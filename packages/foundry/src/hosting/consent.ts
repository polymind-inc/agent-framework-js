/**
 * OAuth consent for the Foundry MCP gateway.
 *
 * When a tool behind a toolbox needs the end user's OAuth consent, the gateway answers the MCP
 * request with JSON-RPC error `-32006` whose message embeds a JSON envelope naming each tool
 * source and its consent URL. The container's job is to surface that as an
 * `oauth_consent_request` output item and finish the response `incomplete`, so the caller sends
 * the user to the link and retries the turn (Python `_responses.py`: `consent_url_from_error` →
 * `OAuthConsentRequestOutputItem`).
 *
 * This module is deliberately free of MCP SDK imports: the handler and the output builder need
 * the *shape* of a consent request, not a client.
 *
 * Recognising consent is split by where the refusal was hit. Agent *construction* throws, and the
 * throw reaches the handler intact, so {@link consentRequestsOf} matches it by type (or by the
 * gateway's numeric `-32006`). A tool *call* is reduced to text by the function-calling loop, so
 * it reports out of band instead — `consent-channel.ts`.
 */

import { isRecord } from '@polymind-inc/agent-framework-core/internal';

/** The JSON-RPC error code the Foundry MCP gateway uses for CONSENT_REQUIRED. */
export const CONSENT_REQUIRED_JSON_RPC_CODE = -32006;

/** One tool source waiting on the end user's OAuth consent. */
export interface ToolboxConsentRequest {
  /** The name of the tool source that needs consent — becomes the item's `server_label`. */
  readonly serverLabel: string;
  /** The URL the user must visit to grant consent — becomes the item's `consent_link`. */
  readonly consentLink: string;
}

/**
 * A toolbox operation that cannot proceed until the end user grants OAuth consent.
 *
 * Thrown by `FoundryToolbox` when the gateway answers `tools/list` or `tools/call` with JSON-RPC
 * error `-32006`. Deliberately *not* a connection failure: the answer is a definitive response,
 * so the reconnect-and-retry path never touches it — retrying cannot make the user consent.
 *
 * The message is prose for humans and carries no envelope. It used to re-emit the gateway's JSON
 * so the handler could parse consent back out of `function_result.exception`; that made the string
 * a protocol channel any tool could write to. Consent from a tool *call* now travels
 * out of band — see `consent-channel.ts` — and from agent *construction* by this error's type.
 */
export class ToolboxConsentRequiredError extends Error {
  /** The tool sources waiting on consent, with their consent links. */
  readonly consents: readonly ToolboxConsentRequest[];

  constructor(consents: readonly ToolboxConsentRequest[]) {
    super(
      'OAuth consent is required before the Foundry toolbox can be used. ' +
        'Visit the consent link and retry. Tool sources awaiting consent: ' +
        (consents.map((consent) => consent.serverLabel).join(', ') || 'none') +
        '.',
    );
    this.name = 'ToolboxConsentRequiredError';
    this.consents = [...consents];
  }
}

/**
 * Extracts consent requests from *the gateway's own* error message.
 *
 * Mirrors Python `consent_url_from_error`: the JSON envelope starts at the first `{`; entries
 * count only when they are `type: "mcp"` with `error.code === "CONSENT_REQUIRED"` and a string
 * `error.message` (the consent URL).
 *
 * **Only ever call this on a message whose origin is already established** — in this package that
 * means {@link consentRequestsOf}, which reaches it only after matching the numeric JSON-RPC code
 * `-32006` on an MCP SDK error object. Shape is not provenance: any text can be made to satisfy
 * this parser, so applying it to tool- or model-authored strings hands the consent flow to
 * whoever wrote them.
 */
export function consentRequestsFromMessage(message: string): ToolboxConsentRequest[] | undefined {
  const start = message.indexOf('{');
  if (start < 0) {
    return undefined;
  }
  let details: unknown;
  try {
    details = JSON.parse(message.slice(start));
  } catch {
    return undefined;
  }
  if (!isRecord(details) || !Array.isArray(details.errors)) {
    return undefined;
  }
  const consents: ToolboxConsentRequest[] = [];
  for (const entry of details.errors) {
    if (!isRecord(entry) || entry.type !== 'mcp' || !isRecord(entry.error)) {
      continue;
    }
    const error = entry.error;
    if (error.code !== 'CONSENT_REQUIRED' || typeof error.message !== 'string') {
      continue;
    }
    consents.push({
      serverLabel: typeof entry.name === 'string' && entry.name !== '' ? entry.name : 'Unknown',
      consentLink: error.message,
    });
  }
  return consents.length > 0 ? consents : undefined;
}

/**
 * Extracts consent requests from a thrown error, whatever layer threw it.
 *
 * Matches the typed {@link ToolboxConsentRequiredError} first, then any JSON-RPC-shaped error
 * whose numeric `code` is `-32006` (the MCP SDK surfaces a JSON-RPC error *answer* as an error
 * object carrying the wire code — SDK-local errors use string codes, so there is no collision).
 */
export function consentRequestsOf(error: unknown): ToolboxConsentRequest[] | undefined {
  if (error instanceof ToolboxConsentRequiredError) {
    return [...error.consents];
  }
  if (!isRecord(error)) {
    return undefined;
  }
  if (error.code === CONSENT_REQUIRED_JSON_RPC_CODE && typeof error.message === 'string') {
    return consentRequestsFromMessage(error.message);
  }
  return undefined;
}
