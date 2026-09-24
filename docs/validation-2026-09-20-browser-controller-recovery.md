# Shared Chrome new-controller recovery validation — 2026-09-20

## Scope

This receipt records the first explicitly injected local validation transport.
It does not enable hibernation or claim an AWS image. A later increment now adds
the production-candidate worker service, SSH bridge and tagged-image EC2 Shared
Chrome wiring; see the
[EC2 supervisor candidate receipt](validation-2026-09-20-ec2-worker-supervisor.md).

A fresh `SharedBrowsers` and `BrowserProcess` facade can now adopt the exact
retained browser helper only after an explicit durable controller takeover. The
new generation inspects and matches the persisted deployment/owner/chat/worker/
provider/account/attempt identity plus supervisor instance, process instance,
PID/start time and group anchor. It attaches at the durable output cursor and
uses a new read-only `status` command to initialize the facade. It does not
launch another helper or Chrome process and does not replay an earlier command.

The encrypted transport ledger is now schema 2. In addition to byte-delivery
intent, it persists bounded logical browser RPCs until their response is
acknowledged by `BrowserProcess`. This closes the interval in which stdin had
accepted a mutating command but its browser response was still pending. A fresh
controller refuses adoption when any mutating RPC has an unknown result. The
existing exact owner cleanup remains reachable through explicit Stop; failure
does not terminate or replace the retained process implicitly.

## Evidence

Focused real-browser run:

```sh
taskset -c 0,1 nice -n 10 node --test test/reconnectable-browser.test.mjs
```

Result: **14/14 passed**, zero failures, cancellations or skips. The new positive
case creates a fresh authority/controller lifetime and fresh application facades
against the same encrypted database and worker-owned supervisor. It verifies the
same helper PID, same Chrome PID, same renderer JavaScript sentinel, exactly one
process and one subsequent mutation. The new negative case loses a mutating RPC
acknowledgement, verifies the durable pending mutation, refuses takeover without
advancing worker input or ending the process, and then confirms explicit Stop
cleans the exact process group.

Neighbour regression run:

```sh
taskset -c 0,1 nice -n 10 node --test \
  test/reconnectable-browser.test.mjs test/shared-browser.test.mjs \
  test/worker-process-transport.test.mjs test/worker-lease-authority.test.mjs \
  test/worker-lease-postgres.test.mjs test/hibernation-lifecycle.test.mjs \
  test/worker-hibernation.test.mjs test/runtime-manager.test.mjs
```

Result: **73/73 passed**, zero failures, cancellations or skips. This includes
real disposable Chrome, loopback HTTP/WebSocket/MCP, real PostgreSQL restart/CAS,
actual controller-client process exit for the standalone supervisor transport,
lease takeover/revocation, backpressure/no-replay and lifecycle failure paths.

Full Node regression after the final implementation and test-race correction:

```sh
taskset -c 0,1 nice -n 10 npm test
```

Result: **1,611/1,611 passed**, zero failures or cancellations, with four
documented optional skips (**1,615 total**) in **549.3 seconds**. The run includes
the real-browser recovery cases under full-suite load as well as the guest
browser projection and official MCP regressions.

No real provider/model prompt, user browser profile, GitHub mutation, AWS request,
production restart or deployment occurred.

## Remaining limits

- This receipt's real-Chrome evidence still uses the local injected boundary.
  The follow-on component tests wire the EC2 executor to an independent worker
  daemon and fixed SSH bridge, but an actual AWS guest has not run that path.
- This slice covers Shared Chrome. Node development servers, Codex, Claude and
  their durable native RPC/session reconstruction remain open.
- Durable output already committed but not projected is refused rather than
  guessed. Explicit reconciliation/projection semantics are still required.
- Hibernation admission, the two-minute state machine, image/watchdog promotion
  and scoped live suspend/resume evidence remain unavailable.
