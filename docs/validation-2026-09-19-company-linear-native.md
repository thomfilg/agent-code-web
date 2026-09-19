# Company-selected Linear: native CLI audit (2026-09-19)

## Scope and change

Reviewed the company registry, automatic environment MCP selection, runtime
gateway grants, OAuth lifecycle, native capability environment interpolation and
the existing tests from base `1047a9503a5019276fadef9b24f550d4550c872e`.

The runtime already selects company MCPs without a second environment selector.
However, the successful OAuth message still instructed users to select the MCP
in an environment. It now describes automatic company-chat availability on the
next agent start; legacy configurations retain their previous instruction.
The Linear guide now describes the current company policy and g2i-only binding.

The existing actual-CLI smoke previously used an unauthenticated, unassigned
fixture. It now tests the registered-company authenticated path rather than
adding another overlapping fake-adapter test suite.

## Verification

```sh
taskset -c 0,1 nice -n 10 node scripts/smoke-real-mcps.mjs
node scripts/build-auth.mjs
taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 test/linear-mcp.test.mjs test/mcp-oauth.test.mjs test/mcp-connections.test.mjs test/companies.test.mjs test/worker-capabilities.test.mjs
git diff --check
```

- Native smoke passed with installed **codex-cli 0.155.0** and **Claude Code
  2.1.222** in a loopback-only network namespace with disposable CLI profiles.
- **35/35** selected unit/integration tests passed, no skips or failures.
- The first smoke attempt rejected the fixture because it put `companyId` on
  the chat rather than its primary repository. Correcting the fixture to the
  production record shape made the smoke pass; no application behavior was
  changed to accommodate that fixture error.

The smoke completes synthetic browser-bound OAuth for two same-name Linear
connections with separate tokens. An environment with an empty saved MCP list
automatically selects only its company's connections. A repository whose GitHub
owner differs from its stored Relay company demonstrates that selection uses the
registered company. Runtime filtering additionally rejects an injected foreign
connection ID before granting worker access.

Actual Codex discovers `list_teams`, the stdio tool and browser tools. Actual
Claude reports all three selected MCPs connected. Both use the same capability
environment transformation as their production adapters, keeping capability
values out of argv and upstream OAuth credentials out of the worker environment.
SDK calls through those same gateway capabilities verify the selected fixture
workspace. Foreign-company requests and revoked capabilities return 401. The
foreign workspace receives only its explicit connection verification read.

## What this does not prove

No model prompt or real provider request occurred. The deterministic SDK reads
are gateway checks, **not** native CLI tool execution. No real credentials were
copied, and no production deployment or existing browser profile was touched.

The prior September 18 company deployment receipt records a real g2i controller
verification with 79 tools and successful `list_teams`; that historical result
does not prove current selected-worker access. The live acceptance gate remains
an authenticated `tools/list` and `list_teams` from the selected deployed worker,
using its existing controller-issued capability, followed by scoped denial and
controlled restart verification. The committed deployed smoke only performs
anonymous denial probes, not this authenticated worker check. A current AWS
session and accessible selected worker must be established before that gate can
run; the local fixture is not a substitute.

The coordinating agent's September 19 read-only AWS check classified the
`code-web` STS session as **credentials-expired**, while public `/readyz` returned
200. Consequently it could not refresh the worker inventory or inspect that
authenticated worker path. No live Linear failure is inferred from expired AWS
operator credentials.
