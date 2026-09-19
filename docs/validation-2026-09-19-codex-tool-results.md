# Codex tool failure visibility — 2026-09-19

## Reproduction and scope

At baseline `f62b074`, a native `mcpToolCall` with `status: "failed"`,
`arguments: {team: "Engineering"}`, `result: null`, and
`error: {message: "Workspace access was denied"}` produced a completed tool event
whose output was the literal JSON string `""`. It omitted input, the error,
and a failure flag. The renderer could therefore present it as finished.
The baseline mapper was evaluated directly from Git to confirm those omissions.

The installed Codex CLI (`0.155.0`) generated its protocol types locally using
`codex app-server generate-ts --experimental`. Its `ThreadItem`,
`McpToolCallResult`, `McpToolCallError`, and status types confirm MCP
`arguments`, `status`, `result`, and `error.message`; dynamic tools also expose
`arguments`, `status`, `contentItems`, and `success`. Native MCP result types do
not expose raw MCP `isError`; this change does not claim arbitrary raw-protocol
compatibility.

The mapper now preserves sanitized input and native error details, marks native
failures, and distinguishes absent results from successful empty results.
Partial output and a native error can coexist. Known account/capability values
are still redacted by the existing JSON-RPC transport; structured secret keys
are additionally masked before the 16,000-character input/output limits.
MCP provider-internal `_meta` and unrelated reasoning fields are not displayed.

## Verification

- Five new regression tests use the actual fake CLI JSON-RPC transport, including
  started/completed events, terminal-only events, native error and false-success
  flags, successful empty results, missing results, partial failures, credential
  redaction, truncation, and controller persistence/replay.
- Six focused files passed **39/39** tests, no skips:
  `codex-tool-results`, `adapters`, `codex-message-boundaries`,
  `account-secret-runtime`, `activity-timeline`, and `agent-threads`.
- Command: `taskset -c 0,1 nice -n 10 node --test --test-concurrency=1`
  followed by those six `test/*.test.mjs` files.
- Separately, the parent verified **2/2** renderer browser cases after the
  repository's `build-auth` prerequisite (failure/missing/success labels,
  arguments, reload, mobile layout, and literal HTML output).
- Integrated source `e8436d9` was then checked in a clean worktree: the same
  **39/39 Node tests** passed with zero failures/skips (14.5 seconds), followed
  by **2/2 browser tests** with no retries (3.8 seconds). The existing full-suite
  receipt predates this narrow correction; no new full-suite run is claimed.
- Independent read-only review accepted the native schema mapping, credential
  handling, persistence path, and renderer coverage. Publication remains pending
  to avoid restarting the worker while the user verifies Linear.

No real model prompt, provider request, OAuth consent, credential copying, cloud
operation, or deployment was performed. This verifies event presentation, not
live Linear authorization or provider availability.

## Release preparation (subsequent checkpoint)

After the focused acceptance above, the parent prepared an immutable image from
committed source `94860e7afe408475db3c6964fb6851c3e018446c` in the clean integration
worktree. Runtime source remains `e8436d9`; uncommitted main-worktree changes and
private credentials were excluded by the existing allowlisted Git archive.

The complete Node suite on that exact source then passed **1,291/1,291**, with
zero failures, skipped cases or cancellations, in 279,555.8 ms (terminal exit 0).
The run enabled all three normally optional installed-CLI/Chrome checks:

```sh
AGENT_TEST_NATIVE_GITHUB=1 RELAY_GUEST_UI_TEST=1 \
  taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 test/*.test.mjs
```

This supersedes the earlier full-suite evidence for this candidate. The two
renderer browser cases above were already verified on the same runtime and test
source; the intervening commit changed documentation only. These remain local
acceptance results, not a deployed selected-account/Linear success claim.

- CodeBuild: `ImageBuild-t8BSbSkDsHYX:ca505b1f-187d-4d76-91ea-aca81dca18d0`.
- Terminal result: `SUCCEEDED`, phase `COMPLETED`.
- Immutable source object version: `fql_cc_xWGaYErVqtWIIz9AakiI0_24h`.
- ECR repository: `456808212788.dkr.ecr.us-east-2.amazonaws.com/agent-relay-mvp-applicationrepository-sujdgarjwejp`.
- Image digest: `sha256:26585b5eee18cbdfd7cef9150e3c5a5ecdfd9ab98aa4e03cc437e08d765ff46b`.

This later checkpoint does perform AWS source upload/build/status operations,
but **not a rollout**. No worker was stopped or restarted. The deployed build
remains `d9c0ce6` (runtime `8db8247`); the new image is only a candidate until
the user's ongoing Linear check is complete and a guarded rollout is coordinated.
