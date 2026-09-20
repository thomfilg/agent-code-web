# Hibernation implementation and acceptance checklist

Policy: **hibernate after two minutes of inactivity; full stop only manually**.
This checklist implements the [hibernation ADR](adr/2026-09-19-process-preserving-hibernation.md).
Every item below is pending unless a later receipt records exact source and
evidence. This document is not an acceptance receipt or authorization to operate
cloud resources. Do not enable the flag as a shortcut to completing the list.

## Ordered, bounded implementation partitions

### 1. Lifecycle contract and exact cleanup ownership

Files: [runtime-manager.mjs](../src/runtime-manager.mjs),
[store.mjs](../src/store.mjs), [worker-backends.mjs](../src/worker-backends.mjs).

- [x] Define persisted lifecycle intent/result, generation, exact worker identity,
  current controller lease, and safe timestamps. Distinguish suspended, fully
  stopped, unknown, and failed states without storing private credentials.
- [x] Define backend acquire/resume receipts identifying whether an operation
  created/started a worker or merely inspected an already-running worker.
- [x] Fix `browserExecutor` cleanup so rejected admission cannot full-stop a
  pre-existing running legacy/nonaccepted worker. Preserve parallel-startup
  join-before-upload and cleanup guarantees from the current implementation.
- [x] Specify restart reconciliation in `ChatStore.initialize` and manager
  admission; never turn a saved record alone into proof of a live process.
- [x] Add deterministic tests for persistence failure before/after intent,
  uncertain cloud completion, old-generation callbacks, and foreign worker IDs.

This partition is preparatory. It does not enable hibernation or change timers.
Its implementation and exact limits are recorded in the
[lifecycle-contract receipt](validation-2026-09-20-hibernation-lifecycle.md).

### 2. Process ownership and reconnectable transport

Files: [ssh-worker-launcher.mjs](../src/ssh-worker-launcher.mjs),
[worker-backends.mjs](../src/worker-backends.mjs),
[json-rpc-process.mjs](../src/json-rpc-process.mjs),
[worker-process.mjs](../src/worker-process.mjs),
[shared-browser.mjs](../src/shared-browser.mjs),
[browser-worker.mjs](../src/browser-worker.mjs),
[Codex adapter](../src/adapters/codex.mjs),
[Claude adapter](../src/adapters/claude.mjs),
[claude-session.mjs](../src/claude-session.mjs).

- [ ] Implement a narrowly scoped worker-owned supervisor/private attachment
  protocol or an equivalently verified process-preserving design. Separate
  transport detach from process termination and from manual Stop.
- [ ] Bind attachment to exact deployment/chat/worker/process instance and lease
  generation; reject foreign endpoints, stale controllers, PID reuse, and
  attachment after deletion or revoked admission. Keep diagnostics sanitized.
- [ ] Define bounded output buffering, sequence acknowledgement and pending RPC
  recovery. Never replay a mutating RPC or prompt merely because its response
  was lost; expose unknown outcomes for explicit reconciliation.
- [ ] Preserve Node background servers and the same Chrome/renderer state across
  detach/reattach. Cover both Codex and Claude ownership, not only one provider.
- [ ] Test transport loss, long silence, controller restart and repeated
  reattachment with synthetic local processes and in-memory sentinels. Verify
  no duplicate process, prompt, approval, tool call, or queued-message delivery.
- [ ] Ensure error and timeout paths cannot route expected suspension into
  RuntimeManager `#fatal` full-stop cleanup.

This is mandatory continuity work, not an optional enhancement after release.

### 3. Resume authorization and revocation

Files: [agent-accounts.mjs](../src/agent-accounts.mjs),
[capabilities.mjs](../src/capabilities.mjs),
[mcp-connections.mjs](../src/mcp-connections.mjs),
[github-worker-gateway.mjs](../src/github-worker-gateway.mjs),
[shared-browser.mjs](../src/shared-browser.mjs),
[runtime-manager.mjs](../src/runtime-manager.mjs),
[server.mjs](../src/server.mjs) account `onRevoke` integration.

- [ ] Revalidate exact selected owner/provider/account and company/environment
  binding before resume admission. Do not substitute another connected account.
- [ ] Reconcile expired MCP/browser/provider/GitHub capabilities without restoring
  revoked authority or copying host credential stores. Native processes holding
  old credentials must not bypass the new admission decision.
- [ ] Prove disconnect/removal/expiry while hibernated remains fail-closed after
  reconnect and controller restart, including failed persistence and failed
  worker cleanup. Keep unrelated accounts usable and retries visible.
- [ ] Test late credential refresh, stale RPC responses, account selection change,
  company/MCP removal, and concurrent Stop/Delete during resume.
- [ ] Establish safe handling of the WIP resume-before-full-stop interval: no
  resumed revoked work may gain provider or company access before cleanup.

Do not equate RAM preservation with credential validity or authorize work from
an old controller's cached capabilities.

### 4. Two-minute policy and non-destructive UI transitions

Files: [runtime-manager.mjs](../src/runtime-manager.mjs) `#scheduleIdleStop`,
`#scheduleWorkerIdle`, `browserIdle`, `wake`, `browserExecutor`, `stop`, `remove`,
`shutdown`, and `#fatal`; [shared-browser.mjs](../src/shared-browser.mjs) `touch`,
`ensure`, and `stop`; [config.mjs](../src/config.mjs);
[chat-presence.mjs](../src/chat-presence.mjs),
[preview-activity.mjs](../src/preview-activity.mjs),
[app.js](../public/app.js), and [index.html](../public/index.html).

- [ ] Wire all automatic idle paths to the accepted suspension state machine;
  remove independent idle Chrome teardown in that mode. Manual Stop/Delete must
  retain explicit semantics, rather than being aliases for hibernation.
- [ ] Keep active main/child/side work, trust/import reconciliation, scheduled
  work, and browser/preview/workspace/tab presence exclusions. Document exactly
  when the idle clock starts, pauses, and resets.
- [ ] Make wake resume retained infrastructure and processes without a prompt;
  cached executor/runtime objects must not bypass resume. Deduplicate browser,
  workspace, agent, and explicit wake requests.
- [ ] Show real hibernating/hibernated/resuming/failed states and actual timing;
  do not show "ready" until resume/authorization/transport checks succeed.
- [ ] Use fake clocks to verify the 120-second boundary, activity immediately
  before expiry, visibility changes, multiple viewers, queued messages and
  Stop/Delete racing the suspend operation. Never count a Node development
  server's existence alone as an active model turn.
- [ ] Verify effective deployment configuration, including explicit
  `AGENT_IDLE_TIMEOUT_MS` overrides. Do not change production flags yet.

### 5. Image, watchdog and acceptance promotion

Files: [worker-hibernation.mjs](../deploy/aws/worker-hibernation.mjs),
[worker-cloud-init.yaml](../deploy/aws/worker-cloud-init.yaml),
[bake-worker-ami.mjs](../deploy/aws/bake-worker-ami.mjs),
[verify-worker-ami.mjs](../deploy/aws/verify-worker-ami.mjs),
[verify-worker-controller.py](../deploy/aws/verify-worker-controller.py),
[worker-image.mjs](../src/worker-image.mjs), and
[worker-backends.mjs](../src/worker-backends.mjs).
The root WIP also contains a detached `hibernation-probe-worker.mjs`; it is not
part of the committed baseline used by this document.

- [ ] Integrate the inspected WIP only after scoped source review. Keep candidate
  image status distinct from ordinary acceptance and application continuity
  acceptance; no manual tag may substitute for missing evidence.
- [ ] Verify supported launch/image/disk configuration against authoritative
  current provider requirements before any separately authorized cloud probe.
- [ ] Reconcile the orphan watchdog and post-resume heartbeat with the new policy;
  neither may silently full-stop a worker or immediately rehibernate a newly
  resumed machine based on elapsed wall-clock suspension time.
- [ ] Extend verifier receipts beyond detached Node/Chrome memory to actual
  application transport, same-process identity, authorization and no-replay
  checks. Failed or partial evidence must never promote an image.
- [ ] Issue/read back an exact acceptance marker only after complete evidence and
  verified disposable resource cleanup. Preserve ownership, private network,
  metadata-disabled, credential-scrub and image-identity checks.

### 6. Separately coordinated disposable acceptance and activation

- [ ] Obtain/confirm explicit scope for disposable cloud verification; identify
  exact account, deployment, image and resources. Never use the active user
  worker, its browser profile, user credentials or live conversation as fixtures.
- [ ] Run Node and Chrome with ephemeral in-memory sentinels; record safe hashes,
  process/start identity, browser JS state and counters before/after actual
  hibernation. A restarted process with the same files must fail acceptance.
- [ ] Exercise actual application transport and prompt-free wake after more than
  two minutes, repeated cycles, connection loss and controller restart. Record
  preserved background server responses and unchanged relevant process memory.
- [ ] Exercise account revocation/expiry and company-scope denial using synthetic
  provider fixtures; actual paid model prompts or OAuth grants require separate
  authorization and are not implicit in a VM verification task.
- [ ] Exercise explicit Stop/Delete, failure recovery, stale callbacks, and
  failed rollout/rollback. Confirm no auto full-stop fallback or unintended
  resume of revoked work.
- [ ] Terminate only exact disposable test resources and confirm attached
  disposable volumes are removed; preserve receipts without private output.
- [ ] Publish an evidence-backed activation/migration plan. Existing incompatible
  workers need an explicit migration decision, never silent replacement.
- [ ] Enable policy only after every prerequisite passes and deployment is
  separately coordinated. Keep automatic rollout disabled until its independent
  worker-preservation acceptance gate also passes.

## Completion rule

Completion requires implemented lifecycle, transport, authorization, policy and
image gates **plus** scoped live process-preservation evidence. A helper, green
unit suite, candidate AMI, detached memory probe, or this checklist alone does
not complete the user's hibernation MVP request.
