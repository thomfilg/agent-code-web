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
- `e7689a7`: incoming-message follow, manual scrollback and stable latest
  navigation, with the focused tests and independent review described below.

These checkpoints are saved on the PR branch. A source checkpoint is not
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
- The first final integrated run of 1,188 cases passed 1,187 and failed one
  existing 40 ms account-readiness budget assertion tied to the host wall
  clock. The unchanged case passed in isolation. Its test now advances a
  controlled clock and asserts exact remaining budgets `[40, 20]`, keeping
  timeout and wrong-auth-type refusal checks intact; no authentication runtime
  code changed. The entire auth-client file plus manual-only CI guards passed
  **17/17**.
- Final integrated rerun: **1,187/1,188 passed**, zero skips, 388,000 ms;
  `/tmp/relay-final-rollout-node.log`. The sole failure was the personal Chrome
  consent dialog reporting `Failed to fetch`. An isolated attempt also exposed
  fixture interaction before UI readiness. The fixture now waits for the real
  startup-ready button and records only fixed consent-route classifications,
  HTTP statuses and sanitized network error codes (no bodies/cookies/URLs).
  The complete personal Chrome case then **passed in 32.9 seconds**, including
  private login isolation, explicit grant/revocation and restart behavior;
  `/tmp/relay-personal-chrome-diagnostic-rerun.log`. Every recorded consent
  response was HTTP 200. No application runtime changed for this fixture fix.
  The original transient network failure is not causally diagnosed, and this
  receipt does **not** claim an uninterrupted all-green final full-suite run.

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

## Deployment — independently verified at 16:05 UTC

- Runtime revision: `e7689a7cff469ce800a0bca19397625d44cfec3f`.
- Image: `456808212788.dkr.ecr.us-east-2.amazonaws.com/agent-relay-mvp-applicationrepository-sujdgarjwejp@sha256:36d67eb651e6d4bc2156dea44a3d93165b9ee91c6c264e17e1275fa2cc8ca0da`.
- Build: `ImageBuild-t8BSbSkDsHYX:9e1863c3-73b8-493e-b6a7-ececd7004785`,
  **SUCCEEDED**, immutable S3 source version `r2qlUxeLSu6PR4La9JlHYbFvDYKCKiob`.
- Rollout: SSM `3d556b2b-09a2-4fdd-a9c5-6aa8858c873b`, **Success**, exit **0**,
  elapsed **34.892 seconds**, controller `i-08c991c22089589a5`.
- `/readyz`: HTTP 200 with `ok:true`. All **11 changed public assets** returned
  200 without Set-Cookie and SHA-256 matched the exact runtime commit.
- All **13 fixed GitHub negative-route probes** passed at 16:04:59 UTC. These
  verify rejection behavior, not positive authenticated GitHub operation;
  pair this receipt with the independently established image/revision above.
  Zero model prompts or provider mutations were requested by the probe.

This replaces runtime `f271d7e`. No chat, credential or data volume was deleted.

Read-only AWS preflight at 15:46 UTC verified the expected account/stack,
healthy controller, encrypted attached data volume, SSM and readiness. At
15:50 UTC, an exact-deployment tag-filtered query counted one running worker.
The current controller shutdown also stops EC2 workers; its drain check does
not prove retained native Bash tasks are idle. After this was explained, the
user explicitly authorized interruption for today's manual update and clarified
that future automatic deployments must preserve running instances. See the
[continuity gate](adr/2026-09-18-automatic-rollouts-preserve-workers.md).
The later read-only worker count at 16:05:44 UTC was one running worker, all
other states zero. That isolated count does **not** prove whether a worker
stopped/restarted or whether native processes survived this authorized manual
rollout, and is not evidence that the future automatic-continuity gate passes.
