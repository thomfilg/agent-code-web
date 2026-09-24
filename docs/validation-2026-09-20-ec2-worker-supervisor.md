# EC2 worker-owned browser and native-agent supervisor candidate — 2026-09-20

## Scope

This increment replaces the EC2 Shared Chrome and persistent native-agent
processes' controller-owned SSH lifetime with a worker-owned supervisor
candidate. It does not enable automatic hibernation and is not an AWS image or
deployment acceptance receipt.

Images baked from this source advertise `AgentRelaySupervisor=v3`. Only an
already accepted image with that exact tag enters the new path. The controller
then verifies and, when necessary, installs an independent systemd user service,
checks its protocol/version, hashes the worker boot ID and constructs a durable
remote attempt coordinator. Untagged older images retain the previous execution
path.

The service owns private 0700/0600 runtime sockets and one exact deployment,
owner, chat, worker, provider, account and attempt identity. Schema-2 short-lived
lease credentials are isolated by process and hashed in daemon memory; rotating
the browser lease cannot fence a native-agent lease. Controller takeover and
revocation still invalidate all process leases. Controller SSH connections are
disposable byte bridges; disconnecting one does not close stdin or signal the
process. A new controller must take over the durable PostgreSQL authority,
revalidate current company/environment/account scope and obtain a newer lease
before attachment. No credential or identity appears in SSH arguments.

Explicit Stop terminates the exact receipt's process group, drains and
acknowledges retained output and releases that exact process slot. Stopping and
reopening Chrome does not terminate or fence the native agent; the daemon resets
only after its last retained process is released.
If recovery is refused because a mutating RPC has an unknown outcome, the error
retains this exact Stop operation; it does not launch or infer a replacement.

## Source

- `src/worker-supervisor-daemon.mjs` and service/CLI/path helpers
- `src/worker-supervisor-bridge.mjs` and `src/ssh-worker-process-transport.mjs`
- `src/remote-browser-attempt.mjs`
- `src/reconnectable-browser-process.mjs`
- `src/reconnectable-agent-process.mjs`
- `src/worker-backends.mjs`
- `src/adapters/codex.mjs` and `src/adapters/claude.mjs`
- `deploy/aws/worker-cloud-init.yaml` and `deploy/aws/bake-worker-ami.mjs`

The systemd unit uses `KillMode=control-group`, `NoNewPrivileges=yes`, a 0700
runtime directory and a restrictive umask. Cloud-init enables linger for the
dedicated `agent` user. A duplicate daemon refuses to remove live socket paths.

## Evidence

Focused integration:

```sh
node --test test/remote-browser-attempt.test.mjs
```

Result: **3/3 passed**. The cases prove:

1. a replacement coordinator/facade retains the same PID, in-memory sentinel,
   browser counter and single supervisor process;
2. an unresolved mutating RPC refuses recovery while preserving the exact
   process, and the supplied cleanup operation terminates it and resets the
   daemon;
3. two actual `Ec2Executor` instances representing different controllers use
   the fixed SSH bridge and recover the same worker-owned process, then normal
   Stop performs confirmed cleanup.

The original broader transport/daemon/reconnectable/EC2/AMI focused run passed **96/96**.
An additional first-boot regression then exercised the inactive-service path:
it streamed the explicit source-file allowlist, installed/enabled the systemd
user unit, verified daemon status and produced a ready executor (**27/27** in the
final EC2 backend file).

The process-scoped lease follow-up passed **91/91** focused authority,
PostgreSQL, transport, daemon, reconnectable-browser, EC2 and AMI tests. Its
two-process case proves browser rotation preserves native authorization, while
takeover and revocation fence both. This is contract acceptance only; native
adapters are not wired by that test.

The native-agent follow-up wires Codex app-server and persistent Claude SDK
owners to the retained process slot while leaving one-shot Claude turns and
transient Codex plugin commands ordinary. Its combined local test launches a
native process, its background Node descendant and Shared Chrome under the same
attempt. Agent and descendant PIDs, sentinels and counters survive link loss;
Chrome can stop, release and reopen twice without replacing the native process;
final explicit native Stop confirms whole-group cleanup and daemon reset. Exact
process release also recovers after a simulated lost invalidation acknowledgement.
The focused worker, authority, adapter and session batch passed **226/226**.

Final complete Node regression after the native-agent follow-up:

```sh
taskset -c 0,1 nice -n 10 npm test
```

Result: **1,623 passed**, zero failures or cancellations, with four documented
optional skips (**1,627 total**), exit code 0, in 385.0 seconds. The immediately
preceding complete run encountered one unrelated embedded-PostgreSQL connection
termination while another test was shutting its fixture down. The exact
GitHub/database file passed unchanged in three isolated repetitions, and the
complete green rerun passed that case. No assertion or timeout was weakened.

## Remaining gates

- Bake and verify a disposable tagged AMI, then exercise the service and cgroup
  on the real guest. The current AWS operator session is expired.
- Persist enough native session/transport ledger to reconstruct Codex and Claude
  after an actual control-plane process death. Current evidence covers retained
  same-controller link recovery and a background Node descendant, not a new
  controller facade.
- Wire and test the 120-second idle state machine, resume UI, watchdog and
  suspend/resume authorization races.
- Prove actual controller-process death, EC2 hibernation/resume, repeated cycles,
  revocation, Stop/Delete and rollback using isolated cloud resources.
- Do not enable `AGENT_IDLE_POLICY=hibernate` until those gates pass.
