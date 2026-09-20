# Durable worker lease authority

This supplies the durable admission prerequisite for `relay-worker-process/1`.
It is wired to the EC2 Shared Chrome coordinator and supports multiple independent
process leases in one worker attempt. It does not enable hibernation, change idle
defaults or yet connect the native-agent adapters; whole-machine acceptance remains
open.

## Authority and immutable binding

`WorkerLeaseAuthority` requires encrypted records, a fixed deployment ID, a
trusted synchronous `bootForWorker(identity)` lookup, a fixed non-empty process-ID
allowlist, and an `invalidateLease(id, processId)` hook. The coordinator must derive boot identity from its verified worker/endpoint,
never from a client frame. The hook must throw if notification cannot be confirmed.
The local supervisor's synchronous hook can be passed directly.

`prepare(identity)` reads persisted admission records, not `ChatStore` or account
metadata caches. The seven wire identity fields are deployment, owner, chat,
worker, provider, selected named account and attempt. Owners must be explicit;
only connected named Codex/Claude accounts qualify. There is no anonymous,
host-credential, other-account or cross-owner namespace fallback.

The resulting schema-2 binding includes boot hash, the exact sorted process-ID
allowlist, one registered company, one compatible environment,
account/company/environment revisions, and a hash of admission
fields including selected repositories and account identity. Ordinary message
revision changes do not invalidate it. Scope changes, archived/deleting/stopping
chats, unresolved environments, disconnected accounts and even a present pending
disconnection marker deny admission. Current scope is rechecked for every action.
The trusted `legacyOwnerId` option names only the existing explicit legacy owner;
otherwise company/environment records use `user:<ownerId>:<kind>`.

`prepare` is not a grant. `claim` atomically rechecks the full persisted snapshot.

## Coordinator API

- `claim(binding, controllerId, {expectedRevision: 0})`: create an attempt once.
- `takeover(binding, newControllerId, {expectedRevision})`: explicit CAS handoff;
  it advances controller epoch and invalidates every process lease. No automatic takeover
  occurs in `issue`, reconnect requests or authorization.
- `issue(binding, controllerId, processId)`: only the held controller claim can issue.
  A new
  generation and SHA-256 credential hash commit before an opaque 256-bit credential
  is returned. The credential itself is never stored. Results contain
  `{id, generation, expiresAt, credential, processId, claim}`; only the transport receives
  the credential, never public chat/settings events.
- `renew(binding, controllerId, leaseId, processId)`: trusted coordinator-only, current-scope
  checked CAS. It extends an unexpired deadline without changing token, ID or
  generation. An expired lease is not revived. Worker `status`/other requests
  never renew themselves; the coordinator renews before requesting status.
- `authorize(request)`: the existing supervisor request shape; returns only
  `{id, generation, expiresAt}`. Invalid credentials, database errors, stale
  bindings or revoked scope fail closed. A raced renewal may cause at most three
  read-only CAS attempts; each reloads and revalidates everything. Mutating lease
  issuance, takeover, browser input and tool operations are never auto-replayed.
- `revoke(binding, leaseId?)`: persist an attempt-wide revoked tombstone, then
  notify the supervisor for every process lease. It remains available after account
  deletion or boot replacement.
- `forAttempt(binding, controllerId, processId)`: process-scoped facade with `issue()`, `renew(id)`,
  `authorize(request)` and `revoke(id)` for the browser transport slice.

When a binding contains exactly one process, the process argument may be omitted
for the existing browser coordinator. With multiple processes it is mandatory.
Issuing or renewing one process never replaces another process's lease. Generation
remains monotonic across the attempt, so generations for an individual process may
legitimately skip. Controller takeover and attempt revocation remain whole-attempt
operations and fence all processes in deterministic allowlist order.

Claims are `{attemptId, controllerId, controllerEpoch, revision}`. `attemptId`
here is a SHA-256 database key bound to deployment/owner/chat/wire-attempt, not
the wire attempt identifier. Generation and tombstones persist across controller
and PostgreSQL restarts. Restarted controllers cannot restore an in-memory claim
merely by supplying the previous controller ID; they need an explicit takeover.

Leases have a stored UTC deadline of at most 60 seconds (default 30 seconds),
using PostgreSQL time when persisted. The controller also checks the deadline
before returning it; delayed commit/notification never extends validity. Clock
agreement with the worker must be established by future deployment admission.

## Narrow atomic storage contracts

`relay_worker_state` stores encrypted, versioned `attempt` and `transport` rows,
separate from ordinary unconditional `relay_records` updates. Cipher AAD includes
kind and key. No API exists here to delete/reuse attempt tombstones.

`workerAttemptTransaction({attemptId, expectedRevision, scope}, transition)`
checks revision and persisted scope in one transaction. Its synchronous callback
receives `{revision, value, records, now}`. It can return only the next attempt
value (whose binding cannot change), or `undefined` for a read-only result.
Thenables are rejected; callbacks must contain no I/O. Results are returned only
after COMMIT. An uncertain commit response returns no credential.

The fixed scope descriptor can name only:

- `chat/<chatId>`;
- `agent-account/<accountId>` and `agent-account-disconnection/<accountId>`;
- the exact owner namespace's `company/<companyId>` and
  `environment/<environmentId>`.

It is constructed by the trusted coordinator, never accepted over HTTP/wire.
All participating key locks have one lexicographic acquisition order. Ordinary
`put`/`delete` for exactly those kinds obtain the same per-key transaction locks.
This includes absent keys: inserting a previously absent disconnection marker
serializes against admission. There is no global database/controller lock.
Privileged raw SQL maintenance remains an explicitly offline operation.

Existing offline maintenance that injects an already transactional `pg.Client`
keeps control of its transaction: ordinary record writes acquire key locks but
never commit it. Lease/ledger APIs reject that configuration because they cannot
own the commit boundary. `MemoryRecords` implements equivalent serialized CAS
for deterministic fixtures; it is not a PostgreSQL failure fallback.

The browser slice owns receipt/input/output ledger semantics and bounds. Its
separate storage API is:

```js
const request = { attemptId, processId, controllerId, controllerEpoch };
await records.workerTransportGet(request); // { revision: 0, value: null } initially
await records.workerTransportTransaction(
  { ...request, expectedRevision },
  ({ revision, value }) => nextPrivateLedger,
); // { revision: expectedRevision + 1, value }, only after COMMIT
```

Read/write checks an active attempt, exact controller epoch, allowed process,
non-pending invalidation and that process's live lease under the same locks as the ledger CAS.
Frames do not churn the lease row's revision. The ledger callback is synchronous;
this primitive does not send input, ACK output or project messages. Those steps
must occur in the browser/transport coordinator after the relevant commit.

## Revocation linearization and explicit limits

Authorization linearizes at its committed read transaction. A revocation that
commits afterward cannot retroactively retract the returned decision. The required
sequence is durable denial followed by `supervisor.invalidateLease(id, processId)`, whose
tombstone rejects already-approved but delayed results and closes attached output.
This is not a claim of atomicity across the database and a remote worker.

Pending invalidation is persisted. If notification or its clearing write fails,
new issuance, authorization and ledger access remain denied until explicit
recovery/revocation. If all storage writes fail, a durable revocation cannot be
promised: further authorization reads must succeed and revalidate scope, while an
already attached supervisor lease expires within its existing <=60-second window.
The coordinator must surface the failure, never report revocation complete.

Revoked authority denies **all** actions, including `terminate`. Revocation is not
a cleanup capability. Production needs a separately privileged service-owned
cleanup path for the exact process/cgroup, without regranting account/company
access. Local synthetic fixture cleanup is not that production proof. Stop,
deletion, account-scope mutation, leader selection, automatic takeover and remote
notification still require explicit coordinator wiring and acceptance.

## Validation scope

Local tests use synthetic named accounts and generated fixture database secrets,
never provider credentials or saved profiles. They cover real PostgreSQL CAS,
independent controller subprocesses, database/controller restart, encrypted rows,
absent-marker ordering, durable tombstones, ledger rollback, outer maintenance
transaction preservation and a deferred constraint failure at actual COMMIT.
Memory tests additionally gate renew races, simulate a lost commit response and
prove that a failed `ChatStore` write cannot grant the account visible only in its
advanced cache. No AWS, cloud worker, provider CLI, real model or deployment is
used. Product hibernation and process-preserving deployment remain unaccepted.

### Local validation receipt (2026-09-19)

- Focused authority/PostgreSQL run after schema-2 process isolation: **18/18
  passed**, no skips, including the final deferred-COMMIT failure case and a
  two-process rotation/takeover/revocation case.
- Compatibility run before that additional test: **66/66 passed**, no skips,
  across authority, PostgreSQL, settings, agent accounts/API, company migration
  and worker-process transport. Production source was unchanged between runs;
  these overlapping counts are not cumulative full-suite coverage.
- An initial compatibility run exposed a fresh-worktree generated-auth prerequisite
  and the existing migration caller's externally owned PostgreSQL transaction.
  Building auth with the repository script and preserving that transaction fixed
  both; a real PostgreSQL rollback regression now covers the latter.
- Independent read-only review accepted the scoped source, tests and documented
  limits. It did not independently rerun the suites. No cloud or live acceptance
  was performed.
