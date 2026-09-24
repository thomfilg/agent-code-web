# Explicit worker wake and deletion feedback — 2026-09-18

## Scope

The user requested a button to bring the chat environment back without sending
filler input to the agent, especially after returning to Shared Chrome. They
also reported a roughly 30-second wait for chat deletion with no useful feedback.

- The runtime banner now has **Wake environment**, immediate **Waking…**
  feedback, disabled duplicate actions and a ready state. It retains the draft
  and reconnects an already-open, disconnected browser panel after readiness.
- `POST /api/chats/:id/wake` acknowledges with 202 before cold acquisition
  finishes. Normal chat events carry progress/readiness/errors. Authorization,
  ownership, archive checks and lifecycle cancellation still apply.
- Wake acquires only the worker/workspace. It does not start a native adapter,
  submit a prompt, resume a goal, drain queued input, or change the saved native
  session. Concurrent wake requests share one acquisition. Stop/Delete cancels
  a pending wake; late startup cannot restore ready state or acquire a worker
  after an earlier environment check was cancelled.
- Worker-only readiness participates in the existing presence/idle policy and
  releases its lease when unused. Visible remote worker-only sessions refresh
  the existing heartbeat without starting an agent.
- Delete immediately shows **Deleting…** in the sidebar/dialog and progress
  in the active banner. Duplicate deletion and conflicting wake/send controls
  are disabled. The chat is removed only after backend confirmation; a failed
  deletion remains visible and retryable. The EC2 stop latency itself is not
  eliminated, and deletion is not falsely reported as successful early.

Waking a stopped VM does **not** restore a terminated `npm run dev` or Chrome's
previous in-memory state. Automatic service restart and hibernation are separate
capabilities; the UI's wake tooltip states this limitation.

## Validation

- Seven new manager/HTTP tests pass: prompt-free/deduplicated admission, session
  and queue preservation, cancellation, failure/retry, idle/presence, archived
  and foreign-owner rejection, and quick HTTP admission during blocked startup.
- Fifteen browser cases pass in the final UI run (51.6 seconds) across runtime controls, existing chat organization
  and Shared Chrome: actual browser reconnection, draft retention, no message or
  queue POST, pending feedback, failed deletion/retry and cross-chat late replies.
- Full sequential Node regression: **1,209 passed, zero failures, three explicit
  opt-in skips**, 290,832 ms. The skips remain the official-MCP local guest and
  two native credential-environment probes. No backend changed after this run;
  the final UI run additionally covers the composer guard while wake is pending.
  Logs: `/tmp/relay-runtime-wake-node.log` and `/tmp/relay-runtime-wake-ui-final.log`.
- Desktop and 320-pixel mobile screenshots were visually inspected at
  `test-results/runtime-wake-{starting-desktop,ready-mobile}.png`. The final
  mobile test waits for the closed sidebar transition and checks banner overflow.
  No publication is claimed at this source checkpoint.
- The initial deletion fixture tried clicking inside a closed Chat actions menu.
  The fixture was corrected to open the real menu; behavior assertions were not
  relaxed. An intermediate mobile screenshot retake tried clicking an offscreen
  closed-drawer button; it now checks the actual drawer state and transition.

All fixtures use disposable test data, not real provider quota or account consent.
The unrelated unfinished Claude-doctor script/fixture remains untouched and must
not be included in this feature's commit or immutable build.

## AWS publication — independently verified at 18:40 UTC

- Runtime source: `b89269a87d72f3a989a7598cf889639ecf05b293`.
- CodeBuild: `ImageBuild-t8BSbSkDsHYX:b8c96b38-1447-4cc6-84b8-2f9287490857`,
  SUCCEEDED; immutable source version `nbQstXqtLZR3eHKWu8P5omXHMRltchY6`.
- Image digest: `sha256:4cb53a408f0e96cbf9d7aae9f92349f7528a1f3b94dd3edb03342f9ba5c43487`.
- Manual rollout SSM `e8941890-07f8-4aa9-b96a-b74929d4398d`: Success/0.
- Independent read-only SSM `adc088bf-af9e-48cb-b9e7-2871f40f553c` confirmed
  that the container is running that exact immutable image.
- Public `/readyz`: 200/ok; anonymous `/api/chats`: 401. All five changed
  public files matched their Git bytes. Thirteen fixed GitHub denial probes
  passed, without provider operations, model prompts or account imports.
- Exact deployment-owned worker inventory was empty before and after rollout.
  No chat, user data, worker instance or volume was deleted by this publication.

The authenticated Wake/Delete flow was tested with the local browser fixtures
above, not replayed in the user's live AWS account. The negative-route receipt
does not claim authenticated acceptance. Automatic rollout remains disabled.

## New inactivity/hibernation request — decided, not activated

After the cost clarification, the user explicitly chose **hibernate after two
minutes of inactivity; full stop only by manual action**. This supersedes the
earlier fifteen-minute automatic full stop. No policy question remains open.
The current production timers and launch configuration have not yet been changed;
activation requires the process-preserving acceptance below.

AWS does not charge instance usage after hibernation reaches `stopped`, while
EBS storage remains billable. Ordinary stop also leaves EBS storage in place;
switching from hibernation to full stop does not add compute savings. Hibernation
may require a larger root volume to fit RAM. See [AWS hibernation](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/Hibernate.html)
and [stop/start](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/Stop_Start.html).

Current Relay launches omit hibernation configuration and its shutdown calls
ordinary `stop-instances`. AWS requires enabling hibernation when launching a
compatible instance; it cannot be enabled on an existing instance. The worker
AMI, encrypted root sizing and real resume must be accepted before claiming
support. See [AWS prerequisites](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/hibernating-prerequisites.html).

Further acceptance must establish survival of a real Node server and Chrome
state, reconnection of transports without replaying prompts, cancellation and
explicit Stop/Delete, ownership boundaries, recovery after controller restart,
and what counts as idle. Active agent work must not be treated as user inactivity.
The current seven-minute orphan watchdog and SSH-tied process lifecycle must be
reconciled with any new policy; changing two timer values is not that feature.
