/**
 * Internal contract between the framework's own packages — not part of the documented surface.
 *
 * These are the utilities the provider packages share so that one rule (error rendering, integer
 * validation, record narrowing, wire-string degradation, MCP label normalization, answered-call
 * bookkeeping) has exactly one implementation. None of them has a public counterpart in the
 * reference implementations, so none of them belongs on the package's supported surface.
 * Everything exported here may change or disappear in any release; import from
 * `@polymind-inc/agent-framework-core` instead for the supported surface.
 */

export { answeredCallIds } from './client/function-invocation.js';
export { normalizeServerLabel, safeStringify } from './client/provider-utils.js';
export { errorMessageOf, validateSafeInteger } from './errors.js';
export { isRecord } from './types/content.js';
