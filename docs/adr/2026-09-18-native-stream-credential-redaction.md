# Native account credentials at streaming boundaries

Status: implemented; fixture verification and independent review recorded with
the change. This is output hygiene, not a new worker isolation boundary.

## Problem

Masking an access token independently in each native JSON frame was insufficient:
two `text_delta`/`agentMessage/delta` events could reconstruct the token in live
SSE, saved messages, background responses and Codex child-agent previews. Final
complete-message redaction cannot undo bytes already sent to a browser or an
event replay cache.

## Decision

Named-account text sinks share a stateful literal-secret filter. They publish
only characters that cannot still be part of a selected credential. The held
suffix is shorter than the longest known token; ordinary text streams without
waiting for a full answer. Rotated tokens join the same live set and old values
remain protected for the adapter's lifetime, including resumed/late output.

A complete short token which is also a prefix of a longer token waits for the
longer match. On normal completion, failure, interrupt, process shutdown or a
message boundary, an ambiguous suffix becomes `[redacted]`, never raw text.
This intentionally prefers a possible false-positive marker at a truncated
token prefix over exposing a partial credential. Anthropic-shaped historical
tokens retain the previous generic masking behavior, now across arbitrary
chunks, without buffering an unbounded token body.

Claude keeps raw text privately only to compare native duplicate/full-message
events; the public text cache and emitted deltas are always the same sanitized
text. That private deduplication state is discarded at completion. Background
answers use the same sink. Tool/request/notice payloads are sanitized before
public hooks, and private debug capture applies the current token set before
writing disk. Native protocol fields used internally are not replaced with
public placeholders before protocol control/permission handling.

Codex main turns, goal continuations, ephemeral side chats and subagent-preview
items use the same filter with the selected parent's live token set. Only the
agent-message delta field bypasses the RPC transport's per-frame literal mask,
because replacing it early would destroy cross-frame matching. Every consumer
of that field masks it before publication. Other structured RPC responses,
errors and tool events retain complete-payload masking. Named-account stderr
remains excluded from public logs. Cached child snapshots/history are scrubbed
again at their public boundary.

## Limits

This does not retroactively erase already emitted or previously stored secrets,
rewrite native CLI journals, or promise to identify arbitrary encodings or
unrecognized historical opaque credentials. It protects known account tokens
and the existing Anthropic token pattern at Relay output boundaries. Code in
the same native worker can use that worker's access token; refresh credentials
remain on the controller. Dedicated per-chat VM isolation is still required.

## Verification

Regression tests cover every two-part split and single-character streams,
overlapping/rotated credentials, multi-megabyte unrelated data, complete native
replays, content-block/message boundaries, success/error/stop/interruption,
native stdout/RPC subprocesses, tools/notices/debug output, ephemeral side
chats, child-agent snapshots and reconnect caches, and persisted chat/SSE
replay after a worker restart. All credentials and native processes in these
tests are synthetic; no model request, account import or browser consent is
performed by this verification.

On 2026-09-18 the feature branch passed **692/692** full backend tests (including
real local Chrome and PostgreSQL) and the final focused rerun passed **49/49**.
Independent review reproduced the generic-token saved-text, overlapping-token,
side-chat auth-mode and RPC early-masking cases; all have explicit regressions.
Final independent sign-off is tracked in the PR, not implied by these counts.
