# Codex native-session checkpoints (bounded item 41 implementation)

Status: focused implementation validation passed; **not a completed worker-loss acceptance receipt**. No production deployment, account sign-in, real model prompt or cloud resource operation belongs to this partition.

## Behavior

An ordinary `thread/resume` error used to discard the saved thread ID and call `thread/start`. Missing disk history, required MCP startup failure, authorization failure and mismatched returned thread identity therefore all risked silently replacing the conversation. A saved ID is now mandatory: resume either returns that same ID or fails without creating an empty conversation.

For an explicitly owned chat using a connected named Codex account, the controller retains a private encrypted native journal bundle. The bundle contains the exact complete JSONL bytes of the root rollout and only required `history_base` ancestors, clipped at native byte boundaries. Opaque native reasoning records remain private encrypted data; they are not interpreted, reconstructed, exposed through chat metadata, or converted into visible transcript messages. No `auth.json`, cookies, host profile, settings, access tokens or unrelated session files are copied by this feature. User/tool content already present inside a rollout remains sensitive and encrypted; this is not a promise that native journals themselves contain no secrets.

The adapter attempts capture at startup, after native item/turn completion (coalesced at one second), after a send completes, and before intentional native shutdown. Stop drains its serialized capture queue before shutting down the process. Individual journal transfers have size/time limits; coalescing notifications is not a claim of a hard bound on all directly queued capture callers. A terminal capture carries the exact manager Stop/fatal lifecycle version, never a freshly inferred version; an old adapter cannot publish after another runtime has started and stopped. Capture failure preserves the previous checkpoint and the live session. A normal live capture failure emits a fixed warning without raw file/provider errors; fatal cleanup may already have fenced that event sink, so the absence of a displayed warning is not a successful-save receipt.

A `turn-completed` receipt additionally requires the actual root journal `event_msg` / `task_complete` record for that exact turn ID. A notification alone is not evidence of a flushed journal. `complete-records` and `stopping` mean only that a validated complete prefix reached controller storage; they do not certify the entire most recent turn.

On later startup, restoration happens only before starting the native process and only into an empty, private (0700), nonsymlink per-chat Codex profile. A populated profile is left untouched, including any existing same-ID journal; recovery never overwrites or installs a competing stale rollout beside it. The adapter resumes the original ID and sends no implicit user prompt, transcript summary, or replay. Restored active goals are parked as paused until explicitly resumed.

Anonymous chats, repo-less chats without an actual company, host-auth mode and absent controller storage do not acquire checkpoint support by fallback. No company is invented for an unassigned chat, and a previously company-bound checkpoint is not made available in unassigned scope. Existing host-mode/repo-less execution remains unchanged except that a failed ordinary resume cannot silently create a blank thread. Old chats with no checkpoint must still have their original native disk history to resume.

## Durable binding and locking

`NativeSessionCheckpoints` binds owner, chat, registered company, explicit environment ID (including null), provider, named-account ID, native account/workspace identity, native subject, and native thread ID. Agent accounts are user-wide and may serve separately scoped companies; no nonexistent company grant is required on the account. Every read/write revalidates durable chat ownership/selection, company registration, current environment admission, connected account/auth, and absence of the account-disconnection marker. Environment revision changes such as adding a variable do not invalidate history. Changing the actual environment/company/account binding does not silently move history across that boundary.

`nativeSessionTransaction` is a narrow internal records API, not HTTP. PostgreSQL acquires sorted advisory locks for the native-session row and fixed admission records, including absent revocation markers, then checks the expected embedded revision, runs a synchronous callback, and owns COMMIT before returning a receipt. MemoryRecords provides equivalent key locking/CAS behavior. Async callbacks and clients inside an externally owned transaction are rejected. No I/O callback executes inside the transaction. Scope is built from trusted coordinator selection, not client-provided arbitrary record kinds.

The stored digest checks the canonical bundle. Updates must preserve every previously saved file as an exact prefix, preventing a delayed/shortened/divergent capture from replacing newer history. Genuine native rewrites/rollback formats that violate that invariant require a separately validated recovery design; this code does not guess. Chat deletion removes the admission parent before the checkpoint, so a late writer cannot recreate deleted history. Scope and checkpoint locks share the existing durable account/company/environment write boundaries. Authorization is linearized at the transaction, not an atomic remote stop guarantee.

## Validation and remaining acceptance gates

Deterministic cases cover exact native bytes/opaque records, same-ID resume, no implicit turn, private-profile-only restore, scope changes/revocation, real account record shape, two-company named-account use, environment revision preservation, missing terminal marker, append-only/CAS, deletion, and old terminal capture ownership. A fixture process is externally killed and its fixture-owned temporary profile removed before exact restoration. **That is not an actual worker/container deletion proof.**

The PostgreSQL suite covers encrypted persistence/reopen, competing service instances, deferred COMMIT failure, scope reads from durable storage rather than speculative ChatStore state, absent-marker revocation ordering, and deletion ordering. The opt-in `CODEX_NATIVE_COMPAT_BIN` test uses a disposable private home with a synthetic journal and an unreachable loopback provider; it invokes native read/resume only, never `turn/start`, account login or real model inference. Its result must be recorded separately from fixture results.

Still required before item 41 can be called complete:

1. Establish installed-native writer flush/ordering and validate the complete terminal record boundary using a real native session lifecycle without consuming a production account or fabricated journal-as-flush evidence.
2. Demonstrate recovery after deletion of a disposable, actually isolated worker/container, including original instructions/native tool history and exact native ID; no silent transcript-only reconstruction.
3. Define and communicate the recovery point for abrupt mid-turn loss. Bytes not yet flushed by Codex or not yet committed on the controller cannot be recovered by this checkpoint mechanism. A one-second coalescing interval is not a zero-loss guarantee.
4. Validate full native child-thread/workflow storage and pending native goal/tool state. Root rollout ancestry alone does not certify every independent child session or remote side effect. Never automatically replay ambiguous actions.
5. Exercise real worker filesystem/SSH failure and account revocation during capture/restore, plus controller restart at each durable boundary. Local synthetic service tests are not cloud lifecycle evidence.

Official protocol reference: [Codex app-server](https://developers.openai.com/codex/app-server). Local generated `ThreadResumeParams` supports exact `threadId`; its `history` override is explicitly unstable/cloud-only and is not used here. No public flush/checkpoint RPC was identified in the inspected installed protocol. This absence is a limit, not proof that notifications imply filesystem durability.

Test commands (run serially in the shared test lane):

```sh
taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 test/native-session-checkpoints.test.mjs test/native-session-postgres.test.mjs test/codex-native-resume.test.mjs test/codex-native-checkpoint-runtime.test.mjs test/codex-session-bundle.test.mjs
CODEX_NATIVE_COMPAT_BIN=/absolute/path/to/codex taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 test/codex-native-checkpoint-cli.test.mjs
```

Validation receipt (2026-09-19): final serial eight-file run passed **44/44**, zero skipped/cancelled, in 15.86 seconds. This includes the suites above plus named-account runtime and worker-loss transcript compatibility. Installed Codex **0.155.0** read/resume compatibility passed with no new turn; PostgreSQL tests used a real disposable embedded server. Independent source review covered durable scope, exact terminal markers, fresh-only restore and lifecycle fencing.

The first native compatibility attempt lacked native turn events in its synthetic journal, so the visible-history assertion correctly failed; adding those synthetic events preserved the assertion. A second attempt reached read/resume assertions but exposed fixture cleanup ordering (directory removal before CLI shutdown). The final fixture stops the exact spawned process and waits for its pipes to close before directory cleanup; the final complete run passed. These were test-fixture corrections, not evidence of real model flush durability or a production incident.
