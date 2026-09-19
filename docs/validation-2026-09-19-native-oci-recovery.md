# Genuine native-writer + disposable OCI recovery receipt

This closes the gap between the separate native-writer observation (PR #70) and synthetic-native/real-container proof (PR #71). It is a **completed-checkpoint local acceptance**, not a production deployment or a declaration that all MVP/worker-loss cases are finished.

## What actually ran

`scripts/smoke-real-native-oci-recovery.mjs` launched installed **Codex 0.155.0** inside a disposable rootless OCI container. Only public executable files/libraries and two test fixture programs were copied into its writable rootfs. No account credentials, authentication profile, host settings, host home mounts, cloud workers or external model services were used. Synthetic owner/company/environment/named-account records supplied the production checkpoint service's authorization scope, not CLI authentication.

The runtime was the separately signature-verified upstream **runc 1.5.1** executable. The harness pins its SHA-256:

```text
177df879d50c913eb205e898d5c1c05a18f574053c0ce5524c471208eaf06f6f
```

Each container's PID, mount, user and network namespace identities were checked against the controller and required to differ. The OCI spec contained no host bind mounts. Network setup entered only the exact owned, running container's user/network namespaces to enable loopback; the fixture asserted `lo` was the only interface and there were no routes. The Responses server ran **inside each worker**, connected to the controller's deterministic response fixture through owned stdio, not a controller TCP listener. The bridge bounds request bytes, in-flight requests and response deadlines. Child processes receive a minimal explicit environment.

The native CLI performed one genuine turn: original user instruction, developer instruction, advertised native shell tool, actual tool result and scripted assistant answer. Every rollout byte was written by the native CLI. The harmless tool called a private loopback counter endpoint; the controller appended and fsynced an execution receipt before allowing the tool response. The replacement container reused the same loopback port and script path so replay could not be hidden by an obsolete endpoint.

The controller used production `workerSessionIO` scoped reads, `captureSessionBundle`, and `NativeSessionCheckpoints.save` against a real encrypted embedded PostgreSQL database. A `turn-completed` save required the actual `task_complete` journal record for that exact native turn. Then, **without first stopping the native CLI gracefully**, the fixture killed/deleted the actual OCI container, removed its writable bundle/rootfs, and asserted the old rootfs was absent. The saved message IDs/bytes and native bundle remained on the controller.

After PostgreSQL close/reopen, a different container with a fresh private Codex home restored the exact bundle through production `restoreFresh` worker I/O. Native `thread/resume` returned the original ID; read/resume issued no provider request. An explicitly requested continuation supplied the original user/developer instructions, paired native tool call/result and previous assistant answer to the local model fixture. The original user message and tool call were not duplicated. The independently recorded tool count remained **exactly one**, including after continuation.

This harness drives the genuine CLI's JSON-RPC connection directly while using the production capture/storage/restore components; it is **not** a full RuntimeManager/provider-account startup simulation. PR #71 separately exercised the production adapter lifecycle using a synthetic native CLI. PostgreSQL was reopened, but the controller process itself was not killed/restarted in this combined test.

## Exact execution receipt

2026-09-19: final session `58729`, terminal exit **0**, **1/1 passed**, zero skipped/cancelled, **6.76 seconds** total. Log: `/tmp/relay-native-oci-writer-v2.log` (local validation artifact, not a production log).

- Two real isolated OCI containers; first runtime entry and writable rootfs deleted.
- Real PostgreSQL reopen; saved message IDs/bytes and native bundle unchanged.
- **Three** private-loopback Responses requests: tool selection, original answer, explicit continuation.
- **One** fsynced counted tool execution; no implicit resume request or repeated counted action.
- Exact native terminal marker present when the first `turn/completed` notification was received; no production retry change or fabricated terminal receipt.
- All independently owned cleanup paths attempted; unclear cleanup retains fixture evidence rather than deleting it as if successful.

The initial run (`10601`, exit 1 in 1.67 seconds) failed before launching Codex because `nsenter` attempted `setgroups`, which the rootless mapping correctly denied. The fixture now uses `--preserve-credentials` to retain the caller's mapped identity while entering only the verified container namespaces. No isolation assertion was removed and host networking was not enabled. The final successful log includes expected runc “container does not exist” diagnostics while verifying that deleted runtime entries are absent.

Run serially in the shared test lane, with explicit verified executable paths:

```sh
RELAY_TEST_RUNC=/absolute/path/to/verified/runc \
CODEX_NATIVE_BINARY=/absolute/path/to/installed/native/codex \
taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 scripts/smoke-real-native-oci-recovery.mjs
```

## What remains outside this receipt

The [official app-server lifecycle](https://learn.chatgpt.com/docs/app-server#lifecycle-overview) defines completion notifications, not a filesystem flush/fsync contract. This test observes one completed, committed native checkpoint. It does not promise zero loss for an abruptly interrupted/unflushed turn, power failure, independent child threads/workflows, ambiguous in-flight external side effects, cloud VM/SSH loss, or every supported native version. Account revocation and durable authority races retain their separate service/integration tests; this fixture does not consume a production account to exercise them.

Nothing was deployed, no live worker was interrupted, and no hibernation/default policy was enabled.
