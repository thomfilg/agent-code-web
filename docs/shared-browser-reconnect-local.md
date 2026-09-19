# Shared browser link reconnection — local wired slice

This follows the worker-owned transport partition, but now has a real application
caller: `SharedBrowsers.ensure()` → `LocalExecutor.spawnBrowser()` →
`BrowserProcess.command()`. No default backend behavior, SSH transport, runtime
shutdown, idle policy or hibernation admission is enabled or replaced.

## Admission and dependencies

`createWorkerBackend({ browserTransport })` accepts this injected implementation
only for the local backend, with explicit synthetic-validation configuration.
There is no environment flag, UI option or HTTP endpoint for enabling it. The
injected `createLocalBrowserTransport({ openAttempt })` requires:

- An exact named, connected Codex/Claude account and immutable worker attempt
  supplied by `WorkerLeaseAuthority`. Anonymous or host-account fallback is not
  accepted. The local test account is a persisted synthetic record, not a real
  provider session.
- `openAttempt(chat)` returning `boundary: 'local-validation'`, exact seven-field
  identity, a trusted private Unix socket, durable claim, `issueLease()` and
  coordinator-owned `renewLease(id)`, records, and explicit owner `dispose()`.
- The narrow `workerTransportGet`/`workerTransportTransaction` encrypted CAS APIs.
  Scope/lease authority is separate from the output ledger, not a second SQL or
  credential store. The authority binds trusted boot, company, environment and
  account revisions; no browser input supplies those attestations.

Actual service installation and cgroup containment are **not** admitted. The
synthetic fixture owns its supervisor and disposable Chrome, and has explicit
fixture-only service-owner cleanup. Revoked production cleanup, descendants that
leave the process group, worker image support and authenticated remote tunneling
remain gates. No private real browser profile is reused, copied or changed.

## Link lifecycle

`BrowserProcess` survives a transport disconnect without closing its streams,
discarding its parser or calling stdin EOF. Outstanding browser requests are
rejected with an unknown-outcome message, not automatically replayed. A subsequent
normal `ensure`/`command` obtains a newer fenced lease, attaches the existing
process receipt and committed output cursor, resynchronizes status, and resumes
capture only when an actual viewer still needs it.

The worker receives periodic controller watch heartbeats. Losing the controller
stops screencasting after the bounded watch lease, without killing Chrome or
discarding the page. Reattachment alone does not re-enable capture: an explicit
watch command is required. There is no endless disconnected screenshot history.

The facade never presents a remote PID as a local child PID. Normal browser Stop
uses explicit `terminateRemote()`, distinct from link detach. It fences in-flight
reconnect/input, terminates the exact owned group, retains/acknowledges final
output, and only then disposes the attempt. Unknown mutating input does not prevent
explicit termination. Stop failure is not reported as successful cleanup.
In-flight startup remains owned until cleanup completes, including a failed
receipt commit followed by failed owner disposal. Its internal cleanup handle is
retained for explicit Stop retry; opening a replacement is blocked. If the group
and private ledger are already closed, retry resumes disposal without trying to
reconnect to a socket that has already closed.

## Private ledger and exact claims

The ledger stores the launch receipt, input intent/hash/sequence, output committed
cursor, and bounded raw output chunks awaiting projection. Command intent is
persisted before input; output chunks are persisted before acknowledgement.
Projected raw chunks are compacted, never retained as an unbounded history or
written into diagnostic logs. A logical command is bounded to 128 KiB; unprojected
output retention is bounded to 2 MiB.

If a mutating command's delivery is ambiguous, the pending intent remains marked
unknown. It is not replayed and subsequent commands are blocked pending explicit
Stop. Non-mutating status/watch-heartbeat uncertainty may reconcile its sequence
against the newly fenced supervisor receipt without repeating the old command.
This is conservative: it does not guess whether a click/evaluation succeeded.

**This slice proves connection-link recovery with the same controller process
alive, not controller restart recovery.** The same BrowserProcess/readline parser
retains partial JSON/UTF-8 and request identity through the detach. Reconstructing
a new controller/browser facade from the ledger is rejected, not silently treated
as resumed. Durable native Codex/Claude adapter state and restart recovery remain
separate prerequisites for full process-preserving rollout and hibernation.

Local integration tests exercise real disposable Chrome and PostgreSQL through
the normal caller path, including PID/page-memory continuity, expired capture,
stale/account-revoked leases, Stop during reconnect, mutating-input unknown
outcomes without replay, and actual Stop cleanup. Those tests do not establish
EC2 suspend/resume, remote latency or production acceptance.

## Local validation receipt — 2026-09-19

Baseline: application `37d98e2`, transport `962a671` (cherry-picked as `66a7895`),
and authority `f11d635` (cherry-picked as `d0cdd02`). Tests ran serially under
`taskset -c 0,1 nice -n 10`; all browser profiles were disposable test profiles,
the fixture website and PostgreSQL bound loopback, and the named provider account
was a synthetic encrypted record. No model, provider authentication, real GitHub
repository, EC2 or production control plane was used.

- `node --test --test-concurrency=1 test/reconnectable-browser.test.mjs`:
  **12 passed, zero skipped** (11 cases plus their parent), 13.1 seconds. Cases
  include same helper/Chrome PID and page memory after detach, real click once,
  expired screencast plus viewer resync, stale/revoked admission, unknown mutating
  input without replay, actual group cleanup, held-spawn and held-reconnect Stop,
  failed startup/disposal retry, and output retention failure during reconnect.
- Compatibility tests `shared-browser`, `browser-frames`, `browser-stream`,
  `browser-input`, `browser-resize`, `ec2-backend`, `ec2-guest-chrome`, and
  `parallel-worker-startup`: **73 passed, one existing optional official guest-MCP
  case skipped**. The regular shared-browser HTTP/WS/MCP cases used real local
  Chrome. These synthetic EC2 tests make no cloud calls.
- The first fixture run lacked the empty workspace normally supplied by
  RuntimeManager. A subsequent run exposed test-only `data:` URL rejection and a
  held-test-gate ordering error. The fixture now uses a loopback HTTP website and
  waits for the actual Stop marker. Only the positively identified disposable
  test runner/anchor were stopped after that gate timeout; no shared Chrome or
  saved profile was touched. The final run passed without retries or skips.
- Two compatibility files initially could not import the worktree's generated
  auth bundle. Running the repository's `npm run build:auth` satisfied that
  prerequisite; both files then passed (15 pass, one optional skip). This was
  a worktree setup failure, not accepted as a product pass.
- Independent read-only review accepted the final caller integration and its
  corrected lifecycle boundaries. The reviewer inspected source and all eleven
  cases; they did not independently rerun the suites.

Remaining acceptance gates are unchanged: independently owned supervisor service
and cgroup, trusted remote tunnel/image admission, service-owner cleanup after
scope revocation, controller restart reconstruction, native agent adapters, and
actual suspend/resume continuity. `hibernationAdmission` remains unavailable.
