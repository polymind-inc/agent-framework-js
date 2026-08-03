# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report vulnerabilities privately, either through GitHub's
[private vulnerability reporting](https://github.com/polymind-inc/agent-framework/security/advisories/new)
or by email to **me@shibayan.jp**. Include a description of the issue, a proof of concept if you
have one, and the package name and version. You should receive an acknowledgement within a few
days; please allow a reasonable disclosure window before publishing.

## Supported versions

Only the latest published 0.x release line receives security fixes. All seven
`@polymind-inc/agent-framework-*` packages are released in lockstep — a fix bumps them together.

## Deployment notes

- `@polymind-inc/agent-framework-agentserver` trusts the `x-agent-user-id` request header for user
  partitioning. It is designed to run **behind the Microsoft Foundry gateway**, which injects
  that header. Exposing the port to anything else means trusting whoever can reach it to say who
  the user is — do not expose it directly.
- Model provider API keys should live server-side. The core runs in browsers, but calling
  providers directly from a browser exposes your key.
