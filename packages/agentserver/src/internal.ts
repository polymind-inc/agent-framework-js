/**
 * Internal contract between the framework's own packages — not part of the documented surface.
 *
 * The Foundry hosting adapter keeps its per-user state files with the same path-safety and
 * atomic-write discipline as this package's own file-backed response store, so the two share one
 * implementation of each primitive rather than drifting apart. Everything exported here may
 * change or disappear in any release; import from `@polymind-inc/agent-framework-agentserver`
 * instead for the supported surface.
 */

export { resolveUnder, validatePathSegment } from './paths.js';
export { readJsonFile, writeJsonFile } from './store/json-file.js';
