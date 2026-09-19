# Worker-owned process transport, local partition

This implements the reconnectable-process prerequisite from the September 19
process-preserving hibernation ADR. It is an **unwired library**, not a working
hibernation feature or a production worker/image acceptance receipt. Existing
SSH execution, adapters, controller shutdown and idle defaults are unchanged.

## API and authority

`WorkerProcessSupervisor` runs in a worker-owned service process, independent of
the controller client. Its constructor requires a private Unix `socketPath`, an
immutable `expectedIdentity`, and an external `authorize(request)` function.
Identity has exactly these fields: `deploymentId`, `ownerId`, `chatId`,
`workerId`, `provider`, `accountId`, `attemptId`. An instance serves one identity;
changing account/attempt requires the future coordinator's explicit reconciliation,
not relabeling this supervisor's children.

Wire protocol: `relay-worker-process/1`, bounded JSON lines. Every action carries
the exact identity and an opaque lease credential. The authorizer receives action,
identity, lease, process ID and process instance ID, and must consult current
admission (including company/account revocation). It returns
`{ id, generation, expiresAt }`; generation is a positive monotonic integer issued
by that authority, **never a client-supplied generation**. Expiry must be in the
next 60 seconds. Every request is reauthorized; errors are sanitized. A connection
expires without another accepted request, so the future coordinator must renew
via an authorized status request while attached.

An attachment replacement requires a strictly newer authoritative generation,
including reconnect after an accidental link loss. The old connection is fenced
before output is sent to the new one. A delayed old admission cannot take over.
Revocation must first deny future authorization and then call the trusted local
`supervisor.invalidateLease(id)` hook to immediately detach existing output; expiry
is the fail-closed upper bound when that notification cannot arrive. Neither
revocation nor expiry signals the child. Pausing or terminating a revoked child
is a separate future coordinator policy, **not established by this partition**.
Revoked IDs are retained through delayed authorizer completions; a 4096-ID bound
fails further admission closed instead of evicting a revocation tombstone.

The Unix parent must be owned by the service UID with mode 0700; the socket must
be owned by that UID with mode 0600. Symlinked parent paths are rejected. No
preexisting socket/file is removed or reused. This boundary does not defend
against a malicious process already running under the same UID, or root. A
worker service/image must isolate that UID and protect the authorizer/lease issuer.

`WorkerProcessTransport` is the controller-side client:

| Method | Contract |
| --- | --- |
| `connect()` | Validates private Unix endpoint; no child side effects. |
| `launch(processId, {command,args,cwd,env})` | Explicit detached child launch; exact spec retry returns original instance, never spawns twice. Environment is explicit, not inherited. |
| `inspect(processId)` | Gets existing process receipt after admission. |
| `attach(receipt, committedOutputSeq)` | Requires exact instance and newer reconnect lease; replays uncommitted output. |
| `writeInput(seq, Buffer)` | Monotonic input sequence, at most 16 KiB per write. No implicit replay. |
| `endInput(seq)` | Explicit, idempotent sequenced stdin EOF; never implied by socket close. |
| `ackOutput(seq)` | Caller promises all records through sequence have already been durably persisted. |
| `status()` | Reauthorized receipt, also renews lease expiry within authority limits. |
| `terminate()` | Explicit SIGTERM, then SIGKILL after 250 ms of the owned detached process group; confirms cleanup within 1.5 s or reports unconfirmed. Bypasses a stuck stdin write. |
| `disconnect()` | Closes only client transport; no EOF, process signal, output ACK, restart or replay. |

Receipts contain protocol, random supervisor/process instance UUIDs, logical
process ID, command PID, start time, separate group-anchor PID/kernel start ticks,
group cleanup status, input accepted-through, output produced/committed
cursors, bounded spool size, backpressure and process/exit status. PIDs alone are
not reconnect identity. The client verifies instance identity before accepting
output. A supervisor restart has a new UUID and cannot transparently attach to
old children or silently skip their output.

A small worker-owned Node anchor is the detached session/process-group leader.
The command runs inside that group. After command exit the anchor closes its
own inherited stdio but remains alive, pinning the group identity even while
background descendants still hold the pipes. Explicit termination sends TERM
to the group (the anchor ignores it), then KILL to the still-owned anchor/group.
Before each signal the supervisor synchronously checks the exact unreaped direct
child's PID, kernel start ticks, session and group; after anchor exit it never
signals that PID again. Unexpected anchor exit yields `GROUP_CLEANUP_UNCONFIRMED`,
not a potentially unsafe cleanup retry. Linux `/proc` confirms there are no live
group members after KILL; zombies are not running processes. This is Linux-only.
Descendants that explicitly leave the group/session are not contained here: a
future worker service cgroup must own those and handle supervisor crashes. That
integration remains an acceptance gate, not a claim made by this library.

## Delivery, bounds and failure semantics

Stdout and stderr enter a single sequenced stream in **observed** read order
(not a guarantee about kernel ordering between independent pipes). Exit is a
record after both streams close. The spool defaults to 1 MiB of raw output
payload per process (configurable 1 KiB–16 MiB), also capped at 4096 records.
Base64/frame and bounded Node/kernel pipe buffers add bounded overhead; this is
not a total resident-memory cap. Full spool stops reading child pipes, applying
backpressure without truncation or killing. Output is private in supervisor
memory, never logged or written to a shared disk.

Reading an event does not acknowledge it. The coordinator must atomically persist
each event and its sequence before ACK. An uncommitted event may repeat after
disconnect; the coordinator deduplicates by supervisor/process/sequence. A cursor
older than acknowledged retention fails `OUTPUT_CURSOR_EXPIRED`, not a silent
skip. A cursor never sent to a client fails. Socket backpressure stops pumping;
there is no unbounded secondary event queue.

Input uses a monotonic sequence shared by data and EOF. The supervisor reserves
sequence/hash before writing. Exact retries in the bounded recent hash window
(default 256) never write twice. Conflicting retries and retries older than the
window fail explicitly. A pipe error or still-pending callback returns
`INPUT_OUTCOME_UNKNOWN`, including on an exact retry, rather than asserting delivery.
After a pipe-error reservation, new input also remains blocked; a higher sequence
cannot silently move beyond that uncertainty. Explicit termination is still available.
Successful write acknowledgement means accepted by the OS pipe, not processed by
the agent. A lost connection/timeout is unknown, not permission to replay a prompt
under a new sequence. The client never reconnects or resends automatically.
Only one pipe write per process can be pending, including across attachment
generations; further new input fails `INPUT_BACKPRESSURE` without consuming its
sequence. Reconnecting cannot accumulate an unbounded private stdin queue.

Bounds also include 16 connections, 16 queued requests per connection, 256 KiB
frames, 3-second authorization timeout, 5-second initial admission timeout, and
16 process identities by default (maximum 128). Exited process identity tombstones
remain to prevent reuse; this partition does not implement journal compaction.
At most 16 underlying authorizations may be pending, even across disconnected
sockets whose authorizer failed to settle; timeouts do not release that bound.
`supervisor.close()` refuses live/unconfirmed groups and unacknowledged output. Service
shutdown/disposal policy is deliberately not implicit.

## What this does not prove

- Idempotence, output retention and child ownership last only for the **same
  supervisor's memory lifetime**. Supervisor crash/restart recovery is unsupported.
- Controller client process exit/restart is supported; whole-machine shutdown,
  reboot, or EC2 stop is not. Genuine hibernation must preserve supervisor RAM.
- There is no executable production daemon/service installation, network/SSH
  gateway, durable coordinator state, runtime/adapter wrapper, account capability
  reconciliation, deployment drain or wake integration here.
- No Chrome memory, OS hibernation, encrypted image, actual provider session or
  deployed worker acceptance has been run. The worker-image probe must obtain
  actual attach/ack/reconnect receipts after those integrations exist; marker
booleans and this local fixture are insufficient.

The tests launch only synthetic Node processes and a separate fixture supervisor.
They do not read browser profiles, real credentials, model endpoints or AWS.
