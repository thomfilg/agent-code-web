# Native checkpoint recovery after a real controller process loss

This is a test-only follow-up to the [native writer + OCI proof](validation-2026-09-19-native-oci-recovery.md), whose controller only reopened PostgreSQL in the same process. It does not change production code, worker defaults, account scope, or deployment behavior.

## Proof boundary

`scripts/smoke-real-native-controller-loss.mjs` is the infrastructure supervisor. It owns a disposable PostgreSQL server, two isolated rootless OCI fixtures, a scripted private-loopback Responses provider and a durable counted-tool receipt. It never constructs a native RPC connection, captures a journal, or sends conversational state to the replacement controller.

Controller A and controller B are distinct Node subprocesses running `test/fixtures/native-oci-controller.mjs`. Each opens its own PostgreSQL pool, encrypted records, `ChatStore`, `NativeSessionCheckpoints` and native JSON-RPC client. Their environment is minimal and their host homes are fresh, private fixture directories. Only synthetic database credentials travel through private IPC; no real account/profile is read or imported.

The ordered acceptance assertions are:

1. A starts installed Codex **0.155.0** in the first OCI worker and runs one genuine native turn against a deterministic, worker-local Responses server. The CLI itself writes every rollout record. Its harmless native tool calls the fixture counter, whose receipt is appended and fsynced before returning the tool result.
2. A reads the completed native turn using `thread/read`, checks the actual returned assistant message, and persists that message. Production scoped capture and checkpoint service commit the real native journal to encrypted PostgreSQL. `turn-completed` capture requires the matching `event_msg/task_complete` record, not a fabricated completion marker.
3. Only after the successful checkpoint COMMIT does A return a receipt containing ID, hashes, revision and observed marker status. The supervisor sends **SIGKILL** to its exact child handle and confirms A's exit signal before continuing. A is not asked to close its RPC or database cleanly.
4. The first actual OCI runtime is killed/deleted and its writable bundle/rootfs removed. The supervisor asserts its old rootfs is absent. A different isolated OCI worker is created.
5. B starts in a new process/heap. Its initialization IPC contains only infrastructure, chat ID and the exact new worker descriptor; `restore` rejects extra payload fields. Native ID, messages and bundle come from B's freshly initialized store and checkpoint service, not the supervisor's receipt or A's objects. B restores into an empty private profile, reads identical bytes, then uses native `thread/resume` with the original ID and no replacement instructions or replayed prompt.
6. Read/resume produce no provider request or counted tool execution. An explicit continuation produces the third and final provider request, containing the original native instructions, user message, paired tool call/result and assistant answer. The original message/tool call appear once; the fsynced tool counter remains exactly **one**. Message and bundle hashes from B equal A's receipt.

The supervisor knows public fixture expectations solely to assert the actual outgoing model context. It does not supply those expectations as history during restore/resume. The existing private stdio bridge carries the deterministic provider response, not a history restoration shortcut. The replacement network namespace reuses the counted tool's loopback port so replay cannot hide behind a dead endpoint.

## Isolation and ownership

The fixture pins the previously signature-verified upstream **runc 1.5.1** SHA-256:

```text
177df879d50c913eb205e898d5c1c05a18f574053c0ce5524c471208eaf06f6f
```

Both workers must have distinct PID, mount, user and network namespaces from the supervisor/controller. There are no host bind mounts. Only loopback is enabled, and there are no routes. Only public executable/library files and fixture programs are copied. The separate-controller executor checks the private marker, owner, exact runtime ID/bundle/PID and namespace separation before each spawn. Cleanup remains with the original supervisor-owned worker handles; the executor cannot create or delete a worker.

The harness bounds itself at 90 seconds, with an 80-second emergency cutoff. It attempts each owned controller/container/database cleanup independently and retains evidence if cleanup cannot be confirmed. No real model service, authentication profile, GitHub write, cloud resource or production process is used.

## Execution receipt

2026-09-19: session `82506`, terminal exit **0**, **1/1 passed**, zero failures/skips/cancellations, **8.04 seconds** total (7.95 seconds for the case). Log: `/tmp/relay-native-controller-loss-v1.log`, a local fixture artifact rather than a production log. This was the first runtime attempt; no failed or hidden reruns preceded it.

- Controller A PID `2637301` returned its committed checkpoint receipt and then exited by confirmed **SIGKILL**. Controller B PID `2637720` opened an independent PostgreSQL pool and reconstructed the saved state.
- The original OCI runtime and writable rootfs were deleted. Another isolated container restored identical journal bytes and the exact native ID; message and bundle hashes matched across the actual process boundary.
- **Three** private-loopback Responses requests in total, **one** fsynced counted-tool execution, and **zero** implicit requests during read/resume. The explicit continuation retained original native instructions, user message, tool call/result and actual native assistant answer.
- The exact terminal marker was observed when the first completion notification arrived. No artificial marker, rewritten journal, retry workaround or production-code change was used.
- Owned controller/container/database cleanup completed. The two runc `container does not exist` diagnostics are expected checks that deleted runtime entries are absent, not ignored cleanup errors.

Independent read-only review accepted the scope/ownership/isolation assertions; the reviewer did not independently execute this smoke. Run only in the coordinated serial test lane:

```sh
RELAY_TEST_RUNC=/absolute/path/to/verified/runc \
CODEX_NATIVE_BINARY=/absolute/path/to/installed/native/codex \
taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 scripts/smoke-real-native-controller-loss.mjs
```

## Deliberate limits

Fixture client version is `relay_controller_loss_fixture/1.0.0`; the native executable is asserted to be Codex `0.155.0`. This drives direct native RPC with production checkpoint/storage/restore components. It is **not** the full RuntimeManager/service process, production account login, shared-controller failover, or cloud startup/revocation wiring.

The PostgreSQL infrastructure and deterministic provider supervisor survive; the actual controller process and original worker do not. This isolates recovery from a **completed, committed checkpoint**. It does not prove survival of an uncommitted/in-flight turn, child workflows, ambiguous external effects, machine power loss, or an unavailable database.

The [official app-server lifecycle](https://learn.chatgpt.com/docs/app-server#lifecycle-overview) separates `thread/resume` from `turn/start`; [stored-thread reads](https://learn.chatgpt.com/docs/app-server#read-a-stored-thread-without-resuming) expose turns without starting a turn. Neither page promises a filesystem fsync boundary. A journal marker observed at completion is an execution observation, not a general flush/zero-loss guarantee. Nothing here enables hibernation or declares the whole MVP complete.
