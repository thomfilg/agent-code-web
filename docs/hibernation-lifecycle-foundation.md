# Hibernation lifecycle and activation boundary

The source now implements the process-preserving EC2 lifecycle, reconnectable
native/Chrome transports, exact capability restoration after scope
revalidation, manual retained-process cleanup, and dedicated image acceptance
operator. The default remains `stop`, and no production setting or worker is
changed by source integration alone. A real disposable AWS acceptance and
separately coordinated activation are still required before the MVP can claim
live hibernation.

## Requested policy versus availability

The user's chosen end state remains hibernation after two minutes of inactivity
and full stop only on explicit action. Restarting processes is not a substitute.

`AGENT_IDLE_POLICY=hibernate` is an explicit opt-in and defaults its idle
threshold to 120,000 ms. Admission requires all three independent signals:
configured EC2 hibernation, the pinned reconnectable supervisor version, and
the dedicated candidate-image acceptance marker. Missing or revoked evidence
fails before agent admission and never downgrades the idle action to full Stop.
An EC2 `HibernationOptions` field or a backend method named `hibernate` alone is
not sufficient evidence. Do not enable the integration flag before live
acceptance.

The shipped default remains `AGENT_IDLE_POLICY=stop`, retaining existing behavior
and billing until the remaining partitions are accepted. Local workers retain
their existing idle behavior; opting local workers into hibernation is rejected.

For an admitted worker, every automatic idle path checkpoints quiescent native
and browser transports, saves capability continuity only in private encrypted
controller records, revokes controller-side grants, and hibernates the exact VM.
Wake resumes the same worker/process receipts without sending a prompt. Changed
account credentials, company/repository/environment scope, MCP/GitHub identity,
or missing private checkpoints fail closed and require explicit Stop. Manual
Stop wakes only to terminate retained native/browser owners and then stops the
worker; Delete retains its destructive semantics.

For an unaccepted worker, idle hibernation persists an unavailable diagnostic,
clears the deadline and leaves the runtime/processes alone. There is no hot retry
loop and no automatic full-stop fallback. Diagnostic storage failure does not
trigger fatal teardown.

## Attempt-owned acquisition rollback

`Ec2Backend.acquire(chat, options)` retains its executor return contract. Its
optional `onMutation({instanceId, release})` callback publishes cleanup authority
only when this acquisition creates a worker or starts an existing stopped one.
Starting registers its exact target before awaiting the AWS request, so ambiguous
request failure remains conservatively cleanable. Creation registers a validated
returned ID before subsequent admission, SSH or workspace awaits can fail.

`release()` is idempotent after success, joins concurrent callers, allows retry
after failure, and revalidates the original instance's deployment/chat isolation
before stopping that exact ID. It never uses a new chat-tag lookup to choose a
replacement target. The returned executor also exposes `releaseAcquisition()` for
later software/adapter startup failures. For a pre-existing running worker, this
is a no-op: a rejected admission cannot acquire authority to stop unrelated live
processes. The acquisition error path retains failed-cleanup leases for an
explicit Stop retry.

The manager drains parallel clone/acquire branches before invoking a receipt, so
a late successful launch after cancellation is not abandoned. Explicit Stop may
still stop a pre-existing worker: it is a separate user/security lifecycle action,
not automatic rollback of an unperformed mutation.

Limits: an AWS launch that commits but yields no recoverable instance ID still
requires external reconciliation; this change does not invent a safe target from
an ambiguous response. EC2 custom backends must publish receipts for mutations
they want the manager to roll back. Direct backend callers retain responsibility
for deciding when to invoke the receipt on failure.

## Current acceptance boundary

Deterministic tests cover unsupported admission without mutation; exact worker,
kernel and process receipts; same/fresh-controller reconnection; no prompt/RPC
replay; encrypted private capability checkpoints; MCP/GitHub/Browser/provider
token restoration; changed account/environment denial; manual retained-process
Stop; watchdog policy; and the dedicated hibernation verifier's cleanup/tagging
rules. The complete local suite must remain green on the final commit.

Local evidence is not AWS evidence. Remaining activation work is to authenticate
the scoped operator profile, resolve and verify the current regional Canonical
Ubuntu 22.04 base selected by the candidate-only baker, bake a fresh candidate, run
`verify-worker-hibernation.mjs`, exercise the application through
real hibernate/resume and controller replacement without paid prompts or user
profiles, then publish the accepted AMI/config through the normal reviewed
deployment path. Until those steps pass, production stays on `stop`.
