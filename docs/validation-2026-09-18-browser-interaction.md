# Shared Chrome interaction — 2026-09-18

User-approved scope: reduce the lag in Shared Chrome and make basic reload and
plain-text copy/paste work. This does not replace the real Chrome engine, grant
agent access to a personal profile, or change worker deployment lifecycle.

## Implementation

- Forward Chrome's native JPEG screencast during interaction, suppress identical
  frames, and request a lossless high-DPI PNG after 350 ms of inactivity. Full
  screenshot capture no longer precedes every input/paint. Preserve serialization
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

| Measurement | Baseline `56d1cb4` | Changed worker |
| --- | ---: | ---: |
| Input acknowledgement median | 317 ms | 11.8 ms |
| Input acknowledgement p95 | 464.1 ms | 32 ms |
| Workload duration | 21,996 ms | 3,466 ms |
| Output frames/s | 2.7 | 14.4 |
| PNG captures during interaction | 60 | 0 |
| Image data across the workload | 5,274 KiB | 1,180 KiB |

```sh
taskset -c 0,1 nice -n 10 node scripts/benchmark-shared-browser.mjs 56d1cb4
taskset -c 0,1 nice -n 10 node scripts/benchmark-shared-browser.mjs
```

An earlier, more heavily loaded baseline measured 1,140 ms median / 0.8 frames/s;
the first changed run measured 11 ms / 24.1 frames/s. Use the adjacent repeated
comparison above instead of selecting the largest improvement from those runs.

## Acceptance and publication

Five actual UI browser cases passed before the final queue-barrier refinement:
live input and all viewport presets, native direct preview, F5/Ctrl+R (Relay
survives), real clipboard shortcuts/toolbar, and denied/oversized paste. The
real personal extension first exposed idle refinement starvation from duplicate
native frames; after duplicate suppression its complete isolation/consent/
revocation/restart case passed. These intermediate results are not a claim of
final integrated acceptance; the final run and source checkpoint are recorded
below when complete.

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
