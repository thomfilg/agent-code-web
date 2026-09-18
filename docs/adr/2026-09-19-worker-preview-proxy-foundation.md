# Dormant worker HTTP/SSE/WebSocket proxy foundation

Status: independently testable internal component, **not an available remote
preview feature**. There is no public route/listener, grant creation, domain,
CloudFront or IAM change. The full [preview design](2026-09-19-remote-app-preview-design.md)
and gate 45 remain open, including origin lifecycle, UI and deployed acceptance.

## Contract and authority

The module exports proxyWorkerHttp(request, response, { executor, lease })
and proxyWorkerUpgrade(request, socket, head, { executor, lease }).
createWorkerPreviewProxy({ limits }) creates an independent policy instance;
limits may only be lowered from the defaults. They are trusted operator policy,
never parsed from an HTTP request.

The caller must first admit a current owner/chat/exact-worker-generation grant
and resolve its matching remote executor. The lease contains a frozen binding
with the canonical public hostname, worker-local integer port, ownerId and
chatId (the grant service's bounded primitive ID grammar), plus a
revocation signal. This component does not authenticate, acquire/resume workers,
look up a user, decide allowed ports or verify executor ownership. A frozen
object is not proof of authorization. Neither lease nor executor may come from
untrusted request data. Local spawning exists only in offline tests.

The request Host must match that exact assigned hostname. An Origin, when
present, must be its canonical HTTPS origin; missing Origin is permitted for
ordinary top-level navigation. Caller routing must never reuse a hostname across
chats/users, map unknown hosts, serve Relay APIs on preview origins, or accept a
controller-local executor. Those requirements are not solved by this module.

Only the reviewed openWorkerTcp primitive chooses a network destination:
127.0.0.1 and the granted port inside the executor. The private one-use HTTP
Agent never resolves a hostname. No SSH forwarding, shell interpolation,
provider/account access or environment inheritance is introduced.

## HTTP and credential boundaries

Original origin-form path/query and streamed request/response bytes are retained.
Absolute/authority targets, backslashes/control characters, ambiguous framing,
unsupported methods and Expect are rejected. CONNECT/TRACE are unavailable.
SSE is flushed as it arrives. Compression is transported without decompression;
byte limits measure encoded transport data, not expanded application content.
Trailers and hop-by-hop semantics are not relayed.

Incoming Forwarded/X-Forwarded/X-Real-IP, Proxy-Authorization, reserved Relay
capability headers and all Connection-nominated hop headers are removed.
Canonical Host and X-Forwarded-Host are regenerated from the binding;
X-Forwarded-Proto is https. No client IP is invented. Apps must configure their
allowed/public hostname and HMR endpoint; there is no HTML/JavaScript URL rewrite.

Ordinary application Basic/Bearer Authorization is preserved: it is not Relay
cookie authority. The recognizable Relay Bearer cap_ format is an exception
and is removed, including valid HTTP spaces/tabs after Bearer. Requests never
forward these platform cookie names:

- __Host-relay-preview
- agent_web_session, relay_browser_identity, relay_mcp_*
- relay.auth.*, __Host-relay.auth.*, including chunk suffixes

The same names cannot be set by the upstream application. Other app cookies
remain scoped to this preview host; Domain is removed only if it names the exact
assigned host or localhost/127.0.0.1. Broader, foreign or duplicate Domain
attributes cause that cookie to be dropped. Emitted cookies are Secure and
host-only; invalid __Host- paths are rejected. Clear-Site-Data is not relayed.
The trusted router must keep its bootstrap/auth namespace separate from app
routing; this component does not itself provide service-worker/bootstrap safety.

Relative redirects and ordinary external HTTPS navigation remain intact.
Absolute localhost/127.0.0.1/IPv6-loopback redirects are rewritten only when their
port exactly matches the grant, to the assigned HTTPS hostname. Local port
hopping, credentials in URLs, non-HTTPS external redirects and unsafe syntax
fail closed. The proxy never follows redirects on the controller.

## WebSocket and lifecycle

Only the RFC 6455 version-13 handshake is accepted. The upstream accept hash and
chosen offered subprotocol must match. Extensions are disabled on both sides,
so there is no compression negotiation or decompression in the proxy. Once
upgraded, masked/unmasked application frames are relayed as binary bytes, not
reinterpreted. Initial upgrade-head bytes count toward limits and are bounded.
Client and upstream half-closes use the underlying Duplex; source EOF does not
destroy a slow client's still-buffered final response.

Defaults: 32 MiB request bodies, 256 MiB HTTP responses and 256 MiB per direction
for a WebSocket connection; 15-second connection, 30-second response-header,
60-second idle and five-minute total deadlines. Stream backpressure applies in
both directions. A body already partially forwarded before exceeding a streaming
limit cannot be undone; clients must inspect potentially submitted app mutations
before retrying, just as after any interrupted network operation.

A synchronous pre-spawn reservation shares counts across every factory instance
in this module: at most 32 active requests/bridges, 12 per owner and 8 per
(owner, chat). Overload returns fixed 429 without starting a child. A policy may
lower these ceilings; there is no admission queue. Counts span HTTP and WS and
remain held until cleanup settles. Eight per chat allows typical six parallel
asset loads plus long-lived connections, but browser-load tuning still needs
real integrated evidence before deployment. Multiple owners have separate
per-owner capacity; the global bound still limits total controller resources.

Lease revocation, client disconnect, timeout and transport failure cancel the
exact upstream request/bridge; another lease is unaffected. Rejections with an
unconsumed body use the shared post-response-flush close guard. A denied raw
upgrade flushes its fixed response then closes that exact socket, including
clients deliberately retaining their writable half. Errors expose only fixed categories and
generic public bodies, never upstream errors or stderr. Application response
content is intentionally passed to its authorized viewer, not logged by this
module.

The awaited result is a frozen { ok, code, cleanupConfirmed } transport receipt,
not evidence of application semantics or remote deployment. Cleanup waits for
the primitive's bounded observed-child result; an unconfirmed cleanup cannot
return ok: true. For EC2 this is local SSH-child observation, not an independent
remote-process audit. The caller must retain the admission lease until the
returned promise settles, then release it according to the grant service.
Unconfirmed cleanup retains the module's capacity reservation fail-closed rather
than admitting unbounded additional possibly-live children. Operator recovery
must confirm cleanup before controller restart resets those in-memory counts.
Future lifecycle callers must abort both any admission queue they add and every
open stream on revocation; this foundation creates no queue or lease itself.

## Verification and remaining gates

Offline fixtures use actual Node processes, the existing SSH launcher protocol,
native HTTP and WebSocket clients/servers on loopback only. They cover raw paths,
binary uploads, streaming SSE, credential/header stripping, cookie boundaries,
redirects, incomplete denied requests, body/deadline limits, revocation,
WebSocket upgrades/binary/subprotocols, malformed acceptance and slow final output.
No browser, real SSH/AWS connection, model or provider account is used.

The final proxy suite passed 17/17 independently, including half-open server
socket observation, per-owner/chat/global admission and unconfirmed-cleanup
capacity retention. The combined pre-close-guard component run passed 38/38
(17 proxy plus 21 transport/SSH); the final close-guard change was then rechecked
by the full independent 17-test proxy suite. This is component evidence only.

    taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 test/worker-preview-proxy.test.mjs test/worker-tcp-bridge.test.mjs test/ssh-worker-launcher.test.mjs

Still required: grant/executor admission and release integration; unique durable
preview-origin provisioning/routing; trusted bootstrap/cookie lifecycle; UI;
multi-user hostile-app/service-worker tests; and a complete deployed HTTP/SSE/WS
round trip. This component must not be presented as satisfying those gates.

References checked: [Node HTTP client/upgrade and Agent contracts](https://nodejs.org/api/http.html),
[HTTP hop-by-hop semantics](https://www.rfc-editor.org/rfc/rfc9110.html),
[WebSocket handshake](https://www.rfc-editor.org/rfc/rfc6455.html) and
[cookie Domain behavior](https://www.rfc-editor.org/rfc/rfc6265.html).
