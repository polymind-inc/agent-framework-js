# Changelog

The umbrella `@polymind-inc/agent-framework` package and all `@polymind-inc/agent-framework-*`
packages are versioned in lockstep; one entry here covers the set. During 0.x, **minor releases may
contain breaking changes**; patch releases are fixes only.

## Unreleased

- **`@polymind-inc/agent-framework-anthropic`** — a session restored from persistence can replay a
  turn that used the code-execution beta. The blocks describing a provider-executed call — code
  execution, bash, the text editor — used to be replayed only from `rawRepresentation`, which
  serialization deliberately strips, so a restored transcript dropped them and the turn's remaining
  `tool_result` answered a call the request no longer contained, which the Messages API rejects.
  The conversion now rebuilds `server_tool_use` and the code-execution result blocks from the typed
  contents when the raw block is gone: calls stay paired with their results, stdout/stderr, files
  and error codes survive, and for a turn whose typed form captures what the wire said the rebuilt
  request is identical to the in-memory one. A transcript still holding `rawRepresentation` replays
  the exact bytes, unchanged, and `rawRepresentation` is still never serialized. Error outputs
  parsed from code-execution and text-editor failures now also carry the wire's code under
  `ErrorContent.errorCode` (additive), which is what makes a restored error turn rebuild faithfully.

- **`@polymind-inc/agent-framework-core`** — dangling tool calls are settled when the service owns
  the transcript. A fatal `MiddlewareFailed` abort — mid-round or during an approved-replay batch —
  and the final over-budget round can leave `function_call`s that never produce a result; on a
  service-managed conversation those calls sit on the service's side, and the next request over
  that conversation is rejected by providers that require every call to be answered. The loop now
  submits one error `function_result` per dangling call with `toolChoice: 'none'` before the abort
  propagates, matching the reference implementation's settlement path, and advances the session's
  persisted continuation to the settlement response so response-id chaining starts from the
  endpoint whose chain includes the synthetic outputs — a conversation anchor the provider declares
  stable stays put. The original failure still reaches the caller unchanged, a settlement failure
  never masks it, nothing is sent when the framework owns the transcript, and the extra request
  exists only on these failure paths. A run abandoned mid-stream is deliberately not settled: no
  code runs on the consumer's behalf after it walks away, and issuing fresh requests from a
  cancelled run would invert what cancellation means — the dangling state there is unchanged.

- **`@polymind-inc/agent-framework-anthropic`** — a `function_call` that no `function_result`
  anywhere in the transcript answers is omitted from the request instead of being sent as a
  `tool_use` the Messages API refuses with a 400 (`Each tool_use block must have a corresponding
  tool_result block`, measured 2026-08-31). Transcripts legitimately hold such calls — an approval
  pause, the iteration limit, an abandoned stream, a fatal middleware abort, a declaration-only
  tool answered after the session was saved — and the OpenAI conversion already filters them the
  same way, so one rule now governs both providers. A call answered in a later message is kept, a
  call with an empty `callId` is always omitted, and `FunctionCallContent` and serialized sessions
  are never rewritten — the call stays in the transcript; it just never goes on the wire. A request that
  used to fail with the 400 above now goes through without the dangling call.

- **`@polymind-inc/agent-framework-mcp`** — MCP client spans emit `server.port` as an integer, as
  the OpenTelemetry semantic conventions define the attribute, instead of the string the WHATWG URL
  API reports. **Dashboard migration:** a query that compared the attribute as a string
  (`server.port = "8443"`) must compare it as a number; numeric filters and range aggregations that
  silently matched nothing now work. A URL that does not state an explicit port still reports no
  `server.port` at all, and `server.address` is unchanged.

- **`@polymind-inc/agent-framework-core`** — a skill script no longer receives `null` as its
  arguments. The `run_skill_script` tool's schema lets a model send an explicit `null` — the
  advertised default — and that value used to be handed to `SkillScript.run` even though the
  declared `SkillScriptArguments` type excludes it, so a `typeof args === 'object'` branch written
  against the type met a `null` at runtime. An explicit `null` is the same absence as omitting the
  argument and now arrives as `undefined`, matching the reference implementation, where an omitted
  value defaults to `None` and an explicit JSON `null` deserializes to that same `None`. Only a
  script that deliberately distinguished the two — against the declared type — observes a change.

- **`@polymind-inc/agent-framework-foundry`** — a Foundry toolbox tool that reports `isError` now
  assembles its failure text by the same rule the MCP client applies, instead of an independent
  second implementation that had drifted from it: each text block lands on its own line rather than
  run together, `structuredContent` reaches the model as the last line rather than being dropped,
  blocks without text contribute nothing, and a result that says nothing at all names the tool that
  failed rather than producing an empty message. The rule is now literally shared — the toolbox
  imports the MCP package's assembly rather than keeping a copy — so the two cannot drift apart
  again.

- **`@polymind-inc/agent-framework-core`** — a tool call whose arguments fail to parse or fail
  schema validation is answered with `Error: Argument parsing failed.` instead of the
  `Error: Function failed.` a thrown tool body produces. The two failures call for opposite model
  responses — a schema violation is worth retrying with corrected arguments, an execution failure
  usually is not — and the shared text removed the one signal that distinguishes them. The wording
  matches Python. The `exception` field still carries the validation detail, `includeDetailedErrors`
  still appends the underlying message the same way, and the not-found, execution-failure and
  success texts are unchanged.

- **`@polymind-inc/agent-framework-foundry`** — `FoundryChatClient.createConversation()` creates a
  server-side conversation and returns its id, so a run can start on a conversation that already
  exists — and is already visible in the Foundry Project UI — instead of one the first response
  mints: `agent.createSession({ serviceSessionId: await client.createConversation() })`. Creating is
  all it does: the conversation outlives the session object, nothing deletes it, and dropping the
  session does not release it. A client whose SDK has no conversations resource fails with a
  `ConfigurationError` naming that, rather than a `TypeError`, and a cancellation passes through as
  itself rather than as a provider failure. The standalone `createFoundryConversation` is exported
  for a caller holding an SDK client without a `FoundryChatClient`.

- **`@polymind-inc/agent-framework-foundry`** — `FoundryChatClient` now carries the Foundry
  hosted-agent session id. The service mints one on the first request that carries none and reports
  it back; every later request of that session sends it, including later rounds of the same run — a
  round that omitted it could land on a different sandbox and lose the persistent `$HOME` the
  sandbox exists to provide. The id is kept in `session.state` under
  `FOUNDRY_HOSTED_SESSION_STATE_KEY`, so it survives serializing and restoring a session and one
  session never sees another's. A hosted-agent session is a sandbox and is **not** the conversation
  the transcript lives in, which is still `AgentSession.serviceSessionId`. Attach to an existing
  sandbox by putting `agent_session_id` in `additionalProperties`; naming one that differs from what
  the session already holds fails with a `ConfigurationError` before the request goes out rather
  than picking one. Foundry owns the sandbox's lifecycle — nothing here creates or releases one.

- **`@polymind-inc/agent-framework-core`** — a chat client can now implement
  `SessionScopedChatClient` to be asked, once per run, for a view of itself bound to that run's
  session. The bound client wraps every service call of the run — later rounds of a tool loop as
  much as the first, awaited and streamed alike — which is what a provider needs when its service
  mints an identifier during a run that the session then has to echo on every later request. There
  was nowhere to put such a value before: on the client it leaks between sessions, and a caller
  cannot supply it because it does not exist until a run is already under way. `Agent` reads the
  capability off the client it was constructed with, the same way it collects that client's
  middleware; a client that does not implement it is unaffected and takes the same path as before.

- **`@polymind-inc/agent-framework-core`** — the function-calling loop decides the next round from
  the conversation id the round that just finished **reported**, not from the id the request
  happened to carry. A run that started without one and was handed one mid-flight kept resending
  the whole transcript for the rest of its tool rounds; it now chains from the second round on and
  carries only the tool results, which is what Python's `_prepare_messages_for_next_iteration` does
  and what the session-level adoption already assumed. The anchor a provider declares stable is
  still held. Nothing changes when no id is ever reported, including under `store: false`.

- **[BREAKING] `@polymind-inc/agent-framework-core`** — a tool body's exception now travels out
  through the function middleware wrapped around it, so `try { await next() } catch` and
  `try { await next() } finally` mean what they read. Previously the failure was written to
  `ctx.error` and `next()` resolved, while an exception from an *inner middleware* did propagate —
  the same syntax behaved differently depending on which layer threw, and a timing or logging
  middleware silently skipped exactly the calls worth knowing about. Recover by catching and
  assigning `ctx.result`; `ctx.error` is still set alongside the throw for a middleware that only
  wants to look, but clearing it no longer clears the failure. Middleware written as
  `await next(); if (ctx.error) { … }` must become `try/catch`.

- **[BREAKING] `@polymind-inc/agent-framework-core`** — an exception from a function middleware is
  reported to the model as that call's `function_result` and the loop continues, instead of failing
  the run. Tool bodies already behaved this way; middleware did not, and all three reference
  implementations treat both the same. The round still counts against `maxConsecutiveErrors`
  (default 3), so a layer that keeps failing still ends the run — this is not a licence to fail
  forever. **This reversal is silent**: nothing in the type system or the linter will point at
  middleware that relied on throwing to abort. Throw the new `MiddlewareFailed` where that was the
  intent — it is never turned into a result, it cancels the rest of the concurrent batch, and it
  reaches the caller of `run()`. A tool body may throw it too. Cancellation is cooperative: a
  sibling that watches `ctx.signal` stops at its next suspension point, one that ignores it runs to
  completion and may still have its effects, and either way its result is discarded.

- **[BREAKING] `@polymind-inc/agent-framework-core`** — a session now takes the conversation id the
  first response reports, which hands the transcript to the service. From the next turn the request
  carries that id instead of the whole history, the framework's own history provider stands down,
  and the provider's prompt cache starts paying off. All three reference implementations do this;
  the guard that refused it was ours alone. Measured against the live API over six turns:
  `previous_response_id` does **not** reduce billed input tokens — both modes sent about 9,000 —
  but only the service-managed side gets cache hits (the framework-managed side reported zero
  cached tokens on every turn), which came out 23–29% cheaper and 25–38% faster. To keep the
  framework in charge of history — for a message filter, a summarizing provider, or a persisted
  local transcript — set `store: false`: nothing is kept service-side, so no id is reported and
  none is adopted. Hosted agents already set it, because the hosting platform replays the
  transcript itself; leaving it unset there sends the transcript twice. An agent configured with an
  explicit `historyProvider` still fails with `ConfigurationError` when the service claims the
  transcript, unchanged and matching .NET.

- **[BREAKING] `@polymind-inc/agent-framework-core`** — a structured answer is read from the last
  assistant message that says anything, not from every message of the response joined together. A
  run that called a tool leaves more than one assistant message behind, and the earlier ones can
  hold an answer the model then corrected; reading the whole response put the superseded one first
  and handed it back with every field present and every check passing, so nothing downstream could
  tell. Python fixed the same defect in July 2026; .NET still joins, and its file has not been
  touched since February. Non-assistant messages are no longer a source at all — JSON in a tool
  result is data the model was given, not something it said — so a schema that used to be filled
  from a tool result now fails with "the model returned no text". Within the chosen message the
  behaviour is unchanged: several text parts still concatenate, and only the first top-level JSON
  value is read.

- **[BREAKING] `@polymind-inc/agent-framework-core`** — structured-output failures now reject with
  `StructuredOutputError`, a new subclass of `ChatClientError`, so existing `catch` blocks keep
  working. Everything that can fail once a response is in hand reports through it with the original
  failure on `cause`: unparseable or truncated text, a validator that reported issues, a validator
  that threw or rejected instead (an async refinement calling out and failing, for one — previously
  that escaped raw), and a schema that could not be converted. `error.response` is the completed
  response, so the text, usage, finish reason and ids of the turn you were billed for stay
  reachable; the reference implementations parse lazily and leave their callers holding the
  response object, which an eager parse would otherwise take away. It is non-enumerable, so a
  logger that serializes the error does not write the whole conversation into the log line — read
  it by name. This also settles a semantic that was never written down: a parse failure reaches
  context and history providers as a **success**, and the exchange is stored, because the model did
  answer and dropping the turn would leave a hole the next request replays.

- **[BREAKING] `@polymind-inc/agent-framework-anthropic`** — tool arguments that are not an object
  are sent to the Messages API under a single `raw` key instead of being replaced with `{}`. A
  JSON scalar, array or `null` becomes `{ raw: <value> }`, and text JSON cannot parse becomes
  `{ raw: "<the original characters>" }`, untrimmed; only an empty string still maps to `{}`. This
  matches Python, whose Anthropic client sends `parse_arguments()` straight through as
  `tool_use.input`. Normal responses are unaffected — the fallback is reached by interrupted
  streams, restored or hand-built transcripts, and arguments another provider produced. Erasing
  them was measurably worse than keeping them: for a tool whose parameters are all optional, `{}`
  is byte-for-byte a valid no-argument call, so a corrupted payload became a different, plausible
  invocation that nothing downstream could detect, and the API does not catch it either — it does
  not validate a replayed `tool_use.input` against the tool's schema, not even with `strict` and
  `additionalProperties: false`. A tool that declares a `raw` parameter of its own now sees a name
  collision in what the model reads; rename that parameter if the ambiguity matters. Separately, a
  value that is neither a string nor an object — reachable from a session restored from JSON,
  which is not validated — no longer passes through to the wire, where the API rejected it with
  `400 tool_use.input: Input should be an object`. `FunctionCallContent.arguments` and serialized
  sessions are unchanged.

- **[BREAKING] `@polymind-inc/agent-framework-a2a`** — a remote task's status message becomes a
  response message only when the task is waiting for input (`input-required`). Previously an
  awaited `run()` also materialized the status message of a `completed`, `failed`, `canceled` or
  `rejected` task, and fell back to the last agent message in `task.history` for a terminal task
  with no artifacts, while the streamed form of the same task did neither — so how the run was
  consumed changed the answer. Both paths now follow one rule, matching .NET, whose
  `AgentTaskStatusExtensions` returns content for `TaskState.InputRequired` alone and never reads
  `task.history`. An agent that answers with a closing status message and no artifact now folds to
  an empty response: read the task from `rawRepresentation` on the response, whose messages still
  carry it, or take the state from the session. An `input-required` status message that carries no
  parts likewise no longer names a message on the awaited path, which the streamed path already
  declined to do. Artifact conversion and the streamed-artifact deduplication are unchanged.

- **`@polymind-inc/agent-framework-core`** — an approval granted for a call id that an earlier
  completed call had already used is no longer discarded. The approval layer correlated decisions
  against a transcript-wide set of answered call ids, so a provider that reused a call id produced
  a permanent approve → re-ask loop, or lost the decision outright, and a turn carrying no decision
  deleted the stored request for the same reason. Decisions now bind per call occurrence, derived
  from the order of the run's own messages: a result closes only the occurrence before it, and a
  request after the latest result for its call opens a new one — the rule the function-calling loop
  already applied underneath. Replayed copies of one still-open request coalesce with the first copy
  canonical, so a doctored replay cannot displace the request a decision binds against. Nothing
  positional is persisted; serialized sessions are unchanged in shape.

- **`@polymind-inc/agent-framework-agentserver`** — `POST /responses` now accepts an input item
  that omits its `type`, the shape a plain OpenAI Responses `EasyInputMessage`
  (`{ "role": "user", "content": "hello" }`) has and both reference servers accept. The absent
  discriminator resolves to `message` — .NET's item validator supplies that default from its custom
  discriminator resolver, Python's `_request_validators.py` reads `value.get("type", "message")` —
  and the resolved `type` is written onto a copy of the item, so the handler, the minted item id
  and the stored transcript all see `message` instead of quietly dropping an untyped item out of
  persistence. The default applies only when the property is absent: `type: null` and any other
  non-string `type` are still a 400. Defaulting does not waive the message rules, so an item with
  no `type` must carry `role` and `content` — `{ "id": "x" }` is still rejected, now naming
  `$.input[i].role` and `$.input[i].content` rather than only `$.input[i]`, and referencing a
  stored item still needs the explicit `item_reference` discriminator.

- **[BREAKING] `@polymind-inc/agent-framework-agentserver`** — an input item that names
  `type: "message"` is held to the message rules, the same ones an item that omits its `type`
  answers for. Both reference servers dispatch the two spellings to one validator — Python's
  `_validate_OpenAI_ItemMessage` requires `role` and `content` whether the discriminator was
  written out or defaulted — so writing `"type": "message"` no longer buys a laxer check than
  leaving it off. `{ "type": "message", "id": "x" }` was accepted before and is now a 400 naming
  `$.input[i].role` and `$.input[i].content`. To point at a stored item, use
  `{ "type": "item_reference", "id": "x" }`; to send a message, give it a `role` and `content`.
  Items of every other type are unaffected.

- **`@polymind-inc/agent-framework-core`** — a tool call that carries no arguments at all now runs
  with an empty argument object instead of coming back as an `Invalid arguments` result. A
  `function_call` whose `arguments` field is absent or a native `null` reached schema validation as
  `undefined` / `null` and was refused there, so a tool whose parameters are all optional never
  executed — the shape a transcript written by another implementation has, since Python omits
  `arguments` when it is `None`. All three reference implementations invoke the tool in that case
  (Python `dict(parse_arguments() or {})`, .NET's nullable `FunctionCallContent.Arguments`, Go's
  `{}` encoding of empty arguments). Both the ordinary loop and an approval resumed from a
  serialized session take the same view, which is built fresh per invocation and never written back
  to the call: `FunctionCallContent.arguments` is unchanged in the transcript and in the serialized
  session. Empty and whitespace-only argument strings behave exactly as before, malformed non-empty
  JSON is still an `Invalid JSON arguments` result, and the JSON text `null`, non-null scalars and
  arrays are not treated as absent — they go on to schema validation as they always did.

- **[BREAKING] `@polymind-inc/agent-framework-openai`** — a strict structured-output schema is now
  transformed into the closed form the Responses API requires before it is sent. `strict` has always
  defaulted to `true`, but the JSON Schema went out untouched, so a perfectly valid framework input
  — a raw object schema without `additionalProperties: false`, or with a `required` list that does
  not name every property — reached the service as a combination it rejects. The request path now
  rewrites a deep clone of the schema, mirroring the contract Go's `strictSchemaToMap` applies:
  `properties`, `items`, `anyOf`, `oneOf`, `$defs` and `definitions` are walked recursively, every
  object with declared properties gains `additionalProperties: false` and a `required` list naming
  all of them in a deterministic order, and `default` moves into the node's description. The
  caller's schema object is never modified. A schema strict mode cannot express now fails locally
  with the offending path — an explicitly open object (`additionalProperties: true` or a schema
  value), a non-object root, a root `anyOf`, a boolean subschema, an object that declares nothing,
  a `required` entry that is not a declared property, or a keyword outside the strict subset
  (`allOf`, `not`, `if`/`then`/`else`, `patternProperties`, `prefixItems`, `uniqueItems`,
  `minProperties`/`maxProperties`, the `$dynamic*`/`$recursive*` family and the rest) — instead of
  producing an opaque service 400. Schemas that already satisfied strict mode, including everything
  zod emits, are unchanged on the wire. Pass `strict: false` to send a schema through untouched, as
  before. A `responseFormat` given without a name now takes its name from a string root `title` on
  the schema, matching Python; an explicit `name` still wins, and the `title` keyword stays on the
  schema.

- **`@polymind-inc/agent-framework-mcp`** — an MCP server's tool names and input schemas are
  normalized before they reach a provider, and `McpClientConfig.toolNamePrefix` is new. MCP puts no
  restriction on a tool name while providers accept only `[A-Za-z0-9_.-]` in a function name, and a
  zero-argument tool declared as a bare `{ "type": "object" }` is rejected by OpenAI for having no
  `properties` — both were passed through unchanged, so a valid server could produce a request the
  provider refused or a tool the model could not name. The exposed name now replaces every other
  character with `-` (`search docs!` becomes `search-docs-`), the reference implementations' rule
  in Python's `_normalize_mcp_name` and Go's `normalizeMCPName`; an object schema gains
  `properties: {}` when it has none, and a missing schema becomes
  `{ "type": "object", "properties": {} }` — on a copy, so the server's own declaration is never
  modified. The remote name is what still goes out on `tools/call`, and what `allowedTools`, the
  `approvalMode` callback and error messages speak in. `toolNamePrefix` exposes tools as
  `<prefix>_<name>`, so two servers that both advertise `search` can be told apart; the prefix is
  normalized the same way, loses trailing `_.-`, and is ignored when nothing is left of it, as
  Python's `tool_name_prefix` does. Prefixes are the only thing that separates clients — none
  infers another's namespace. When two of one server's tools would be exposed under the same name,
  `getTools()` now rejects and names both remote tools and the name they collide on, rather than
  silently shadowing one of them.

- **`@polymind-inc/agent-framework-core`** — a run that exhausts `maxIterations` no longer ends on
  a tool call nobody will make. The final, over-budget request already withdrew the local function
  declarations; it now also sends `toolChoice: 'none'` (previously `'auto'`), and a local
  `function_call` or local `function_approval_request` the provider emits anyway is removed from
  that round instead of being returned unexecuted — in both awaited and streamed form, which fold
  to the same messages. Filtering is per update, so everything an update keeps is still forwarded
  the moment it arrives; text, reasoning, response metadata, raw representation, hosted content,
  provider-hosted approvals and `informationalOnly` call/result pairs are untouched, and an update
  left with metadata but no content stays visible. When finalization leaves no non-blank
  user-visible answer and no hosted approval, the run ends on the fixed sentence
  `Function invocation limit reached before a final answer could be produced.`, matching Python's
  `_ensure_function_invocation_limit_fallback_response`; content that survived is never displaced
  to make room for it. Requesting structured output from a run that ends this way now raises the
  ordinary "not valid JSON" error rather than silently returning `value: undefined`, because the
  response is no longer a suspended one.

- **[BREAKING] `@polymind-inc/agent-framework-agentserver`, `@polymind-inc/agent-framework-foundry`**
  — a server built without an explicit `store` now persists responses to the **filesystem** rather
  than to memory. `new ResponsesServer({ handler })` and a non-hosted `ResponsesHostServer` both
  default to `FileResponseProvider` under `${AGENTSERVER_STATE_ROOT}/responses`
  (`~/.agentserver/responses` when that variable is unset), so a `previous_response_id` chain
  survives a restart instead of answering 404 — the local default both reference servers already
  make (.NET registers `FileResponsesProvider` for a non-hosted host; Python's
  `ResponsesAgentServerHost` falls through to `FileResponseStore`, under the same state root).
  A hosted `ResponsesHostServer` is unchanged: the Foundry storage service when the platform
  injects the project endpoint, the sandbox filesystem when it does not.

  **Migration.** Nothing to do to keep the new behaviour, but two consequences are worth a
  decision. First, the process now writes to disk where it previously did not: it needs write
  access to the state root, and a read-only or ephemeral filesystem wants
  `AGENTSERVER_STATE_ROOT` pointed somewhere writable. Second, **transcripts are persisted in the
  clear** — each file is plain JSON holding a whole conversation, readable by anything running as
  the same account, and nothing in this package expires, rotates or bounds them. Retention,
  cleanup and the directory's permissions are the operator's responsibility. To keep the previous
  process-local behaviour, pass the store explicitly:

  ```ts
  new ResponsesServer({ handler, store: new InMemoryResponseProvider() });
  ```

  Tests are the other place this shows up: a suite that builds a server without naming a store now
  writes into `~/.agentserver` unless it pins `AGENTSERVER_STATE_ROOT` to a temporary directory —
  this repository's own suites pass an in-memory store explicitly and pin the root regardless.

- **`@polymind-inc/agent-framework-anthropic`** — the code-execution beta's blocks are read as the
  typed content the framework already models instead of falling through the generic rules. The beta
  is requested by default, but a `tool_use` / `server_tool_use` whose name identifies code execution
  arrived as an ordinary function call and every result block arrived as unknown content. A code
  execution call is now a `code_interpreter_tool_call` carrying its call id and its input;
  `code_execution_tool_result` becomes a `code_interpreter_tool_result` whose outputs are the run's
  stdout (plain or encrypted) as text, its stderr as an error, and its files as `hosted_file` items;
  `bash_code_execution_tool_result` becomes a `shell_tool_result` holding one
  `shell_command_output` with stdout, stderr, exit code and a `timedOut` flag set for
  `execution_time_exceeded`, with the run's files reported beside it; and
  `text_editor_code_execution_tool_result` becomes a `function_result` whose items are the error,
  the viewed text, the replaced lines or the create flag, annotated with the line spans the wire
  reported. Each mapping matches Python's shape and keeps the provider block on
  `rawRepresentation`, so fields the framework does not model survive. Ordinary tool calls are
  untouched, and a block — or a result payload — of a kind this build does not model still becomes
  unknown content that round-trips verbatim. Provider-executed calls are also no longer emitted
  before their arguments arrive: while streaming, a `server_tool_use`, an `mcp_tool_use` or a code
  execution call is converted once its block closes, so the accumulated `input_json_delta`
  fragments reach the folded transcript instead of being dropped — a streamed hosted call used to
  land with empty arguments. A local `tool_use` still streams its arguments as before. Replaying an
  exchange that used code execution sends the provider's own blocks back on the assistant turn that
  produced them, the rule unknown content already followed, so typing them costs the conversation
  nothing on its next turn. No new exports, tool declaration factory or request-side field: the
  contents produced are the ones core already defines and serializes.

- **`@polymind-inc/agent-framework-core`** — chat spans and the two chat metrics
  (`gen_ai.client.token.usage`, `gen_ai.client.operation.duration`) now carry `server.address`,
  naming the endpoint the model call went to. The key was already on the metric dimension
  allowlist but nothing produced a value, so no span or histogram ever reported it. The value is
  the host of the client's endpoint (`api.openai.com`), the form the semantic conventions define
  for this key and the one MCP spans already emit, and it is `unknown` when the client names no
  endpoint — so a dashboard grouping by `server.address` sees one dimension set across every
  provider. `ChatClientMetadata` gains an optional `providerUri` for a client to declare that
  endpoint; the OpenAI, Anthropic and Foundry clients fill it from their SDK's base URL. No
  existing attribute changed type or shape, and `server.port` is still not emitted. The
  `invoke_agent` span does not carry the address: it describes the agent, not a connection.

- **[BREAKING] `@polymind-inc/agent-framework-core`** — the parts inside `gen_ai.input.messages`
  and `gen_ai.output.messages` are named with the semantic conventions' vocabulary instead of the
  framework's own content types, and the `chat` span's final output message now carries a
  `finish_reason`. **Dashboard migration:** a query that filters or groups on a part's `type` must
  be updated — `text_reasoning` → `reasoning`, `data` → `blob`, `function_call` → `tool_call`,
  `function_result` → `tool_call_response`. `text` and `uri` already matched and are unchanged, as
  is every part kind the conventions do not name, which keeps its framework type on both sides.
  The old spellings were internal names that appeared in no other implementation's traces: Python's
  `_to_otel_part_latest_experimental` and .NET's `OtelMessageSerializer` both emit the four names
  above, so one query now reads message parts from a TypeScript, Python or .NET trace alike. The
  new `finish_reason` sits beside `role` and `parts` on the **last** output message of the `chat`
  span only, carrying the same normalized value as `gen_ai.response.finish_reasons` (`tool_calls`
  becomes `tool_call`) — the position and the span Python stamps it in; the `invoke_agent` span's
  output messages are unchanged. Nothing was added to a part's payload: parts stay compact
  (`text` carries its `content`, every other part is its `type` alone), so tool-call ids, names and
  arguments, tool-result ids and responses, blob bytes, URIs, mime types and modalities are still
  deliberately absent from spans — they belong to the transcript, and a rendered image attachment
  alone would grow one message list past the size at which a backend truncates the attribute and
  the whole list is lost. That trade-off, the fields it drops, and the cross-implementation
  differences in `gen_ai.response.finish_reasons` (an array of strings here, JSON text in Python
  and .NET, absent in Go) are now documented on the `GEN_AI` attribute constants. `server.port` is
  still deliberately emitted by nothing, on spans and on metric dimensions alike, and its absence
  is now pinned by tests.

- **`@polymind-inc/agent-framework-core`** — a streamed code-interpreter call now folds back into
  one item. `coalesceContents`, and with it `mergeUpdates` / `mergeChatUpdates`, previously left
  every `code_interpreter_tool_call` and `code_interpreter_tool_result` fragment in the transcript,
  so a provider that streams the code as deltas produced a list of partial calls where the awaited
  form of the same turn holds one. Fragments are now correlated by their content type together with
  `callId`, falling back to `additionalProperties.item_id` when the provider streams no call id,
  and fold into the first fragment with that key — which keeps its position, so narration that
  arrived between the fragments stays where it was. `inputs` and `outputs` merge the way Python's
  `_merge_content_item_lists` does: text-only lists collapse to the longer side when one is a
  prefix of the other (the `done` event repeating the whole code replaces its own deltas instead of
  being appended to them), disjoint text is joined, and anything else is concatenated;
  `additionalProperties` merge with the later fragment winning and annotations are concatenated.
  Fragments naming different calls, a call and a result naming one id, and fragments naming nothing
  at all are all left exactly as they arrived. The other content types coalesce as before.

- **`@polymind-inc/agent-framework-core`** — the trailing metadata-only update that
  `chatResponseToUpdates` and `agentResponseToUpdates` append for response-level usage, additional
  properties or a continuation token no longer repeats the response's `finishReason`. Anything that
  reads an exploded response as a stream — the function-invocation loop replaying a non-streaming
  round, a middleware answering a run without invoking the agent, the telemetry client — saw the
  turn announce a finish reason a second time on an update carrying no message content, a shape no
  provider stream produces. The message updates carry the reason exactly as before, so folding the
  sequence back yields the same response, and both reference implementations agree: .NET's
  `ChatResponse.ToChatResponseUpdates` builds its trailing update from `AdditionalProperties` and
  usage alone, and Go's `Response.ToUpdates` is asserted to leave that update's finish reason empty.
  One consequence, shared with both of them: a response that has no messages at all — where the
  trailing update is the only one — no longer reports a finish reason to whoever folds the sequence.

- **`@polymind-inc/agent-framework-core`** — a tool that stops for a human without naming anything
  a human could settle now reports `exception: "UserInputRequiredException"` on the
  `function_result` it hands the model, instead of `"UserInputRequiredError"`. The marker is
  wire-visible and was being derived from the thrown error's class name, so a consumer branching on
  `function_result.exception` — or a transcript compared against another implementation — saw a
  string no other implementation emits; Python's `_execute_single_function_call` writes
  `exception="UserInputRequiredException"` for the same case. The marker is now a fixed literal
  rather than the error's `name`, so subclassing or renaming `UserInputRequiredError` cannot change
  it. Everything else about this path is unchanged: the model-facing text is still
  `Tool requires user input but no request details were provided.`, `includeDetailedErrors` still
  appends ` Exception: <message>` to that text and nothing else, the round still counts against the
  consecutive-error budget, and the run still continues.

- **`@polymind-inc/agent-framework-anthropic`** — a configured `toolChoice` now reaches the wire
  even when the request declares no tools. `tool_choice` was gated on the request carrying local
  tool declarations or an `mcp_servers` entry, so a choice set on a request with neither was
  dropped — including the function-calling loop's own final round, which withdraws local
  declarations precisely while pinning the choice to `'none'`, and any caller that asks a
  tool-free request not to call tools. Python's `_prepare_tools_for_anthropic` and Go's
  `anthropicprovider` both build `tool_choice` from the option alone, so the field is now sent
  whenever a choice was configured and omitted only when none was. Requests that already carried
  declarations are unchanged, as is the mapping itself (`auto` → `auto`, `required` → `any` or a
  single named `tool`, `none` → `none`). The OpenAI Responses client still gates `tool_choice` on
  `tools`, matching its own reference implementation.

- **`@polymind-inc/agent-framework-mcp`** — the failure text of a tool result that reports
  `isError` now puts each text block on its own line. The blocks of a failed call are separate
  messages — a summary and its detail, or one line per item that failed — and concatenating them
  without a separator ran them together as `...rejected itretry after 30s`, in the
  `ToolInvocationError` the model is told about and in the `tools/call` span's status message
  alike. Both are now joined by one rule: text blocks only, in order, separated by a newline, with
  empty blocks contributing nothing rather than a blank line. The two texts are not identical — the
  exception is built from the converted contents, so a call that reported `structuredContent` still
  carries it as the last line, while the span message is built from the result's own blocks and
  never had it. A result whose blocks carry no text at all still falls back to the generic
  `MCP tool "<name>" reported an error.` message. The shared
  `textOfContents` is untouched and stays a verbatim concatenation — it answers what a message
  said, where a streamed response splits text at arbitrary token boundaries. The equivalent
  assembly in `FoundryToolbox` is unchanged for now; it diverges in more than the separator and is
  tracked separately.

- **`@polymind-inc/agent-framework-mcp`** — a skill discovered over MCP no longer asks the server
  for a resource whose name is empty or only whitespace. Such a name was appended to the skill root
  unchanged, so `getResource('')` issued a `resources/read` for the skill's namespace URI and handed
  back whatever the server serves there — content the caller never named. The name is now refused
  before the request goes out and the call answers `undefined`, the same answer a name that fails
  the traversal checks already got. The skills provider's `read_skill_resource` tool rejected blank
  names before reaching the skill, so this is visible only to code calling the `Skill` API directly.
  Whitespace decides blankness alone: a name with content in it is still requested exactly as the
  server listed it, untrimmed and undecoded.

- **`@polymind-inc/agent-framework-core`** — the `run_skill_script` tool now declares
  `"default": null` on its `args` parameter and says that how the arguments reach the script is
  "determined by the script implementation or configured runner". Both are model-visible schema
  text: without the default, a model reading the schema had no statement that omitting `args`
  is a supported call, and the description named only the in-process case even though a
  file-based script is run by the `scriptRunner` its source was given. The default is advertised,
  not applied — a script still receives `undefined` for an omitted `args` and `null` for an
  explicit one, so nothing about execution changes. The whole published schema is now pinned by an
  exact assertion.

- **`@polymind-inc/agent-framework-agentserver`** — the `x-request-id` a response carries is now
  the trace the request belongs to, when it names one. The value was the caller's `x-request-id`
  header or a minted UUID, never the trace id, so the id on the response led nowhere in a trace
  backend; both reference servers resolve the same three sources in the same order (.NET
  `RequestIdMiddleware.ResolveRequestId`, Python `_request_id._resolve_request_id`). The trace id
  is taken from the span active around the request, else from a registered propagator's extraction
  — so a non-W3C format is honored — else from the `traceparent` header read directly, which keeps
  the answer identical whether or not an OTel SDK was registered in the process. A trace id that is
  not 32 hex digits, or is all zeros, names no trace and is skipped, as is an empty `x-request-id`
  (previously echoed back as an empty header). The resolved value is the one already shared by the
  response header, the `request_id` in an error body and `HostedAgentContext.requestId`, so all
  three continue to agree. The `azure.ai.agentserver.x-request-id` baggage entry and the
  `x_request_id` baggage the server propagates are unchanged: both still carry the header exactly
  as the caller sent it, and are absent when the caller sent none.

## 0.4.0

A hardening and consolidation release: ten breaking changes tighten types, credentials, telemetry
and the supported surface against the reference implementations — Foundry configuration
centralizes in `FoundryProject`, GenAI message events move to the `chat` span with v1.36.0
bodies, and the provider request-assembly helpers leave the supported core surface — alongside
safety fixes across streaming, serialization, hosting and the release pipeline.

- **[BREAKING] `@polymind-inc/agent-framework-core`** — `setIfDefined`, `withoutUndefined`,
  `topLevelMediaType` and `arrayToStream` are no longer exported from the root entry. They assemble
  a request payload for a specific provider SDK — an implementation detail of writing a
  `ChatClient`, not part of the programming model — and none of the reference implementations
  publishes a counterpart in this shape. They now live on the `/internal` subpath the framework's
  own packages share, which carries no compatibility promise. Each is under ten lines and inlines
  directly: `setIfDefined`/`withoutUndefined` drop the entries whose value is `undefined`,
  `topLevelMediaType` lowercases the part of a media type before the `/`, and `arrayToStream`
  yields an array's items from an async generator.
- **[BREAKING] `@polymind-inc/agent-framework-core`** — the `MiddlewareKind` type is removed. It
  was a free-standing alias nothing in the framework consumed; the discriminant lives on the
  middleware objects themselves, so `Middleware['kind']` expresses the same type where one is
  needed.
- **[BREAKING] `@polymind-inc/agent-framework-agentserver`** — the `TERMINAL_EVENT_TYPES`
  constant is no longer exported. The `TerminalEventType` type and the `isTerminalEventType`
  predicate remain: use the predicate to test an individual event type. Code that enumerated or
  iterated the exported tuple has no direct replacement.
- **`@polymind-inc/agent-framework-core`** — a new `/internal` subpath holds the utilities the
  framework's own packages share. Like the other `/internal` entries, it is a
  contract between the framework's packages and not part of the supported surface.
- **`@polymind-inc/agent-framework-anthropic`** — a replayed `function_call` whose string
  arguments parse to a JSON array or scalar no longer reaches the API as `tool_use.input`; it
  degrades to `{}` like every other non-object payload, keeping `input` the JSON object the
  Messages API requires.
- **[BREAKING] `@polymind-inc/agent-framework-foundry`** — Foundry credentials and the project
  endpoint are centralized in the new `FoundryProject` handle
  (`new FoundryProject(endpoint, credential, { scope?, fetch? })`, mirroring
  `new AIProjectClient(endpoint, credential)` from `@azure/ai-projects`: both arguments are
  required, and neither is resolved from the environment or constructed implicitly).
  `FoundryChatClient`, `FoundryMemoryProvider`, `FoundryToolbox` and `FoundryResponseStore` take a
  required `project` instead of the removed per-component `credential`, `scope` and
  `projectEndpoint` options — previously each component silently constructed its own
  `DefaultAzureCredential` chain, and a stale `FOUNDRY_PROJECT_ENDPOINT` could silently decide
  where bearer tokens were sent. Every component built from one project shares one per-scope
  bearer-token cache. The `tokenProvider` export is removed; `project.getToken()` is its
  successor. The one remaining implicit default is inside the hosting bootstrap: a hosted
  container's default response store still assembles its project from the platform-injected
  endpoint and `DefaultAzureCredential`, the same default the Python agent server's Foundry
  storage applies. The reference implementations all demand this explicitness: .NET and Python
  hang every Foundry feature off an explicitly constructed `AIProjectClient` (Python requires
  `credential` whenever no `project_client` is given), and Go takes a credential as a required
  constructor argument.
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
  of its two selectors. When an already-configured SDK `client` is supplied, `baseURL` reports the
  client's actual URL.
- **[BREAKING] `@polymind-inc/agent-framework-foundry`** — `FoundryTarget`'s `modelDeployment`
  selector is renamed `model`, and the exported guard `isModelDeployment` is renamed
  `isModelTarget`. The value still names a model *deployment* in the project; `model` is what both
  .NET (the `model` parameter on `FoundryAgent` and `AsAIAgent`) and Python (the `model` keyword,
  `FOUNDRY_MODEL`) call it, while Go's `ModelDeployment` is a per-mode *type* name in a design
  TypeScript's discriminated union does not share.
- **[BREAKING] `@polymind-inc/agent-framework-core`** — with sensitive-data capture enabled, the
  per-message GenAI telemetry events (`gen_ai.system.message`, `gen_ai.user.message`,
  `gen_ai.assistant.message`, `gen_ai.tool.message`, `gen_ai.choice`) are emitted on the `chat`
  span only, with the OTel GenAI v1.36.0 structured bodies carried as JSON on the `body`
  attribute. Previously every exchange was double-reported — the same events also fired on the
  `invoke_agent` span — and the payload was a role+parts serialization matching neither semconv
  generation; the reference implementations emit message events for the model invocation only.
  The `invoke_agent` span keeps attribute-form content (`gen_ai.input.messages` /
  `gen_ai.output.messages` are unchanged on both span kinds). Every event carries `gen_ai.system`,
  a response without a finish reason emits no `gen_ai.choice`, and event timestamps step one
  microsecond apart so ordering survives backends that collapse tight timestamps. Consumers
  reading message events off `invoke_agent` spans, or parsing the previous `content` attribute
  payload, must switch to the `chat` span's events and the JSON `body` attribute.
- **Security:** approval requests are immutable snapshots before they reach callers, so mutating a
  streamed or awaited request cannot change the arguments later executed after approval. Raw JSON
  Schema arguments are checked locally, executable-only approval bypassing no longer consumes
  declaration-only calls, and reused function call ids are correlated by logical occurrence.
- `ResponseStream.finalResponse()` now shares concurrent source initialization and draining, so
  repeated concurrent calls cannot duplicate model/tool work or leak an iterator. Middleware
  cancellation before the first pull and update-hook failures now finalize the run consistently.
- A streamed run interrupted under `allowBackgroundResponses` no longer double-stores its
  exchange. A streaming run that ends suspended skips history persistence entirely — its
  continuation token replays the caller's input and every update already produced — so the run
  that finally completes appends the whole exchange exactly once, with partial messages merged by
  the fold rather than split across store entries. Previously the suspended run and the resumed
  run each persisted the input and the partial updates, so the next turn replayed the question
  and the partial answer twice, violating the documented `HistoryProvider` contract
  (`saveMessages` is handed only the messages new to that turn). Awaited suspensions are
  unchanged: their tokens carry nothing, so each half stores its own fragment. The fold takes the
  continuation token from the latest update, so a background stream that runs to completion
  persists normally.
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
  container examples align with the platform's root-owned persistent `HOME` mount — forcing a
  non-root user there kept the hosting stores from writing session and approval state.
  SSE keep-alives obey backpressure,
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
- The skills system prompt now distinguishes the two script-argument shapes: a JSON object for
  named arguments (inline scripts included), and a string array for file-based scripts that
  document CLI-style positional arguments (`args: ["input.docx", "--output", "result.idx"]`). The
  script runner has accepted both all along, but the prompt showed only the object form, steering
  models away from positional arguments; the wording now matches the Python implementation.
- Core base64 conversion now writes pre-sized typed arrays, avoiding per-byte boxed allocations for
  large attachments while retaining the runtime-neutral implementation.
- Repository: repeated tsdown, Vitest and TypeScript configuration is consolidated into shared
  workspace presets, and single-consumer internal layers were removed with published entry points
  and generated declarations unchanged (the Foundry chat client now inherits the OpenAI
  implementation). Dependencies were bumped, the provider SDKs among them.

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
