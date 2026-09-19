# Process-preserving two-minute hibernation

Status: required architecture; implementation and live acceptance incomplete.

## Settled product decision

The user chose **hibernate after two minutes of inactivity; full stop only by
manual action**. This supersedes the earlier proposal to stop after fifteen
minutes. Do not ask that policy question again, silently downgrade hibernation
to process restart, or treat this ADR as completion of the feature.

Hibernation must preserve the actual Node server, Chrome state, and relevant
native processes in memory. Re-running `npm run dev`, restoring a conversation
ID, reopening browser tabs, or starting a replacement machine does not meet that
requirement. Wake must work without sending an agent prompt.

Active agent/child/side work, approval/import reconciliation, scheduled work,
and existing viewer/presence exclusions must remain protected. The implementation
must define and test how those exclusions affect the two-minute clock. A clock
cannot expire during active work merely because the user has not typed recently.

Automatic deployments must also preserve existing workers, as required by the
[controller-continuity ADR](2026-09-18-automatic-rollouts-preserve-workers.md).
The historical permission to interrupt a manual setup is not permission to
interrupt the user's currently active worker or to enable disruptive automation.

## Audited baseline and uncommitted foundations

This audit inspected committed baseline `c19b7e9` and separately inspected the
root worktree's hibernation edits on 2026-09-19. Those edits were not imported by
this documentation change and are not represented as committed capabilities.

| Boundary | Evidence and missing behavior |
| --- | --- |
| Idle policy | [RuntimeManager](../../src/runtime-manager.mjs) `#scheduleIdleStop`, `#scheduleWorkerIdle`, and `browserIdle` call ordinary `stop("idle-timeout")`. No hibernate call is wired. |
| Browser lifetime | [SharedBrowsers](../../src/shared-browser.mjs) `touch` has a separate idle timer that calls `stop`, terminating Chrome. |
| Wake admission | RuntimeManager `wake` and `browserExecutor` return cached runtimes/executors. Retaining them through suspension without a new state machine would bypass actual machine resume. |
| Transport ownership | [SSH launcher](../../src/ssh-worker-launcher.mjs) terminates its remote process group on HUP/output failure. [JSON-RPC](../../src/json-rpc-process.mjs) binds pending calls to one child process. Neither supports durable reattachment to the same worker processes. |
| Restart and failure | [ChatStore.initialize](../../src/store.mjs) marks restored chats stopped. RuntimeManager `shutdown` and `#fatal` tear down workers. Transport loss is not distinguished from authorized full stop. |
| Credentials | [Capabilities](../../src/capabilities.mjs), [MCP grants](../../src/mcp-connections.mjs), and SharedBrowsers retain grants in controller memory. Expiry, restart, and explicit revocation must be reconciled on resume. |
| Image preparation | The committed [candidate recipe](../../deploy/aws/worker-hibernation.mjs) is opt-in; the [ordinary verifier](../../deploy/aws/verify-worker-ami.mjs) refuses to promote a hibernation candidate. Recipe generation is not process-preservation evidence. |

The separately inspected WIP adds a config flag, backend hibernate operation,
launch options, quieter SSH keepalives, and a detached Node/Chrome memory probe.
It does **not** complete the lifecycle or reconnectable transport above. The
probe explicitly reports `accepted: false` and `productionReady: false`, with
application transport and the two-minute policy outside its scope.

Two integration hazards must be fixed before using those foundations:

- The WIP flag changes the default idle interval to 120,000 ms while the existing
  idle paths still terminate processes and ordinary-stop the machine. Enabling
  it alone would accelerate the wrong behavior. Explicit deployment settings
  can also override the default; inspect effective configuration at acceptance.
- The backend's legacy-worker admission rejection says the worker was not
  stopped, but RuntimeManager's acquisition-error cleanup calls `sleep` after
  any attempted acquire. Rejecting an existing running incompatible worker can
  therefore stop it through the manager. Cleanup requires an explicit record of
  which machine mutation this operation owns, not merely "acquire was called."

## Architecture decision

Introduce a durable, generation-bound worker lifecycle with distinct
`hibernating`, `hibernated`, and `resuming` states. Persist intent and observed
result separately so an interrupted controller operation can be reconciled
against the exact owned worker. Unknown outcome is not successful hibernation.
Record no credentials in public lifecycle state.

Suspend/resume must be different operations from adapter/browser Stop. Keep
application process ownership on the worker, independent of a particular SSH
connection. A narrowly scoped worker supervisor with a private reattachment
channel is the proposed implementation; an alternative must demonstrate the
same continuity, isolation, bounded-buffer, and no-replay guarantees. Disabling
SSH keepalives alone is not an alternative to reconnectable process ownership.

Reattachment must verify deployment/chat/owner, exact worker and process identity,
selected provider/account, and lifecycle generation. Permit only the current
controller lease; fence stale controllers and late responses. Do not infer
ownership from a PID alone or adopt arbitrary existing processes. Preserve
queued input and sequence boundaries without replaying a completed command,
prompt, approval, or user message.

Before resumed work is admitted, revalidate the selected account and company
scope and reconcile expired/revoked capabilities. Surviving memory is not proof
of current authority. Do not copy host account credentials or resurrect old
capability strings from snapshots. Account disconnect/removal must remain
fail-closed across suspension and controller restart; a failed cleanup must
remain visible and retryable. Model security revocation separately from idle
management, not as a pretext for an automatic full-stop fallback.

Manual Stop and Delete remain explicit destructive lifecycle transitions. The
inspected WIP full-stop path resumes a hibernated VM before stopping it normally;
that temporarily resumes all its processes. Do not assume this interval is safe
for a revoked account. Its mechanism and authority fencing require acceptance
before promotion. Reconcile Stop/Delete racing suspend/resume without allowing
late callbacks to restore readiness or start a replacement worker.

On incompatible image, unknown resume outcome, transport loss, or failed
hibernation: report the actual state, deny unsafe admissions, and expose a
recovery action. Do not automatically full-stop, replace, or restart the user's
processes while describing that as hibernation.

## Release boundary

Keep the unsafe flag disabled and automatic publication blocked until the
[ordered implementation and acceptance checklist](../hibernation-implementation-checklist.md)
is satisfied. Existing live workers are not migration fixtures. Cloud acceptance
requires a separately coordinated disposable worker, exact resource scope,
safe cleanup evidence, and authorization; this ADR authorizes none of those
operations by itself.

Local tests establish policy, transport logic, authorization, and race behavior.
Only real, separately authorized suspend/resume evidence can establish memory
survival and cloud transport recovery. A successful detached-process probe is
one prerequisite, not evidence that the application feature is complete.
