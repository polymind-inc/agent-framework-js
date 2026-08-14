/**
 * Internal contract between the framework's own packages — not part of the documented surface.
 *
 * The Foundry hosting adapter replays Responses wire items from stored transcripts and must
 * produce exactly what the live provider path produces, so the two share one implementation of
 * each wire mapping. This entry exists so that sharing does not route through the package's main
 * entry point, which evaluates the OpenAI SDK at load time — a host that only replays transcripts
 * never pays that cost. Everything exported here may change or disappear in any release; import
 * from `@polymind-inc/agent-framework-openai` instead for the supported surface.
 */

export {
  codeInterpreterCallContents,
  mcpCallContents,
  searchCallContents,
} from './from-openai.js';
export { reasoningEncryptedContent, stringifyMcpOutput, stringifyResult } from './to-openai.js';
