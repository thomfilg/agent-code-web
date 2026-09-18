# Chat UI follow-up validation — 2026-09-18

## Saved source checkpoints

- `366d6e4`: GitHub-authorized repositories without an additional Relay company
  allowlist, startup readiness, observed branch strip, default footer removal,
  and preserved native Claude command metadata.
- `317c82d`: selected-account Claude model discovery waits for the native
  bootstrap, then refreshes the model list without submitting a turn. Native
  disabled options retain their reasons; the duplicate Default is removed.
- `27a3e12`: the active command menu refreshes after selected-account metadata
  arrives. Late discovery cannot refresh a different chat, owner, provider,
  account or model; dismissed menus stay dismissed.

All three checkpoints are saved on the PR branch. A source checkpoint is not
a deployment receipt or confirmation of real account capabilities.

## Completed local evidence

- Full Node suite on `317c82d`: **1,166 passed**, zero failures/skips,
  359,778 ms; `/tmp/relay-final-acceptance-node.log`.
- Additional model-picker/cold-command-cache regressions on `27a3e12`:
  **14 passed**, zero skips. The race test uses the actual model picker,
  slash composer and server command catalog with disposable DOM/API/account
  doubles; it verifies one model discovery and no writes or submitted prompts.
- Claude command and native-model browser acceptance: **49 distinct cases
  passed** across desktop/mobile fixtures. The initial run passed 47; two
  cases stopped at the fixture's 5-second startup-title deadline, before any
  behavior assertions. Both passed after explicit startup/SSE readiness with
  a 15-second title deadline; behavior assertion timeouts were not relaxed.
  Logs: `/tmp/relay-claude-catalog-browser.log` and
  `/tmp/relay-claude-catalog-startup-rerun.log`.
- Earlier GitHub/account/startup/footer browser and official MCP fixture
  receipts remain recorded in `feature-queue.md`. These use disposable data,
  not real OAuth approvals or provider quota.

## Incoming-message follow investigation

The isolated browser reproduction began at the exact bottom. After resizing
the viewport from 1440×900 to 820×600, another assistant delta arrived but the
viewport stayed **1,208 pixels above the bottom**, without manual transcript
scrolling. This establishes an auto-follow defect, not just delayed delivery.

The fix must keep following through layout changes, preserve intentional
scrollback and provide a stable explicit return to the latest message. The
first attempts at the two other reproduction cases failed at fixture startup,
not at scroll assertions, and are not evidence of additional scroll defects.
The fix now keeps follow/scrollback intent independently of layout changes,
observes the scroller and bounded message window's border boxes, and keeps
one Jump to latest button outside transcript replacement. Wheel, touch,
keyboard and scrollbar gestures can detach; explicit latest or scrolling back
to the tail resumes. Pinch zoom does not count as scrolling into history.

Final focused evidence: **14/14 unit/window cases** and **5/5 browser cases**
(18.4 seconds), including the three new follow cases and two existing
long-history/message-navigator regressions. Tests cover viewport/composer and
late content growth, real upward wheel gestures during every-frame deltas,
stable button identity, reading-position retention, explicit resume, long
scrollbar gestures, chat reset, and native animation callback binding.
No page errors or submitted prompts occurred. The mounted transcript remains
bounded to 60 persisted rows plus one streamed reply. Desktop and 320-pixel
screenshots were visually inspected at
`test-results/message-follow-desktop.png` and
`test-results/message-follow-mobile.png`.

Earlier fix iterations failed on native animation callback binding and a
content-box-only observer; both were corrected and the original browser
assertions rerun without relaxation. These were local failures, not deployed
changes.

## Not established by these tests

- Whether this user's account currently offers Fable, or whether an installed
  worker supports a version-disabled Fable variant. Relay uses native results;
  fixture models do not prove provider availability.
- The cause of the separately reported intermittent failure of all composer
  controls. Normal stopping-state restrictions do not explain that report.
  A source-level reproduction confirms a pending model save delays selection
  and send operations; a burst also causes one synchronous transcript render
  per event. Neither reproduction establishes which, if either, occurred in
  the user's incident. No global overlay/inert latch was established.
- Actual Ultracode mode support in Relay; it remains a separate planned change.
- Complete MVP acceptance, real Linear consent, authenticated preview, or
  selected-account worker restart/resume.

## Deployment

Pending. The previously deployed revision remains `f271d7e` until an immutable
image rollout, SSM result, health and exact public asset checks establish a
new receipt. No existing chat, credential or running job is disposable test data.

Read-only AWS preflight at 15:46 UTC verified the expected account/stack,
healthy controller, encrypted attached data volume, SSM and readiness. At
15:50 UTC, an exact-deployment tag-filtered query counted one running worker.
The current controller shutdown also stops EC2 workers; its drain check does
not prove retained native Bash tasks are idle. The user was asked whether the
background task has finished. No drain, stop or rollout was performed for this
checkpoint.
