# Contributing

Thanks for your interest. This project is a TypeScript implementation of the Microsoft Agent
Framework programming model, written so that it could plausibly be contributed upstream to
[`microsoft/agent-framework`](https://github.com/microsoft/agent-framework). That goal sets the bar
for changes: the rules below are not style preferences, they are what keeps the implementation
substitutable for the first-party ones.

## Getting set up

Requires **Node.js >= 24** and **pnpm** (the version is pinned in `packageManager`; enable it with
`corepack enable`).

```bash
pnpm install
pnpm check     # lint, typecheck, build, test — the same gate CI runs
```

Individual steps: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`. To work on one package,
use a filter — `pnpm --filter @polymind-inc/agent-framework-core test:watch`.

Lint and format are [Biome](https://biomejs.dev/) with the recommended preset; `pnpm lint:fix` and
`pnpm format` apply what is auto-fixable. The repository normalizes to LF line endings
(`.gitattributes`), and CI runs on Windows as well as Linux to keep that honest.

## The rules that matter

**1. Semantics match the reference implementations exactly.** Signatures follow TypeScript idiom —
that part is free. Behaviour is not: default values, side effects, folding, loop behaviour,
cancellation and serialization must match. When the implementations disagree, the order of
authority is **.NET, then Python, then Go**. Read the reference source; do not infer behaviour from
documentation or from what seems reasonable.

**2. Use the current naming generation.** Names follow the post-rename (v1.13) generation:
`Agent`, `AgentSession`, `Message`, `Content`, `AgentResponse`. The older names that appear in
articles and blog posts — `ChatAgent`, `AgentThread`, `AgentRunResponse`, `ChatMessage` — are not
used anywhere, including in comments and tests.

**3. Do not break the wire format.** Serialized properties are camelCase; `Content` discriminator
values are the Python snake_case literals; data this implementation does not recognize is preserved
and round-tripped rather than dropped. Any change to a serialized shape is a breaking change and
needs to be called out in the pull request.

**4. Keep the core's dependencies at one.** `@polymind-inc/agent-framework-core` depends on
`@opentelemetry/api` at runtime and nothing else. Schema libraries are *accepted* through the
[Standard Schema](https://github.com/standard-schema/standard-schema) interface — never depended
on. Node-specific APIs do not belong in the core; the core has to keep running on Deno, Bun, edge
runtimes and in browsers.

**5. The public API is frozen as Baseline v0.1.** Changes to the frozen surface are possible but
deliberate — open an issue describing the deviation and the reference behaviour that motivates it
before writing the code.

## Fixing a bug

Reproduce first, then fix:

1. Write a test that **fails** against the current code and captures the actual defect.
2. Make the fix.
3. Revert the fix temporarily and confirm the test fails again. A test that passes both with and
   without the fix is not testing the fix.

Parity bugs — where this implementation behaves differently from .NET, Python or Go — are the
highest-priority class of issue. When you report one, say which implementation you compared against
and where the difference is.

## Comments and documentation

Comments must be self-contained: they explain the code to someone reading it for the first time,
with no reference to internal design documents, milestone numbers or decision logs. Prefer
explaining *why* over restating *what*.

Public API carries TSDoc. Anything touching prompt handling, session restoration or tool execution
also carries an explicit **"Security considerations"** note, as the .NET implementation does.

## Pull requests

- One concern per pull request.
- `pnpm check` passes.
- Behaviour changes come with a test that fails without the change.
- Public API changes update the package README and `CHANGELOG.md`.
- Say which reference implementation you checked against, and whether the wire format is affected.
  The pull request template asks for both.

## Releasing

Maintainers only. All packages ship in lockstep:

```bash
pnpm version:set 0.2.0      # sets the version in every publishable package
# update CHANGELOG.md, commit
git tag v0.2.0
git push origin v0.2.0      # push this tag only — `--tags` would publish every unpushed tag
```

Pushing the tag runs the release workflow, which re-runs the full gate, verifies the tag matches
the package version, and publishes all seven packages to npm with provenance.

## Code of conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Contributions are accepted under the [MIT License](LICENSE).
