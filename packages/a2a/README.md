# @polymind-inc/agent-framework-a2a

Agent2Agent (A2A) protocol client for the Agent Framework: `A2AAgent` makes a remote A2A agent
usable wherever the framework expects an agent — awaited or streamed, with sessions, as a tool of
another agent. Built on the official [`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js) client
(A2A protocol v1.0), and traced as an `invoke_agent` span like any other agent run.

```sh
npm install @polymind-inc/agent-framework-core @polymind-inc/agent-framework-a2a
```

```ts
import { A2AAgent } from '@polymind-inc/agent-framework-a2a';

const agent = await A2AAgent.fromUrl('https://agents.example.com');
const session = agent.createSession();

const response = await agent.run('Was invoice 42 paid?', { session });
console.log(response.text);

for await (const update of agent.run('And invoice 43?', { session })) {
  process.stdout.write(update.text);
}
```

## Connecting

Three ways in, in increasing order of control:

| Source | Use when |
| --- | --- |
| `A2AAgent.fromUrl(url)` | The agent publishes a card at a well-known URI. The only path that performs I/O. |
| `new A2AAgent({ agentCard })` | You already hold a card — from a catalog, a config file, a registry. |
| `new A2AAgent({ client })` | You need to configure the SDK client yourself: authentication, interceptors, a specific transport. |

The constructor never makes a request; with a card, the client is built on the first run. Transport
selection is the SDK's: JSON-RPC and HTTP+JSON are both supported, chosen from the interfaces the
card advertises. For gRPC, construct the client yourself with `@a2a-js/sdk/client/grpc`.

`name` and `description` default to the card's; `id` is generated unless you pass one.

## Authentication

Credentials belong to the client, so an authenticated agent is built by giving the SDK a `fetch`
that carries them and passing the resulting client in. Everything above the client is unchanged.

```ts
import { A2AAgent } from '@polymind-inc/agent-framework-a2a';
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
} from '@a2a-js/sdk/client';

const fetchImpl: typeof fetch = (input, init) =>
  fetch(input, { ...init, headers: { ...init?.headers, authorization: `Bearer ${token}` } });

// The card is usually protected too, so it is fetched with the same credentials. Resolving it
// first also gives the agent its name and description.
const agentCard = await new DefaultAgentCardResolver({ fetchImpl }).resolve('https://agents.example.com');
const factory = new ClientFactory(
  ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    transports: [new JsonRpcTransportFactory({ fetchImpl }), new RestTransportFactory({ fetchImpl })],
  }),
);

const agent = new A2AAgent({ client: await factory.createFromAgentCard(agentCard), agentCard });
```

For credentials that expire, the SDK's `AuthenticationHandler` refreshes on a rejected response and
retries the request once:

```ts
import { createAuthenticatingFetchWithRetry } from '@a2a-js/sdk/client';

const fetchImpl = createAuthenticatingFetchWithRetry(fetch, {
  headers: async () => ({ authorization: `Bearer ${cached}` }),
  shouldRetryWithHeaders: async (_request, response) =>
    response.status === 401 ? { authorization: `Bearer ${await refresh()}` } : undefined,
  onSuccessfulRetry: async (headers) => { cached = tokenOf(headers); },
});
```

`A2AAgent.fromUrl` is for agents that publish their card openly; it has no place to put a
credential. A rejected request surfaces as `A2AAgentError` with the transport's status
(`… Status: 401 Unauthorized`), and the SDK error is on `cause`.

Per-request context that is not a credential — a tenant, a trace id — can also travel as
`ClientConfig.interceptors`, which the SDK applies to every call.

## How a turn maps to the protocol

How you consume the run picks the operation, and both produce the same answer:

| Consumed | New turn | Resuming a task |
| --- | --- | --- |
| `await agent.run(...)` | `SendMessage` (blocking) | `GetTask` |
| `for await (… of agent.run(...))` | `SendStreamingMessage` | `SubscribeToTask`, falling back to `GetTask` for a task that already finished |

Only the current turn's input is sent, as a single `user` message: the remote agent owns the
conversation and its history. That is also why this agent has no tools, instructions, middleware or
context providers of its own — the shared run-option fields it does not declare (`tools`,
`middleware`, `responseFormat`, `options`) are ignored, as they are in the .NET, Python and Go
implementations of this client.

## Sessions

A session holds the remote conversation's identity, and is plain JSON:

- `session.serviceSessionId` is the A2A `contextId`. It is adopted from the first response and then
  fixed: a response naming a different context fails the run rather than silently switching.
- The task the last turn ended on is kept in `session.state.a2a`, and decides how the next message
  links: a task waiting for input is **continued** (`taskId`), any other task is **referenced**
  (`referenceTaskIds`) as prior context.

```ts
const saved = JSON.stringify(session);
const restored = agent.deserializeSession(JSON.parse(saved));
```

## Long-running work

`allowBackgroundResponses` (with an explicit session) returns as soon as the work is accepted, with
a `continuationToken` on the response. Pass it back — and no input — to pick the task up:

```ts
const accepted = await agent.run('Reconcile last quarter', { session, allowBackgroundResponses: true });
const done = await agent.run(undefined, { session, continuationToken: accepted.continuationToken });
```

A token is `{"taskId": "..."}` and is JSON-serializable, so a resume can happen in another process.
Tokens are parsed strictly: anything that is not one this package issued is refused.

Tokens are issued only while a task is still going to produce something (`submitted`, `working`). A
task that stopped to ask a question (`input-required`) is continued by sending the next message, not
by resuming.

## Content mapping

| Framework content | A2A part |
| --- | --- |
| `text` | `text` (empty text is skipped) |
| `uri` | `url` + media type |
| `data` | `raw` bytes + media type |
| `hosted_file` | `url` carrying the file id |
| `error` | `text` |
| everything else (`function_call`, `function_result`, reasoning, usage) | dropped |

Inbound, `text` and `url` map back to `text` and `uri`, `raw` to `data`, and a structured `data`
part becomes its JSON text. A part whose kind this protocol version does not define is kept as
unknown content rather than dropped. Part metadata rides along on `additionalProperties`, and the
original part is always on `rawRepresentation`.

## Known limitations

- **Terminal failures are not errors.** A task that comes back `failed`, `canceled`, `rejected` or
  `auth-required` produces a normal response with no `finishReason` — matching the other
  implementations. Inspect `rawRepresentation` on the response messages for the task's own state.
- **A streamed artifact is only ever appended to.** `TaskArtifactUpdateEvent.append: false` for an
  artifact id that was already streamed means *replace what you have*, but by then the earlier
  chunk has already been handed to the caller, so the folded response concatenates the two. The
  awaited form has no such problem — it reads the finished task, whose artifacts are the final
  snapshot. No reference implementation of this client handles replacement either; if the agents
  you talk to re-issue artifacts, await the run rather than streaming it.
- **A tool call starts its own remote conversation.** `agent.asTool({ propagateSession: true })`
  gives the sub-agent a session that shares the caller's state but not its `serviceSessionId`
  (deliberately: the caller's server-side transcript is not the sub-agent's to append to). Since
  the A2A conversation *is* that id, each tool call talks to the remote agent in a fresh context.
  The recorded task is scoped to the conversation it came from, so nothing is ever mislinked — a
  task from another context is ignored rather than referenced. Drive the agent directly when a tool
  needs to continue one conversation across calls.
- **No push notifications, task listing or cancellation.** The client covers send, stream, get and
  re-subscribe. Use the SDK client directly for the rest.
- **Progress messages are not transcript.** A status message is turned into content only when the
  task is waiting for input; commentary attached to `working` is dropped.
- **Server hosting is not part of this package.** Exposing a framework agent *as* an A2A agent is a
  separate concern; use `@a2a-js/sdk/server` directly.

## Security considerations

A remote agent is third-party code you do not control. Everything it returns reaches your model as
conversation history, so treat it as untrusted input and never as instructions. Credentials belong
to the SDK client you construct — this package reads none from the environment.

---

Part of [Agent Framework for TypeScript](https://github.com/polymind-inc/agent-framework) — an
independent community implementation of the Microsoft Agent Framework programming model. Not an
official Microsoft product, and not affiliated with or endorsed by Microsoft. MIT licensed.
