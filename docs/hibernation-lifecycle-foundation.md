# Hibernation lifecycle foundation (partition 1)

This is **not working hibernation**. Process-preserving transport, resume/account
revalidation, admitted-image evidence and disposable live acceptance are still
required. No production setting or worker was changed or tested by this patch.

## Requested policy versus availability

The user's chosen end state remains hibernation after two minutes of inactivity
and full stop only on explicit action. Restarting processes is not a substitute.

`AGENT_IDLE_POLICY=hibernate` records an explicit opt-in policy and defaults its
idle threshold to 120,000 ms. It does **not** enable hibernation. Admission is
currently denied before repository credentials, worker creation/start, SSH or
agent startup. The current backend, SSH process transport and image verifier do
not provide the complete support required by `src/worker-suspension.mjs`.
An EC2 `HibernationOptions` field or a backend method named `hibernate` is not
sufficient evidence. Do not enable the integration flag as a rollout step yet.

The shipped default remains `AGENT_IDLE_POLICY=stop`, retaining existing behavior
and billing until the remaining partitions are accepted. Local workers retain
their existing idle behavior; opting local workers into hibernation is rejected.

For a cached/warmed worker with the opt-in policy, every idle-timeout path exits
before destructive Stop. It persists an unavailable diagnostic, clears the idle
deadline and leaves the runtime/processes alone. There is no polling retry loop;
new activity can schedule another idle check, and an explicit wake can retry
admission. Diagnostic storage failure does not trigger fatal teardown. Manual
Stop and security revocation cleanup remain separate and available. This is not
a claim that deploy, shutdown, browser lifecycle or controller restart currently
preserves processes: those require the subsequent transport/lifecycle partitions.

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

## Acceptance boundary

Deterministic tests cover unsupported admission without mutations, untouched
pre-existing workers, no idle fallback even on persistence failure, manual Stop,
late cancellation cleanup, exact-instance receipt ownership and idempotence.
These are fake-backend/local tests only. No AWS, provider, real model, browser
profile or credential operation is part of this acceptance.

Validation on this partition: 63/63 tests passed (12 new cases), no skips or
retries, across the five files below. Syntax checks and `git diff --check` also
passed. Existing local/mock autosleep, explicit Stop, parallel startup and late
preview acquisition regressions remain covered.

```sh
taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 \
  test/hibernation-lifecycle.test.mjs test/ec2-backend.test.mjs \
  test/parallel-worker-startup.test.mjs test/runtime-manager.test.mjs \
  test/preview-activity.test.mjs
```

Next: implement reconnectable worker-owned transport and jointly reviewed
suspend/resume coordination; revalidate named-account ownership/revocation before
restoring any capability; implement compatible image/watchdog admission; then
perform separately coordinated disposable-instance process continuity acceptance.
Only after those pass may the availability boundary and deployment policy change.
