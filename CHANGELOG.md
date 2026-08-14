# Changelog

The umbrella `@polymind-inc/agent-framework` package and all `@polymind-inc/agent-framework-*`
packages are versioned in lockstep; one entry here covers the set. During 0.x, **minor releases may
contain breaking changes**; patch releases are fixes only.

## Unreleased

- **[BREAKING] `@polymind-inc/agent-framework-core`** — `ResponseBase<T>.value` is now
  `T | undefined`. A suspended run (for example, one waiting for tool approval) and a response
  created without a structured-output value have always carried `undefined` at runtime; callers
  must now narrow `response.value` before reading it. The response factories and update-folding
  helpers no longer claim a value exists when none was supplied.
- **[BREAKING] `@polymind-inc/agent-framework-core`** — a raw JSON Schema whose root is not an
  object no longer types a tool or skill-script input as `Record<string, unknown>`; its input is
  `unknown`. Object-root schemas retain the existing record inference. Raw schemas are now
  validated locally before executable tools and skill scripts run, rather than relying on a model
  provider to enforce them.
- **[BREAKING] `@polymind-inc/agent-framework-anthropic`** — `thinking` is a discriminated union:
  `{ type: 'enabled', budgetTokens }` requires a safe-integer budget of at least 1024, while
  `{ type: 'disabled' }` cannot carry a budget. Invalid configurations now fail at construction
  instead of reaching Anthropic as an invalid request.
- **[BREAKING] `@polymind-inc/agent-framework-foundry`** — `FoundryTarget` now enforces exactly one
  of `modelDeployment` and `serverAgent`. When an already-configured SDK `client` is supplied,
  `projectEndpoint` is optional and `baseURL` reports the client's actual URL; configurations
  without a client still require a project endpoint.
- **Security:** approval requests are immutable snapshots before they reach callers, so mutating a
  streamed or awaited request cannot change the arguments later executed after approval. Raw JSON
  Schema arguments are checked locally, executable-only approval bypassing no longer consumes
  declaration-only calls, and reused function call ids are correlated by logical occurrence.
- `ResponseStream.finalResponse()` now shares concurrent source initialization and draining, so
  repeated concurrent calls cannot duplicate model/tool work or leak an iterator. Middleware
  cancellation before the first pull and update-hook failures now finalize the run consistently.
- Serializing content now sanitizes `Content` values nested in function `result` fields, while
  deserialization leaves plain tool-result JSON untouched so it round-trips exactly. Future content types that
  carry the `userInputRequest` marker suspend structured-output parsing without requiring a core
  release for each new discriminator.
- OpenAI stream error events and incomplete terminal errors are surfaced as error content, unknown
  message parts survive awaited and streamed session round trips, and the final transformed
  `store` request option is the value retained for follow-up requests.
- Anthropic streaming drops unknown delta fragments that cannot be replayed as content blocks,
  preserves unknown complete blocks, maps citations to framework annotations, and treats MCP
  authorization headers case-insensitively.
- A2A task conversion now preserves terminal status messages, falls back to the agent history only
  for a terminal task that produced no artifacts (never duplicating a message the status already
  carries), and de-duplicates artifacts already emitted by the stream. Resuming with a
  continuation token needs the token alone; a session passed alongside is updated from the
  resumed task.
- Agent Server and Foundry hosting now bound request bodies (one `AGENTSERVER_MAX_BODY_BYTES`
  override governs the Responses and Invocations endpoints alike), stream-event retention and in-memory
  sessions; serialize concurrent turns for one Invocations session; reject duplicate foreground
  response ids, releasing the in-flight hold when the request aborts even if the response body was
  never consumed; and keep response aliases outside the primary retention quota. The Foundry
  container examples run as the unprivileged `node` user. SSE keep-alives obey backpressure,
  abandoned telemetry spans no longer remain strongly retained, storage credential acquisition is
  included in bounded retries, and structured custom-tool outputs retain their JSON shape.
- MCP rejects headers or custom fetch options that a custom transport cannot consume, and skill
  resource names reject encoded and repeatedly encoded traversal segments.
- Release automation now runs only from version tags, verifies all package versions in lockstep,
  validates packed versions, and publishes sequentially in dependency order after a complete
  registry preflight. Retries skip immutable versions that were already published.
- CI now enforces coverage (95% statements/lines, 90% functions/branches), audits High-severity
  dependency advisories, separates opt-in live integration tests from deterministic unit tests,
  and schedules protocol smoke tests. The vulnerable transitive `nanoid` version is overridden to
  a patched release.
- Agent Skills documentation and examples now use the hardened `directorySkillsSource` from the
  documented `/node` entry point instead of a custom filesystem walker.
- Core base64 conversion now writes pre-sized typed arrays, avoiding per-byte boxed allocations for
  large attachments while retaining the runtime-neutral implementation.

## 0.3.0

The first minor since 0.2, and the first release after the public-API surface freeze was lifted:
six breaking changes settle the naming conventions and correct semantics against the reference
implementations, alongside Agent Skills, the Foundry Memory provider, the Invocations protocol,
and file-backed persistence for transcripts and skills.

- **[BREAKING]** **`@polymind-inc/agent-framework-openai`** — the `OpenAIChatClientOptions`
  interface is renamed `OpenAIChatClientConfigBase`. It is the construction-time half of
  `OpenAIChatClientConfig`, and the package convention names construction types `*Config` and
  per-call types `*Options` (`OpenAIChatOptions` is unchanged); OpenAI was the one provider whose
  construction type broke that rule. `OpenAIChatClientConfig` itself — what `new OpenAIChatClient(…)`
  accepts — is unchanged, so only code that names the base interface directly is affected.
- **[BREAKING]** the MCP acronym in public identifiers is now spelled `Mcp`, matching the official
  `@modelcontextprotocol` SDK and this framework's own newer API (`McpConnection`,
  `mcpSkillsSource()`, `withMcpClientSpan`). The wire format is unaffected. Renames —
  `@polymind-inc/agent-framework-mcp`: `MCPClient` → `McpClient`, `MCPClientConfig` →
  `McpClientConfig`; `@polymind-inc/agent-framework-core`: `MCPToolOptions` → `McpToolOptions`,
  `SupportsMCPTool` → `SupportsMcpTool`, `supportsMCP` → `supportsMcp`, and the capability method
  `getMCPTool` → `getMcpTool` (the OpenAI, Anthropic and Foundry clients implement the renamed
  method). There are no deprecated aliases; update imports and any custom `ChatClient` that
  declares the MCP capability.
- **[BREAKING]** **`@polymind-inc/agent-framework-agentserver`** — `resolveUnder` and
  `validatePathSegment` are no longer exported from the package's main entry. They are path-safety
  primitives for file-backed stores, not part of the server protocol surface (the reference
  implementation exposes only the domain-scoped state-root helper, which `stateRoot` continues to
  mirror). The framework's own Foundry hosting adapter now reaches them — together with the shared
  atomic JSON file helpers `readJsonFile` / `writeJsonFile`, previously duplicated between the two
  packages — through the new `./internal` subpath, an internal contract like
  `@polymind-inc/agent-framework-openai/internal` whose exports may change in any release.
- **[BREAKING] `@polymind-inc/agent-framework-agentserver`** — `HandlerContext` gains two required
  fields: `agentReference` (the resolved agent this turn targets, always with a non-empty name)
  and `agentSessionId` (the resolved sandbox session id, as returned on `x-agent-session-id`).
  Handlers only read the context and are unaffected; code that *constructs* `HandlerContext`
  values — test doubles, custom protocol frontends — must now supply both.
- **[BREAKING] `@polymind-inc/agent-framework-core`** — the function-calling loop no longer
  hardcodes OpenAI's `conv_` prefix when deciding whether a conversation id advances between tool
  rounds. Which ids are stable service-side anchors is now the provider's declaration:
  `ChatClientMetadata.stableConversationId`, a new optional predicate the loop and the agent's
  session propagation consult. The built-in OpenAI, Azure OpenAI and Foundry clients declare it,
  so their behavior is unchanged. **A custom `ChatClient` implementation that relied on the loop
  pinning `conv_…` ids must now declare the predicate on its `metadata`** — without it, every
  conversation id a round reports advances the chain, matching the .NET and Python loops.
- **[BREAKING] `@polymind-inc/agent-framework-foundry`** — `FoundryChatClient` no longer asks for
  `reasoning.encrypted_content` implicitly. Not every Foundry deployment supports encrypted
  reasoning, and one that does not rejects a request that asks for it — which the client did on
  every call without service-side storage, with no way to turn it off. **A caller whose deployment
  does support encrypted reasoning, and who replays the transcript from their own side, must now
  list `reasoning.encrypted_content` in `options.include`**; without it a reasoning model's
  replayed transcript fails for missing reasoning content. Matches the upstream Python fix and the
  function-calling loop specification, which make the request an explicit caller opt-in on
  Foundry.
- **`@polymind-inc/agent-framework-core`** — new **Agent Skills** support
  ([#21](https://github.com/polymind-inc/agent-framework-js/issues/21)): `skillsProvider()` is a
  `ContextProvider` that advertises each available skill's name and description in the system
  prompt and registers the three tools the model uses to pull one in on demand — `load_skill`,
  `read_skill_resource` and `run_skill_script`. Skills are declared in code with `inlineSkill()`
  (with `skillResource()` and `skillScript()`, the latter taking a Standard Schema it also
  validates against), or built from a `SKILL.md` document with `markdownSkill()`;
  `parseSkillMarkdown()` exposes the frontmatter parser on its own. Sources come from
  `inMemorySkillsSource()` or any object implementing `SkillsSource`, and compose through
  `aggregateSkills()`, `filterSkills()`, `deduplicateSkills()` and `cacheSkills()`. Skills passed
  to the provider directly are cached and deduplicated for you; a source you supply is used exactly
  as given, because caching one that varies per agent or tenant would replay one run's skills for
  another. Every skill tool requires approval by default — `approvals` relaxes it per tool, and a
  `toolApprovalMiddleware` rule over the `SKILL_TOOL_NAMES` constant can reimpose it selectively
  on a relaxed tool (a middleware `'allow'` cannot bypass a tool's own approval requirement). A skill or
  resource the model asks for and does not exist comes back as a message it can correct rather than
  a failed run; a skill a source cannot load is skipped and reported through `onSkillError`.
  Walking a directory of `SKILL.md` files is not part of the core, which has no filesystem;
  `directorySkillsSource` on the `/node` subpath covers it.
- **`@polymind-inc/agent-framework-mcp`** — new `mcpSkillsSource()`, also reachable as
  `McpClient.skillsSource()`: discovers the Agent Skills an MCP server publishes by reading the
  well-known `skill://index.json` catalogue, fetching each `SKILL.md` body and any document it
  refers to only when the model asks. `McpConnection.readResource()` is exposed for it, with the
  same reconnect-once behaviour as `callTool` and a `resources/read` client span. A server with no
  catalogue contributes no skills; an index entry the framework cannot use — an `archive` skill, a
  malformed name — is skipped and named, while a server that *refuses* the request surfaces the
  failure rather than being read as an empty catalogue.
- **`@polymind-inc/agent-framework-foundry`** — `FoundryToolbox` now serves the toolbox's Agent
  Skills as well as its tools: `asSkillsProvider()` returns a ready-made provider (and
  `skillsSource()` the source alone) over the connection the tools already use, so discovery
  carries the same per-call Entra token and `x-agent-foundry-call-id`, and a `CONSENT_REQUIRED`
  refusal arrives as the same typed `ToolboxConsentRequiredError`. The new `loadTools: false`
  option hides the toolbox's tools entirely — the gateway is never asked to list them — for an
  agent that wants only its skills.
- **`@polymind-inc/agent-framework-foundry`** — new `FoundryMemoryProvider`: a `ContextProvider`
  backed by a Microsoft Foundry Memory Store
  ([#25](https://github.com/polymind-inc/agent-framework-js/issues/25)). It searches the store
  before each run — once per session for the user's profile memories, then per turn for memories
  relevant to the input — injects what it finds as a single user message under a configurable
  context prompt, and sends the completed turn back for extraction afterwards. A failed run is not
  stored. Memories are partitioned by a **required** `scope`, given as a value or as a function of
  the run and pinned to the session on first use, so one provider instance can serve every user of
  a hosted container; `hostedUserScope()` (exported from `/hosting`) resolves it from the platform
  user id of the turn. Service failures default to `failureMode: 'continue'` — the run proceeds
  without the memories — and `'throw'` fails the run instead; `onFailure` observes both. The
  provider also carries the store operations a caller needs around it:
  `ensureMemoryStoreCreated`, `getMemoryStore`, `deleteStoredMemories` and `whenUpdatesCompleted`.
  The transport is `fetch` against the preview memory-store routes (`Foundry-Features:
  MemoryStores=V1Preview`) and is overridable, so tests need no live credentials.
- **`@polymind-inc/agent-framework-agentserver`** — new `InvocationsServer`: the Foundry
  Invocations protocol ([#29](https://github.com/polymind-inc/agent-framework-js/issues/29)),
  served alongside the existing Responses protocol. The protocol prescribes no payload — the
  request body reaches the `InvocationHandler` unread, and the handler's `Response` is what the
  caller gets — while the server owns the routes (`POST /invocations`, `GET /invocations/{id}`,
  `POST /invocations/{id}/cancel`, `/readiness`), invocation and session id resolution
  (`x-agent-invocation-id`; `agent_session_id` query → `FOUNDRY_AGENT_SESSION_ID` → generated),
  their echo on every response including errors, cancellation via `InvocationContext.signal`,
  opaque `upstream`-classified handler failures, SSE keep-alive injection for
  `text/event-stream` bodies, and W3C trace propagation with the
  `azure.ai.agentserver.invocation_id` / `.session_id` baggage. `serve` (on `/agentserver/node`)
  now accepts any `{ fetch, drain }` protocol server — a widening, existing callers are
  unaffected.
- **`@polymind-inc/agent-framework-foundry`** — new `InvocationsHostServer` (on `/hosting`):
  publishes an `Agent` over the Invocations protocol with the same wire contract as the Python
  adapter — request `{ "message": string, "stream"?: boolean }`, plain-text responses, raw text
  chunks under `text/event-stream` when streaming. Conversations are held in process, partitioned
  per session id and — hosted — per platform user; callers continue a conversation by pinning the
  `agent_session_id` query parameter to the previous response's `x-agent-session-id` header.
  Hosted requests without the protocol-2.0.0 call id fail closed with 501, without a user id with
  400, as the Responses adapter does.
- **`@polymind-inc/agent-framework-foundry`** — the hosting layer now exposes the turn's typed
  execution context to code running inside the agent
  ([#23](https://github.com/polymind-inc/agent-framework-js/issues/23)). `getHostedAgentContext()`
  (exported from `/hosting`) returns a frozen per-turn `HostedAgentContext` — the platform user id
  and call id, the correlation id, the response and conversation ids, the resolved agent
  reference, the sandbox session id, and the turn's `AbortSignal` — from any tool, context
  provider or middleware, and `undefined` outside a hosted turn. Concurrent turns on one container
  each see their own context; the stores that persist per-user state keep taking their partition
  key as an explicit argument. There is deliberately no per-request tenant field: the platform's
  trust boundary injects only the user id and call id, and a hosted container is deployed per
  agent inside one tenant.
- **`@polymind-inc/agent-framework-openai`** — new `includeReasoningEncryptedContent` construction
  option (default `true`, so OpenAI and Azure OpenAI are unchanged). Setting it to `false`
  suppresses the implicit `reasoning.encrypted_content` request for an endpoint that rejects it;
  an entry the caller lists in `include` themselves is always sent either way. Mirrors the .NET
  clients' option of the same name.
- **`@polymind-inc/agent-framework-core`** — a history provider can opt into storing the
  messages other context providers injected into a run: `HistoryStoreOptions.storeContextMessages`
  takes `true` for all of them, or a list of `sourceId`s for just those providers. The default
  stays as before — the run's input and the response — matching the reference implementations'
  default; the opt-in is the knob they offer that was missing here.
- **`@polymind-inc/agent-framework-core`** — new `FileHistoryProvider` on the `/node` subpath:
  keeps the transcript in a JSON Lines file per session, using the same layout as the Python
  file-backed provider so the files interoperate, and a session survives a process restart without
  a custom provider.
- **`@polymind-inc/agent-framework-core`** — new `directorySkillsSource` on the `/node`
  subpath: walks a directory of `SKILL.md` skill folders — the convention all three reference
  implementations support — and serves them as a `SkillsSource` for `skillsProvider()`.
- **`@polymind-inc/agent-framework-mcp`** — `McpClient` accepts a header provider
  (`McpHeaderProvider`, sync or async) in place of a static `headers` record. It is re-evaluated
  per request, so a credential that refreshes can be expressed without a custom `fetch` wrapper,
  and the headers are scoped to the server's origin so a redirect elsewhere cannot carry them
  along.
- **`@polymind-inc/agent-framework-core`** — the `ENABLE_SENSITIVE_DATA` compatibility alias
  accepts the same spellings as the Python reader: `on` now enables message-content capture —
  previously it silently read as unset, the exact cross-language case the alias exists for — and
  `off` is an explicit negative rather than falling through to the OTel-named variables.
- **`@polymind-inc/agent-framework-openai`** — the Responses wire mappings the Foundry hosting
  adapter replays (the `mcp_call` / search / code-interpreter items, MCP output stringification,
  and the encrypted-reasoning lookup) are shared through an undocumented `./internal` entry
  instead of hand-maintained mirrors, so the replay path and the live provider path cannot drift;
  the call-id fallback order now matches the Python reference on both.
- **`@polymind-inc/agent-framework-core`** — what happens when a caller stops consuming a run
  early (`break`, an aborted signal) and how token usage is read after draining a stream are now
  documented contracts on `AgentRunStream` / `ResponseStream`, each pinned by tests.
- Repository: the Baseline v0.1 public-API surface freeze is lifted — surface changes now require
  grounding in the reference implementations, and the gate on new feature areas stays. Large
  internal modules were split into focused ones and duplicated internal logic consolidated, with
  reduced streaming hot-path overhead and no behavior change; CI actions and dependencies were
  bumped.
## 0.2.2

Fixes accumulated since 0.2.1, centred on running agents as Microsoft Foundry Hosted Agents:
persistence against the Foundry storage service, latency of streamed model calls, transcript
fidelity, and telemetry attribution.

- **`@polymind-inc/agent-framework-openai`**
  - A streamed Responses API call now releases its SSE stream as soon as the terminal event
    (`response.completed` / `response.incomplete` / `response.failed`) has been yielded, instead
    of draining to the connection close. Azure AI Foundry's `/openai/v1/responses` holds the
    socket open for ~5 seconds after the terminal event and never sends the `[DONE]` sentinel, so
    every streamed round paid that tail — for a deployed hosted agent, the measured end-to-end
    turn dropped from 9.7s to 3.5s. Against an endpoint that closes promptly after the terminal
    event this is a no-op. The wrapper is a workaround for the service-side behavior; its removal
    is tracked in [#40](https://github.com/polymind-inc/agent-framework-js/issues/40).
  - A failed response now surfaces its diagnostic: the parsed response and the `response.failed`
    stream event carry an `error` content built from `response.error`, with generic substitutes
    when the wire carries no usable message or code. Previously the reason a run failed was only
    available in `rawRepresentation`.
  - A local tool's approval no longer reaches the Responses API input. Only hosted (MCP)
    approvals serialize to `mcp_approval_request` / `mcp_approval_response` items; a local
    approval is resolved in-process, and serializing it produced an orphaned request
    (`server_label: null`) or a response referencing an id the API never issued. Mirrors the
    upstream Python fix.
- **`@polymind-inc/agent-framework-core`**
  - `AgentResponse.text` / `ChatResponse.text` join the texts of multiple messages with a
    newline, matching the .NET reference (previously concatenated without a separator).
  - `gen_ai.system_instructions` is recorded on chat spans only when sensitive-content capture is
    enabled, serialized as a parts array (`[{"type":"text","content":…}]`). It was previously
    stamped unconditionally as a bare string, so the system prompt reached the tracing backend
    even with capture off — the OpenTelemetry GenAI conventions treat the attribute as opt-in,
    and the .NET and Python implementations gate it the same way.
- **`@polymind-inc/agent-framework-foundry`**
  - `FoundryResponseStore` is production-ready and is now the hosted default. Writes carry the
    resolved `agent_reference` and forward the platform call id (the two undocumented
    requirements behind the service's opaque 500s), replayed history travels as item-id
    references instead of re-sent items, conversation ids resolve through the service's own
    linkage, ambiguous failures are retried with bounded backoff and reconciled against what the
    service actually holds, and background responses replay from a sandbox-local event mirror —
    removing the documented 501 limitation on background execution. A hosted container without a
    reachable project endpoint falls back to the sandbox filesystem.
  - The hosting converters cover the Responses v2 item set: twelve more inbound item types —
    provider-run searches, code interpreter and image generation among them — now convert to
    framework messages instead of being silently dropped from the replayed transcript, and the
    output builder emits the matching wire representations so those items survive into the next
    turn's history. Semantics cross-checked against the .NET and Python hosted converters.
- **`@polymind-inc/agent-framework-agentserver`**
  - An input item that arrives without an id is assigned a platform id under its type's prefix
    before persistence, covering the reference id generator's full per-type dispatch. The Foundry
    storage service refuses an id-less item with an opaque 500, so a turn whose `input` was an
    item array without ids — the Foundry Playground's request shape among them — ended in
    `response.failed` with `storage_error` instead of completing. An item that already carries an
    id keeps it, and an id-less item of an unrecognized type is left out of persistence.
  - `GET /responses/{id}` reports `cancelled` as soon as a cancel has been accepted, instead of
    `in_progress` for as long as the cancel waits out its grace period. Only the status is
    overridden; the cancelled terminal still clears the output when the winddown ends, matching
    the reference server's refresh.
  - The hosted observability setup instruments outbound `fetch` (undici), so model requests and
    Foundry storage writes appear as HTTP client spans nested under the `chat` / `invoke_agent`
    spans — a 7-second span now shows where the time went.
  - Hosted telemetry is attributed to the deployed agent: a processor stamps the
    `microsoft.gen_ai.main_agent.*` attributes (the only `microsoft.*` span attributes the Azure
    Monitor JS exporter forwards), and the resource carries `foundry.*` attributes mirroring the
    .NET host, so the Foundry portal can associate spans with the agent and project.
  - New public API from the storage work: `stateRoot` and `resolveAgentReference` are exported,
    and `FoundryResponseStoreConfig` accepts `replayRoot` and `retry`.
- Repository: issue and pull request labels are applied automatically from paths and templates.

## 0.2.1

Documentation and positioning only — no change to any published API.

- **`@polymind-inc/agent-framework` is now the single supported surface.** All examples, the
  repository README and every code sample import through the main package
  (`@polymind-inc/agent-framework`, `…/openai`, `…/foundry/hosting`, …). The
  `@polymind-inc/agent-framework-*` constituent packages remain published — the main package
  depends on them at exact versions, and importing one directly still resolves to the same
  modules — but their READMEs now state that the main package is the documented way in. This
  removes the awkwardness of two equivalent import styles for the same code.

## 0.2.0

One new package; no change to any existing published API.

- **`@polymind-inc/agent-framework`** — new umbrella package, mirroring the Python
  `agent-framework` distribution. It depends on every granular package and re-exports each
  under a subpath: the root entry is the core, and `/testing`, `/openai`, `/anthropic`, `/mcp`,
  `/a2a`, `/foundry`, `/foundry/hosting`, `/agentserver`, `/agentserver/node` and
  `/agentserver/observability` map one-to-one onto the packages they re-export. The granular
  packages are unchanged and remain the smaller install.
- **`@polymind-inc/agent-framework-agentserver`** — routing no longer trims the trailing slash of a
  request path with a backtracking regular expression. The old pattern cost time quadratic in the
  length of a run of slashes, so an unauthenticated `GET` on a path such as `/////…/a` could hold
  the event loop for seconds.
- **`@polymind-inc/agent-framework-core`** — generated ids (`Agent.id`, `AgentSession.sessionId`,
  the `messageId` of framework-emitted messages) always come from `crypto.randomUUID`. They
  previously fell back to `Math.random` on a runtime without it, which is not a suitable source for
  an identifier. A runtime that does not provide `crypto.randomUUID` — a browser on a page served
  over plain HTTP — now throws instead of producing a guessable id.

## 0.1.1

Metadata only — no code changes, and no change to any published API.

- The repository moved to `polymind-inc/agent-framework-js`, matching how the Agent Framework
  names a language implementation that lives outside the .NET/Python monorepo (compare
  `microsoft/agent-framework-go`). The `repository`, `homepage` and `bugs` fields of all seven
  packages point at the new location; 0.1.0 shipped with the previous one, which now only works
  through a redirect.

## 0.1.0 — Baseline v0.1

Initial public release of the TypeScript implementation of the Microsoft Agent Framework
programming model.

- **`@polymind-inc/agent-framework-core`** — `Agent`, `AgentSession`, the wire-compatible
  `Message` / `Content` model, `tool()` with Standard Schema support, the function-calling loop
  with approvals and continuation tokens, middleware, `ContextProvider` / `HistoryProvider`, and
  OpenTelemetry GenAI instrumentation. One runtime dependency: `@opentelemetry/api`.
- **`@polymind-inc/agent-framework-openai`** — OpenAI and Azure OpenAI chat client over the
  Responses API, including the provider-hosted tools.
- **`@polymind-inc/agent-framework-anthropic`** — Anthropic chat client over the Messages API,
  including extended thinking and remote MCP servers.
- **`@polymind-inc/agent-framework-mcp`** — MCP client integration; server tools become framework
  tools.
- **`@polymind-inc/agent-framework-a2a`** — Agent2Agent (A2A) protocol client. `A2AAgent` makes a
  remote A2A agent usable wherever the framework expects an agent — awaited or streamed, with
  sessions, background tasks and re-subscription. Built on `@a2a-js/sdk` (A2A protocol v1.0).
- **`@polymind-inc/agent-framework-foundry`** — Microsoft Foundry chat client and the Hosted Agent
  hosting adapter.
- **`@polymind-inc/agent-framework-agentserver`** — Microsoft Foundry Responses container protocol
  v2.0.0 server, independent of the rest of the framework.

The API surface of this release was frozen as Baseline v0.1 (2026-08-02); the freeze was later
lifted in favor of the policy described in [Stability and versioning](README.md#stability-and-versioning).
Known limitations are listed in the root [README](README.md).
