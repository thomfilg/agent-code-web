# Shared Chrome interaction — 2026-09-18

User-approved scope: reduce the lag in Shared Chrome and make basic reload and
plain-text copy/paste work. This does not replace the real Chrome engine, grant
agent access to a personal profile, or change worker deployment lifecycle.

## Implementation

- Forward Chrome's native JPEG screencast during interaction, suppress identical
  frames, and request a lossless high-DPI PNG after 350 ms of inactivity. Full
  screenshot capture no longer precedes every input/paint. Keep the canvas's
  backing size stable across 1x/2x frames, rejecting old surfaces with mismatched
  aspect ratios after resizing. Preserve serialization
  around idle screenshots and viewport changes: Chrome's surface cleanup must
  not undo a newer resize. Reject stale/wrong-size stream frames.
- Limit outstanding UI input to 12 requests, not one request per network round
  trip. Merge adjacent unsent drag/wheel updates only; never merge across keys,
  clicks, modifier changes or page changes. Copy/navigation/resize are barriers.
  Reconnection cancels unsent input rather than replaying it in a different chat.
- Worker stdout and each controller viewer retain one in-flight image and only
  the newest waiting frame. Personal Chrome uses a 256 KiB socket threshold with
  latest-frame retry. This delivers the final idle refinement even after a slow
  connection drains. The 32 ms stream throttle also delivers its trailing frame,
  rather than making the last update wait for PNG refinement. The client still
  keeps one decoder and only the newest waiting frame.
- F5, Ctrl+R and Cmd+R reload the focused remote page, not Relay. Shift bypasses
  cache. Ctrl+C/Cmd+C and toolbar Copy text retrieve only the selection through
  a fixed server expression, not arbitrary caller-provided JavaScript. Native
  paste and toolbar Paste text insert plain text. Start clipboard writes inside
  the user gesture; no background clipboard synchronization or history storage.
- Preserve existing user/chat/grant checks. Reject password copying, empty or
  oversized selections; reject oversized paste without truncation. This bridge
  does not yet implement rich formats/files, native cut or copying from a
  cross-origin embedded frame. Agent screenshots remain PNG.

Protocol/API references used for implementation: [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/),
[Clipboard API write](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/write).

## Reproducible local comparison

`scripts/benchmark-shared-browser.mjs [baseline-commit]` opens a disposable local
fixture, animates it, and sends 60 one-character inputs. The same two-core cap
and low priority were used for both runs, sequentially, with no model request,
cloud worker or personal browser profile. This measures worker input-command
acknowledgement and frame output, **not end-to-end AWS latency or time until an
LLM's first token**. The host also runs unrelated work, so these are samples,
not performance guarantees.

| Measurement | Baseline `56d1cb4` | Final worker `79d66cc` |
| --- | ---: | ---: |
| Input acknowledgement median | 170.9 ms | 6.6 ms |
| Input acknowledgement p95 | 223.5 ms | 21.8 ms |
| Workload duration | 12,973 ms | 2,976 ms |
| Output frames/s | 4.6 | 29.9 |
| PNG captures during interaction | 60 | 0 |
| Image data across the workload | 5,325 KiB | 2,192 KiB |

```sh
taskset -c 0,1 nice -n 10 node scripts/benchmark-shared-browser.mjs 56d1cb4
taskset -c 0,1 nice -n 10 node scripts/benchmark-shared-browser.mjs
```

An earlier, more heavily loaded baseline measured 1,140 ms median / 0.8 frames/s;
the first changed run measured 11 ms / 24.1 frames/s. The intermediate adjacent
comparison measured 317 ms / 2.7 frames/s versus 11.8 ms / 14.4 frames/s. Use the
final adjacent comparison above, after adding trailing-frame delivery, rather
than selecting the largest improvement from separate runs. Higher frame rate
can use more bandwidth per second (410 vs 737 KiB/s in the final sample), even
though the faster completed workload transmits fewer total bytes.

## Acceptance and publication

Runtime source checkpoint: **`79d66cc47141994280580d8977d914b4b9a4dcfa`**, committed
and pushed to draft PR #4. Final verification of this runtime:

- Full Node suite, sequential and pinned to two cores: **1,202 passed, zero
  failures, three opt-in skips**, 322,836 ms. Skips are the official-MCP local
  guest UI probe and the two explicit native credential-environment probes.
  Log: `/tmp/relay-browser-interaction-node.log`. The existing uncommitted
  Claude-doctor script/fixture were preserved, excluded from this commit, and
  were still present in the working tree during testing.
- **8/8 actual UI browser tests passed**, 41.4 seconds: all viewport presets,
  hover/click/typing, native direct preview, F5/Ctrl+R without reloading Relay,
  real clipboard shortcuts/toolbar, denied/oversized paste, plus the three
  existing stream-follow/scrollback regressions. Both idle PNG delivery and
  stable canvas geometry are checked, not just nominal bitmap dimensions.
  Log: `/tmp/relay-browser-interaction-ui.log`. Desktop and mobile screenshots
  were visually inspected in `test-results/shared-browser-{desktop,mobile}.png`.
- The full Node run includes the actual personal extension's login isolation,
  explicit consent, fixed-expression copying, revocation and restart checks;
  protocol/input-window/copy denial tests; bounded frame buffering and final
  frame delivery; and correct cancellation through viewer/chat changes.

Earlier iterations failed on duplicate-frame starvation and transient
wrong-aspect surfaces/unstable canvas backing sizes during resize. Those were
fixed and the final complete runs above passed without relaxing the behavior
assertions. All browser state was disposable fixture data, with no real model
prompts or real account consent.

AWS credential verification currently reports an expired `code-web` login.
No deployment or running worker was changed. The published runtime remains
`e7689a7` until there is a separate successful rollout receipt. Publication must
respect the [worker continuity constraint](adr/2026-09-18-automatic-rollouts-preserve-workers.md);
today's manual exception is not authority to enable disruptive automatic deploys.

## Separate agent-chat latency question

The browser POSTs messages to the Relay controller. The controller validates
ownership/settings, persists accepted input and sends it to the CLI on the
chat's EC2 worker over its existing process/SSH transport. Responses return
through the controller's SSE connection, not a direct browser-to-worker socket.
Provider routing also depends on the configured native-account/gateway mode.

Source inspection confirms that message submission waits for a pending model
save, and each assistant delta currently rebuilds the visible transcript
synchronously. Either can contribute to perceived lag, as can worker startup,
network or provider latency; their contribution in the user's live chat has not
been measured. This browser patch does not claim to fix or diagnose that separate
incident and sends no real prompt to investigate it.
