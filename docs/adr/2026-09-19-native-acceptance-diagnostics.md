# ADR: bounded native acceptance diagnostics

Status: implemented with offline regressions; no AWS or provider run performed
for this change.

The native EC2 operator previously collapsed an expired source credential,
transport failure, failed image audit, provider denial, native turn failure and
cleanup failure into one message. That prevented choosing the correct next step
without repeating a disposable-worker acceptance.

The operator now reports only fixed stage/category enums and strict boolean
cleanup flags. It never prints exception messages, causes, stack traces, arbitrary
paths, timestamps/remaining token lifetime, account IDs, access/refresh tokens,
provider bodies, native output, or AWS/SSH stderr. Unknown exceptions become a
fixed `failed` category at the current fixed stage. JSON decoding failures have
a fixed category, without including parser excerpts.

Source access has separate `source-schema`, `source-scope`,
`source-file-permissions`, `source-file-unavailable`, `source-access-expired` and
`source-access-too-short` categories. The ten-minute minimum, no-refresh rule,
private-file guards, in-memory source hash check and access-only transfer are
unchanged. An expired source requires the user's ordinary account refresh/login;
this operator does not renew or restore their personal credential.

The standalone worker remains a single self-contained source sent through the
existing private SSH stdin protocol. A handled failure emits a small JSON
envelope containing only schema, failed=true, validated run UUID/action and
allowlisted diagnostics. Its exit code 0 means the protocol response was
delivered, **not that acceptance passed**. The SSH caller validates schema, exact
run ID and exact requested action before converting the envelope into a safe
error. Unknown enums or non-boolean flags are rejected as an invalid receipt;
additional fields are never propagated. The outer operator still exits nonzero
on any failure. Non-protocol SSH/process failures remain suppressed, at the
fixed outer stage.

Worker phases distinguish audit/version/access/profile, identity-before,
first-turn/first-result, resume-turn/resume-result, identity-after and cleanup.
Provider profile HTTP 401/403, 429 and other non-success replies map to three
fixed categories without reading their bodies. Native commands expose only
failed/timeout/aborted categories, never provider messages. The acceptance
criteria and maximum two bounded Haiku turns are unchanged.

Primary failure is preserved when cleanup also fails. Separate paired flags
report profileCleanupAttempted/profileCleanupConfirmed,
sourceCheckAttempted/sourceUnchanged, sessionCloseAttempted/sessionClosed and
localCleanupAttempted/localCleanupConfirmed. A false result with attempted=false
means **not checked**, not an assertion that something changed. Failed cleanup
does not conceal the original turn or source failure. A valid success receipt
is required before skipping recovery cleanup; an unvalidated cleanedUp field
cannot suppress it. Exact instance retirement remains mandatory after every
native run, even when profile/session cleanup is confirmed.

Tests cover expired/short-lived/schema/scope/permission source fixtures,
redaction, foreign/malformed remote identities and flag types, malformed result
JSON, identity denial/rate limit, primary failure plus simultaneous cleanup/source
failures, a tampered remote ownership marker, failed SSM startup cleanup, and an
actual standalone worker protocol failure that makes no external calls. They do
not establish live provider authentication or AWS acceptance.

Validation: 24 native acceptance tests and 6 existing SSH launcher tests passed;
the zero-call default plan and syntax checks also passed. All execution stayed
on CPU 0,1 and used only disposable local fixtures.
