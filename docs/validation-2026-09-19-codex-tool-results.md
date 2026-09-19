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

No real model prompt, provider request, OAuth consent, credential copying, cloud
operation, or deployment was performed. This verifies event presentation, not
live Linear authorization or provider availability.
