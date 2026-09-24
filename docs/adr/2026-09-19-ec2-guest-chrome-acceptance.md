# ADR: guest Chrome acceptance through a disposable local Relay

Status: implemented and locally exercised operator; actual EC2 execution and exact instance retirement
remain separate gates until their receipts are recorded.

## Decision and scope

Use the real Relay server, UI, SharedBrowsers and browser-worker source against
one fresh, dedicated private EC2 worker. The controller is a disposable local
loopback fixture with an in-memory database and random temporary access token.
It is not the live local server or the deployed CloudFront application. Official
`@playwright/mcp` drives every UI interaction and canvas assertion. There are no
provider account reads, model turns, synthetic conversation prompts, external
application credentials or worker downloads/installations.

The operator defaults to a zero-call plan. `--run` reuses the native acceptance
guards and transport: exact account/region/stack/controller, selected encrypted
AMI, private `t3.medium` worker, deployment subnet/group/key, no role, disabled
IMDS, a matching fresh `AgentRelayNativeAcceptance` UUID, and no product chat or
image-verification tags. Only signed, privately extracted Session Manager code
may be downloaded on the operator machine. The controller-routed SSH connection
uses the existing private launcher protocol and heartbeat. Dynamic commands and
environment are sent through private stdin, not SSH/SSM argv.

A **separate fresh worker** is required. Do not reuse the VM from native Claude
acceptance: that operator requires its instance to be retired after every run.
This operator also requires the supervisor to retire its exact tagged worker
after success or failure; it never creates, stops or terminates EC2 instances.

## What a successful receipt proves

- The product UI selected 320×640, 390×844, 640×960, 834×1112, 1280×800 and
  1920×1080 on the same tab and document, then returned to 640×960 with input
  state preserved. No new-tab/back workaround is used.
- The guest page reported the exact CSS dimensions and DPR 2. The client canvas
  has the matching physical size, background pixels, and alternating one-CSS-
  pixel black/white stripes rendered as exact two-pixel groups.
- Mouse and keyboard events delivered through the displayed canvas reached the
  guest. An SSE-triggered page change produced the expected green pixel in the
  **client canvas**, not merely a changed guest DOM/status value.
- Viewer presence was active during use and cleared on Stop Chrome.
- Actual run-owned Chrome processes are non-root, use a debugging pipe, contain
  no sandbox-bypass flag, and have renderer Seccomp mode 2 plus deeper NSpid
  nesting than the browser root. This is kernel process evidence, not only a
  browser self-report. Nondumpable processes may have root-owned proc entries:
  effective UID comes from `/proc/PID/status`, never directory ownership. Every
  run-owned process must have the fixture's intended non-root effective UID;
  changed-UID descendants are retained and fail the check, not filtered out.
- Stop Chrome left a complete process inventory with zero run-owned processes.
  The private fixture directory was removed only after checking its exact path,
  owner, permissions, marker UUID/PID and complete zero-process inventory.
- The fixture conversation has no messages. The private SSM session was closed.

An inaccessible extant process cannot establish absence. Unknown/unclassifiable
Chrome processes, incomplete scans, orphan run processes or a changed ownership
marker fail cleanup instead of claiming success. Only processes started by this
fixture are terminated. SIGKILL/network loss can still prevent cleanup; the
supervisor's exact worker retirement remains mandatory even with a green JSON
receipt. No personal browser profile is opened, copied or modified.

## Running

First inspect the zero-call plan:

```sh
taskset -c 0,1 nice -n 10 node scripts/smoke-ec2-guest-chrome.mjs
```

After the AMI has independently passed its fresh-boot/stop-start acceptance,
launch a fresh private worker using the same native acceptance tag contract
documented in [native acceptance](2026-09-19-ec2-native-acceptance.md). Wait for
fresh boot, then run with its exact identifiers:

```sh
taskset -c 0,1 nice -n 10 node scripts/smoke-ec2-guest-chrome.mjs --run \
  --worker-id i-EXACT-DISPOSABLE-WORKER \
  --image-id ami-EXACT-ACCEPTED-IMAGE \
  --acceptance-id EXACT-NEW-UUID
```

The default private key is the native acceptance deployment key. `--ssh-key`
may override it only with an absolute owner-private file matching the stack's
public key. No token/profile/instance-creation options are accepted. Only one
browser-heavy job should run at a time. The installed official MCP and baked
`/usr/bin/google-chrome` are used as-is; no browser installer or `--no-sandbox`
fallback is available.

Screenshots are kept under `test-results/ec2-guest-<UUID>/`. They show only the
public fixture page, never a user account or real workspace. After any outcome,
recheck the exact instance/UUID, retire that worker and observe termination. If
the operator was killed, inspect and close only its exact SSM session as well.

## Local verification and limitations

Offline tests cover zero-call defaults, strict executor commands, SSH framing,
private bounded HTTP/control input, ownership markers, orphan processes and
incomplete process scans. The opt-in local test runs the real UI and real guest
Chrome through official MCP without any AWS calls:

```sh
RELAY_GUEST_UI_TEST=1 taskset -c 0,1 nice -n 10 \
  node --test test/ec2-guest-chrome.test.mjs
```

Local fixture success is not live EC2 evidence. Actual EC2 success is not deployed
Google authentication, native account consent, remote application forwarding,
product chat creation or a CloudFront browser-stream test. Report those gates
separately. Do not mark this EC2 acceptance complete before the operator receipt
and exact VM retirement have both been observed.

Implementation evidence: 9/9 dedicated tests passed with the real local MCP UI
test enabled. The focused guest/native/SSH/resize run passed 33 tests, with its
one opt-in UI test skipped because the real browser run had already completed.
The zero-call plan also ran successfully. Review found proof gaps in incomplete
process inventories, changed-UID descendants, and checking only guest state for
live updates; all were corrected with regressions. No AWS or model calls
were made for this implementation evidence.
