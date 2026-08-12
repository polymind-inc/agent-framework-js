/**
 * `@polymind-inc/agent-framework-core/node` — the pieces that need a filesystem.
 *
 * Everything here imports `node:` built-ins, so it is kept out of the package's root entry: that
 * one has to keep running on Deno, Bun, edge runtimes and in browsers. Importing this subpath from
 * such a runtime is what fails, rather than importing the framework at all.
 */

export type { FileHistoryProviderConfig } from './node/file-history-provider.js';
export { FileHistoryProvider } from './node/file-history-provider.js';
