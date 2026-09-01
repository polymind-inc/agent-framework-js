/**
 * How an MCP tool declaration becomes one a model provider accepts.
 *
 * Shared by every consumer of a `tools/list` result — the MCP client and the Foundry toolbox,
 * which speaks MCP over its own connection — so the same remote tool surfaces under the same name
 * and schema wherever it is loaded from, and a defect fixed in one place cannot survive in a copy.
 */
import { AgentFrameworkError } from '@polymind-inc/agent-framework-core';

/** Characters a provider accepts in a function name; everything else normalizes to `-`. */
const DISALLOWED_NAME_CHARACTERS = /[^A-Za-z0-9_.-]/g;
/** The separators trimmed off each side of the `<prefix>_<name>` join. */
const SEPARATORS = new Set(['_', '.', '-']);

/**
 * Trims separators off one end of a name.
 *
 * A scan rather than an anchored `[_.-]+` regex: the name is server-chosen, and `replace` retries
 * an end-anchored pattern at every start position, rescanning a long separator run once per
 * position — quadratic overall even though each attempt is linear, which is what lets a hostile
 * declaration stall the loader. The scan reads each character once.
 */
function trimSeparators(value: string, from: 'start' | 'end'): string {
  if (from === 'start') {
    let start = 0;
    while (start < value.length && SEPARATORS.has(value[start] as string)) {
      start++;
    }
    return value.slice(start);
  }
  let end = value.length;
  while (end > 0 && SEPARATORS.has(value[end - 1] as string)) {
    end--;
  }
  return value.slice(0, end);
}

/**
 * Rewrites a server-chosen name into the identifier pattern providers accept.
 *
 * MCP puts no restriction on a tool name, while OpenAI and the other providers only accept
 * `[A-Za-z0-9_.-]` in a function name — so a server offering `search docs!` would otherwise turn
 * into a request the provider rejects. The rule is the reference implementations': Python's
 * `_normalize_mcp_name` and Go's `normalizeMCPName` both replace every other character with `-`,
 * so the same remote tool surfaces under the same name across the SDKs.
 */
function normalizeToolName(name: string): string {
  return name.replace(DISALLOWED_NAME_CHARACTERS, '-');
}

/**
 * Claims one exposed name for a remote tool, refusing a collision.
 *
 * Normalization can land two different remote names on the same exposed name (`a b` and `a-b`
 * both become `a-b`). Silently keeping one would make the other unreachable, and which one
 * survived would depend on the order the server happened to list them in — so a collision throws,
 * naming both remote tools. The same remote name listed twice names the same target; its later
 * copies answer `'duplicate'` so the caller skips them, since offering the name twice is the
 * duplicate-name rejection the normalization exists to avoid.
 *
 * `origin` names the tool source in the error — the MCP server, or the Foundry toolbox.
 */
export function claimLocalName(
  claims: Map<string, string>,
  localName: string,
  remoteName: string,
  origin: string,
): 'claimed' | 'duplicate' {
  const claimedBy = claims.get(localName);
  if (claimedBy === undefined) {
    claims.set(localName, remoteName);
    return 'claimed';
  }
  if (claimedBy === remoteName) {
    return 'duplicate';
  }
  throw new AgentFrameworkError(
    `${origin} advertises two tools whose exposed name is the same "${localName}": ` +
      `"${claimedBy}" and "${remoteName}". Both cannot be offered to the model, so neither is: ` +
      'restrict `allowedTools` to one of them, or have the server rename one.',
  );
}

/** The name a tool is exposed to the model under, given the configured prefix. */
export function localToolName(remoteName: string, toolNamePrefix: string | undefined): string {
  const normalized = normalizeToolName(remoteName);
  if (toolNamePrefix === undefined) {
    return normalized;
  }
  const prefix = trimSeparators(normalizeToolName(toolNamePrefix), 'end');
  if (prefix === '') {
    return normalized;
  }
  const trimmed = trimSeparators(normalized, 'start');
  return trimmed === '' ? prefix : `${prefix}_${trimmed}`;
}

/**
 * Copies a declared input schema into one every provider accepts.
 *
 * A tool that takes no arguments is commonly declared as a bare `{ "type": "object" }`, which
 * OpenAI answers with a 400 because the object form requires `properties`. Adding the empty map is
 * what Python's MCP loader does, and it says exactly what the server meant. A schema that is
 * absent altogether gets that same zero-argument declaration here — a deliberate divergence from
 * Python, which leaves it as an empty schema that says nothing about the arguments at all. Any
 * other schema is passed through.
 *
 * The copy is shallow — only the top-level `properties` key is ever written — so the schema the
 * server owns is left as it was; nothing nested is modified.
 */
export function normalizeInputSchema(
  schema: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (schema === undefined || schema === null) {
    return { type: 'object', properties: {} };
  }
  const normalized = { ...schema };
  if (normalized.type === 'object' && !Object.hasOwn(normalized, 'properties')) {
    normalized.properties = {};
  }
  return normalized;
}
