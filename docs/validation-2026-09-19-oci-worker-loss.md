# Actual OCI worker deletion — 2026-09-19

This receipt closes the **actual disposable-container deletion** test gap for
controller message storage and synthetic native journal restoration. It does
not close all of feature 41. The container and database are real; the native
provider in this harness is explicitly a test executable, not installed Codex.

## Isolation and operation

`scripts/smoke-oci-worker-loss.mjs` runs the production Codex adapter and native
checkpoint service against a real, rootless OCI worker. Its filesystem contains
copies of public Node/system executables and two pure fixture files only. No
host directory is mounted, no account credential/profile is imported, and
network, PID, mount and user namespaces are checked against the controller's
actual kernel namespace IDs. The network namespace has no configured route.

The real PostgreSQL database remains outside the disposable worker. The harness
stores a user message and the adapter's assistant response through ChatStore,
then verifies a terminal native checkpoint. It kills the running OCI container
without stopping the adapter first, deletes its runtime entry and writable
bundle, and asserts that the old filesystem no longer exists. It reopens the
database, checks exact message IDs/content, creates a different container and
restores the same native journal bytes and thread ID through the production
adapter. No `thread/start` or `turn/start` is invoked during that restoration.

Cleanup identifies the exact generated container/bundle and private owner marker
before deletion, independently attempts all owned process/database cleanups,
and retains evidence if cleanup cannot be confirmed. No production worker,
Chrome profile, cloud resource or Docker service is restarted or modified.

## Results

Final actual OCI run, session `75652`: **1/1 passed**, zero failed/skipped/
cancelled, 2.55 seconds in the test / 4.81 seconds total. Log:
`/tmp/relay-oci-worker-loss-v3.log`.

The fixture-data extraction was also checked against the existing native
checkpoint, real PostgreSQL and process-loss adapter tests: **15/15 passed**,
zero failed/skipped/cancelled, 7.02 seconds, session `64288`. Log:
`/tmp/relay-oci-fixture-regression.log`.

The two earlier OCI attempts correctly failed isolation assertions before any
native adapter was launched: the generated rootless template inherited host
networking, then its default read-only host `/sys` bind was detected. The final
helper explicitly creates a private network namespace and excludes all host
bind mounts; neither assertion was relaxed. Their cleanup removed only their
generated containers. Logs: `/tmp/relay-oci-worker-loss.log` and
`/tmp/relay-oci-worker-loss-v2.log`. The final log's `container does not exist`
diagnostics are the expected readback after each successful runtime deletion.

Independent source review covered exact cleanup ownership, namespace assertions,
database reopen, no implicit native turn and the distinction between synthetic
and installed-native evidence. The reviewer did not run another test.

## Reproduction and runtime provenance

Docker Desktop was unavailable locally; no attempt was made to repair or
restart it. A separately downloaded **runc 1.5.1** binary was used only from a
private temporary directory. Its release signature was verified with the
release's public keyring before running containers. SHA-256:
`177df879d50c913eb205e898d5c1c05a18f574053c0ce5524c471208eaf06f6f`.
No downloaded runtime is committed or globally installed.

```sh
RELAY_TEST_RUNC=/absolute/path/to/separately-verified/runc \
  taskset -c 0,1 nice -n 10 node --test scripts/smoke-oci-worker-loss.mjs

taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 \
  test/native-session-checkpoints.test.mjs \
  test/native-session-postgres.test.mjs \
  test/codex-native-checkpoint-runtime.test.mjs
```

Primary references: [runc rootless/container lifecycle](https://github.com/opencontainers/runc/blob/v1.5.1/README.md),
[release 1.5.1](https://github.com/opencontainers/runc/releases/tag/v1.5.1),
[release keyring](https://github.com/opencontainers/runc/blob/v1.5.1/runc.keyring).
The [official Codex lifecycle](https://learn.chatgpt.com/docs/app-server#lifecycle-overview)
distinguishes resuming an existing thread from starting a new turn. OpenAI Docs
guided keeping these assertions separate; it does not establish filesystem
flush guarantees.

## Remaining gates

- Combine actual container deletion with the installed native writer and its
  real tool history. A separate installed-CLI/process-deletion smoke does not
  turn this synthetic-provider test into combined acceptance.
- Validate abrupt mid-turn recovery points, independent child-session state,
  account revocation during remote restore and real cloud/controller lifecycle
  boundaries. Do not replay ambiguous side effects.
- Validate the RuntimeManager fatal-exit event pipeline independently. Here the
  visible messages are explicitly persisted through ChatStore; this test does
  not replace the separate worker-loss transcript tests or prove unflushed
  partial output survives.
- Production deployment and recovery of the already-stuck Claude chat remain
  separate, authorization-gated operations.
