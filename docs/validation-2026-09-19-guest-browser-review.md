# Guest browser integration — independent review, not acceptance

The guest official MCP work remains outside the integrated candidate. This
review concerns the uncommitted work in `/tmp/relay-guest-official-browser-mcp`
(base `8a3283bf`); it is not a claim that production or PR4 contains that work.
The previous 31/32 compatibility result is not full acceptance.

## Publication blockers

1. **Queued mutations outlive authorization.** The special projected create,
   close, select and resize paths checked authority after awaiting the ordinary
   layout queue. Revoking the projection while that queue was occupied could
   therefore prevent the reply without preventing the action. Guards must run
   inside the queued callback and between native phases, retaining the exact
   target. Screenshot capture also needs a check after reading layout metrics.
   Already-dispatched commands cannot be retroactively cancelled; the required
   guarantee is that subsequent phases do not begin after revocation.
2. **Uncertain cleanup loses ownership.** An accepted projection open with a
   lost acknowledgement was not marked opened, so cleanup skipped it. A failed
   close was swallowed and could be reported as release success. Exact-ID
   cleanup must remain retryable, including when acquisition rejects before
   returning a lease. New acquisition must not silently adopt an orphan or
   restart the worker to hide an unconfirmed cleanup.
3. **Continuous events starve command admission.** `drainEvents()` waited for
   global quiescence, while the drain loop incorporated future events. A stream
   below all queue limits could keep both protocol commands and `beforeTool`
   waiting. The latter wait precedes the official tool-call deadline. The
   personal projection has the same queue pattern and also needs coverage.

The first two findings came from independent source review. The third was
reproduced against the actual exported `acquireGuestProjection` implementation,
using a real loopback WebSocket with synthetic worker, Playwright and authority
interfaces. No Chrome process, real account, profile or cloud worker was used.

The isolated proof passed **1/1**, exit 0, in 186 ms. Over 41 completed authority
validation rounds it emitted 2,561 events and delivered 2,413; the maximum
emitted-but-not-received count was 257, below the 1,024-entry bound. The lease
remained current, but admitted commands and `beforeTool` status reads both
remained zero. Stopping only the producer allowed both to advance immediately.
The passing proof demonstrates the defect, **not a passing fix**. Root reviewed
the complete proof source and result; the reviewer executed it, not root.

Required regressions include held-layout revocation, exact-target preservation,
open acknowledgement loss, failed close followed by confirmed retry, and
continuous events with finite FIFO barriers. Abort/overflow must settle barrier
waiters, not leave another indefinitely pending promise. Do not relax authority,
ordering, queue limits or timeouts to make these cases pass. Real guest and
personal compatibility must then be rerun before integration.

## Separate Claude native-agent evidence

An installed Claude process passed the isolated native-child capability smoke
on its second run (`63197`, `/tmp/relay-real-claude-agents-v2.log`). It actually
invoked the native Agent tool twice, produced distinct native child IDs,
forwarded correlated public child text, completed the parent while the second
child was active, acknowledged one child-only stop with a terminal event, and
continued the same parent session. Eight authored loopback model requests and
zero permission requests were observed. The first run failed because the
harness did not handle a native HEAD probe; that failure is retained by the
author, not presented as a native capability failure.

Both children had the same display name, but the first was already completed
when the second was stopped. This does **not** prove selection between two
simultaneously active children, native direct child messaging, live-provider
acceptance or the unfinished agents-panel UI. Root reviewed the full smoke
source and terminal log without rerunning it.

Production remains unchanged. None of these checks recovered the reported
stuck Claude chat, changed its queue, or authorized an environment restart.
