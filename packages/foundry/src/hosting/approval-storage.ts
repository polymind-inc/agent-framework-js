import { homedir } from 'node:os';
import {
  readJsonFile,
  resolveUnder,
  writeJsonFile,
} from '@polymind-inc/agent-framework-agentserver/internal';
import type { FunctionApprovalRequestContent } from '@polymind-inc/agent-framework-core';
import { compositeKey } from './composite-key.js';

/**
 * Remembers the approval requests this container issued, keyed by the id they went out under.
 *
 * An `mcp_approval_response` carries only `approval_request_id` and `approve` — not the tool name
 * or the arguments. Without the original request there is nothing to execute, and nothing to
 * check the decision against, so the request has to outlive the turn that raised it.
 *
 * The key is the **wire** id (`mcpr_…`, what the platform sees) while the stored value keeps the
 * **framework** id (`ficc_…`, what the approval layer binds against): the two namespaces are kept
 * apart by this mapping rather than by rewriting one into the other.
 */
export interface ApprovalStorage {
  save(userId: string, wireId: string, request: FunctionApprovalRequestContent): Promise<void>;
  load(userId: string, wireId: string): Promise<FunctionApprovalRequestContent | undefined>;
}

/** Keeps approval requests in memory. For local runs and tests. */
export class InMemoryApprovalStorage implements ApprovalStorage {
  readonly #requests = new Map<string, FunctionApprovalRequestContent>();

  async save(userId: string, wireId: string, request: FunctionApprovalRequestContent): Promise<void> {
    this.#requests.set(compositeKey(userId, wireId), request);
  }

  async load(userId: string, wireId: string): Promise<FunctionApprovalRequestContent | undefined> {
    return this.#requests.get(compositeKey(userId, wireId));
  }
}

/**
 * Persists approval requests on the sandbox filesystem, partitioned per user.
 *
 * ## Security considerations
 *
 * Partitioning by user is what stops one caller from approving a call raised for another: a
 * decision is only ever resolved against the requests stored under the requesting user's id. The
 * user id is an untrusted path segment and is rejected rather than sanitized.
 */
export class FileApprovalStorage implements ApprovalStorage {
  readonly #root: string;
  /**
   * Serializes writes within this process. `save` is read-modify-write on one file per user, so
   * two concurrent saves — one user's parallel conversations both surfacing approvals — would
   * both read the same snapshot and the second write would silently drop the first request,
   * making its decision unresolvable. Writes queue behind this promise instead. Cross-process
   * exclusion is *not* provided; one process per sandbox is the deployment model.
   */
  #writes: Promise<unknown> = Promise.resolve();

  constructor(options: { root?: string } = {}) {
    this.#root = options.root ?? `${homedir()}/.function_approvals`;
  }

  #pathFor(userId: string): string {
    return resolveUnder(this.#root, [userId, 'approval_requests.json'], 'user id');
  }

  async #read(userId: string): Promise<Record<string, FunctionApprovalRequestContent>> {
    return (await readJsonFile<Record<string, FunctionApprovalRequestContent>>(this.#pathFor(userId))) ?? {};
  }

  async save(userId: string, wireId: string, request: FunctionApprovalRequestContent): Promise<void> {
    const run = this.#writes.then(() => this.#save(userId, wireId, request));
    // The queue survives a failed write; the failure itself still reaches this call's caller.
    this.#writes = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #save(userId: string, wireId: string, request: FunctionApprovalRequestContent): Promise<void> {
    const all = await this.#read(userId);
    all[wireId] = request;
    // Atomic replace: a crash cannot leave the file holding half a JSON object, which would lose
    // every pending approval rather than one.
    await writeJsonFile(this.#pathFor(userId), all);
  }

  async load(userId: string, wireId: string): Promise<FunctionApprovalRequestContent | undefined> {
    return (await this.#read(userId))[wireId];
  }
}
