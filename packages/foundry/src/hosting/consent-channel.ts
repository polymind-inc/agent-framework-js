/**
 * The out-of-band channel that carries a toolbox consent refusal from the tool that hit it to the
 * hosting handler that surfaces it.
 *
 * ## Why this is not a string
 *
 * The function-calling loop reduces a thrown tool error to `function_result.exception` — text —
 * and a tool's error text is not trustworthy: a toolbox fronts many third-party tool sources, and
 * an MCP source reports failure *in its payload* (`isError: true`), so the source chooses the
 * message verbatim. While consent was recognised by parsing that text, any tool could emit the
 * gateway's envelope and have the platform render an `oauth_consent_request` — an official-looking
 * consent prompt — for an attacker's URL under an attacker's `server_label`, and halt the turn
 * while doing it. Protocol meaning must never be recovered from model- or tool-authored text.
 *
 * Both reference implementations keep consent off the string channel: Python matches the *typed*
 * `McpError` and its numeric JSON-RPC code `-32006` (`_responses.py`: `consent_url_from_error`),
 * and .NET catches `McpProtocolException` and carries the result in `McpConsentContext.Current`,
 * an `AsyncLocal` (`ConsentAwareMcpClientAIFunction.cs`). This module is the .NET shape: an
 * `AsyncLocalStorage` scoped to one turn.
 *
 * ## Why ambient rather than a parameter
 *
 * The toolbox is wired into the agent by the application, not by the handler, so there is no
 * argument the handler could hand down to it. The report has to travel with the async context the
 * tool call already runs in. `node:async_hooks` is safe to import here: this package's hosting
 * layer is Node-only already (the session store and approval storage use `node:fs`/`node:os`).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolboxConsentRequest } from './consent.js';

/** One turn's consent reports, keyed by the `callId` of the tool call that hit the refusal. */
export interface ConsentChannel {
  /** Consents reported by a tool call, so the handler can match them to its `function_result`. */
  readonly byCallId: Map<string, ToolboxConsentRequest[]>;
}

const storage = new AsyncLocalStorage<ConsentChannel>();

/** A fresh, empty channel for one turn. */
export function createConsentChannel(): ConsentChannel {
  return { byCallId: new Map() };
}

/**
 * Records a consent refusal hit by the tool call `callId`.
 *
 * Exported as `reportToolboxConsent` for applications that front their own consent-bearing
 * gateway: throwing `ToolboxConsentRequiredError` from a tool is not enough on its own, because
 * the loop keeps only the message. Reporting is in-process code the application wrote, which is
 * exactly the trust boundary the string channel failed to draw.
 *
 * A no-op outside a turn: the toolbox works without the hosting handler, and there the typed
 * error the caller throws is the whole story.
 */
export function reportConsent(callId: string, consents: readonly ToolboxConsentRequest[]): void {
  const channel = storage.getStore();
  if (channel === undefined || consents.length === 0) {
    return;
  }
  const existing = channel.byCallId.get(callId);
  if (existing === undefined) {
    channel.byCallId.set(callId, [...consents]);
  } else {
    existing.push(...consents);
  }
}

/**
 * Drives `stream` with `channel` installed as the ambient channel.
 *
 * Each `next()` is invoked *inside* `AsyncLocalStorage.run`, which is where the agent runs the
 * round — including the tool calls — so a report from a tool lands in this turn's channel and
 * nowhere else. Wrapping the whole `for await` instead would leave the store's propagation into
 * the generator's resumption up to where the loop happened to be suspended.
 */
export async function* withConsentChannel<T>(
  channel: ConsentChannel,
  stream: AsyncIterable<T>,
): AsyncGenerator<T, void, undefined> {
  const iterator = stream[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await storage.run(channel, () => iterator.next());
      if (next.done === true) {
        return;
      }
      yield next.value;
    }
  } finally {
    // `break` in the consumer has to reach the agent's own cleanup (session save, tool teardown)
    // exactly as it would without this wrapper.
    await iterator.return?.();
  }
}
