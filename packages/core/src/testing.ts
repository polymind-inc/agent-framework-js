/**
 * `@polymind-inc/agent-framework-core/testing` — test doubles for code built on the Agent Framework.
 *
 * Everything here is meant for tests only; production code should not depend on this subpath.
 */

export type { MockTurn, RecordedCall } from './client/test-support.js';
export { MockChatClient } from './client/test-support.js';
