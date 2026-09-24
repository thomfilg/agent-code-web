# Dormant worker-local TCP transport foundation

Status: transport primitive only; **remote app previews remain unavailable**.
Gate 45 is still open. This does not choose/provision a preview origin, add a
listener/route, mint a capability, authorize a port, import credentials or change
SSH forwarding/IAM. The parent [preview design](2026-09-19-remote-app-preview-design.md)
still requires its complete security, lifecycle, UI and deployed acceptance work.

`openWorkerTcp(executor, { port, signal, connectTimeoutMs, idleTimeoutMs,
maxLifetimeMs })` returns a Node `Duplex` with an awaitable `ready` promise and a
`connect` event. Attach an `error` listener before use. The caller must supply an
already-authorized, current chat executor; this function does not acquire one or
check user/chat grants. The sole destination is literal IPv4 `127.0.0.1` inside
that executor's worker, on an integer port between 1024 and 65535. Hostnames,
URLs, environment variables, command text and unknown options are rejected.
Future grant policy must separately decide which application ports are allowed.
Loopback belongs to the supplied executor's network namespace. A future public
preview route must verify the exact owned remote executor; it must never accept
a controller-local executor or a caller-supplied executor from an HTTP request.
Local spawning here is solely an offline test fixture, not remote admission.

The existing executor launches a fixed `/usr/bin/node` program. On EC2, its fixed
source/configuration follows the existing private stdin launcher framing; no
request bytes or per-connection configuration are appended to SSH argv. SSH
identity/host verification, heartbeat and remote process cleanup remain owned
by the existing executor/launcher. No `-L`, `-R`, `-D`, `-W`, shell concatenation
or relaxed SSH option is introduced. The bridge receives an empty environment
(apart from the executor's own controlled PATH) and needs no provider tokens.

The worker independently validates a bounded, exact-schema JSON configuration
line, then treats stdin as application bytes; its EOF half-closes the TCP write
side. Downstream uses private binary framing: one ready frame, nonempty data
frames of at most 64 KiB, and one readable-EOF frame. The controller strips all
framing. This is necessary because the outer SSH launcher keeps stdout open
until its child exits: server FIN must be delivered while the client can still
write. Invalid order/types/lengths, truncated frames and premature process exits
are errors, never application data. There is no HTTP parsing or header rewriting
in this primitive, and it is a Duplex rather than a full `net.Socket` API.

Pipe/stream backpressure stops TCP reads when downstream cannot drain. The
controller uses a 64 KiB stream high-water mark and bounds its private parser
buffer to 192 KiB; callers must honor normal Node writable backpressure.
Defaults are 15 seconds to connect, 60 seconds idle and 5 minutes total lifetime.
Both sides enforce limits; configured maxima are 30 seconds, 5 minutes and
15 minutes respectively. These intentionally bound long-lived sockets; future
preview lifecycle work must choose policy explicitly, not silently remove them.

Cancellation destroys this connection and terminates only its own child, with
SIGKILL escalation after two seconds. The existing remote launcher controls its
own worker process group. Stream closure waits for observed child closure, with
a five-second observation deadline after destruction begins. `cleanupConfirmed`
is true only once the owned child closed (or no child was launched); a missed
deadline reports the fixed `cleanup-unconfirmed` error and false rather than
claiming cleanup or waiting forever. For EC2, the observation is closure of the
local SSH child, **not an independent remote-process audit**. Remote cleanup
still relies on the existing SSH launcher and heartbeat/watchdog behavior. Cancellation
may discard buffered application bytes, unlike normal full or half-close flow.
Diagnostics use fixed codes and never echo upstream data, stderr or configuration.

Offline tests cover binary passthrough, both half-close directions through the
actual SSH launcher, HTTP upload/path/streaming response, WebSocket upgrade and
binary frames, slow readers/writers, cancellation under backpressure, isolation
from another live connection, timeouts, malformed/fragmented framing and child
failures. All servers are disposable loopback fixtures, not real providers or a
browser. No real SSH connection or AWS execution is claimed.

```bash
taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 test/worker-tcp-bridge.test.mjs test/ssh-worker-launcher.test.mjs
```

Before this can serve a real preview, the future isolated router must strip
Relay/preview credentials, constrain cookies/redirects/Host/Origin, bind each
connection to an exact owner/chat/port/executor generation, cancel on revocation,
enforce HTTP limits and prove deployed HTTP/WS plus cross-chat origin isolation.
This primitive deliberately does none of those higher-layer actions.
