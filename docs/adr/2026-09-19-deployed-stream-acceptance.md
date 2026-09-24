# ADR: deployed transport proof without synthetic production identities

Status: client operator implemented; actual AWS results are recorded separately.

## Scope and existing topology

The current deployment uses CloudFront → VPC origin → private EC2 controller
port 8787, not an ALB. Its distribution disables caching/compression, forwards
all viewer headers/cookies/query parameters, and sets a 60-second origin read
timeout. Product SSE sends a heartbeat every 15 seconds. Those settings are
compatible with streaming, but configuration and localhost tests do not prove
the real AWS path.

[AWS supports WebSockets through VPC origins since May 1, 2026](https://aws.amazon.com/about-aws/whats-new/2026/05/amazon-cloudfront-websockets-vpc-origins/).
[Its WebSocket documentation](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html)
requires forwarding all viewer headers or the specific WebSocket headers and
uses HTTP/1.1 for the upgrade.
The template's origin policy `216adef6-5c7f-47e4-b989-5492eafa07d3` is the documented
[AllViewer policy](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html).

## Decision

Use only existing routes in `scripts/smoke-deployed-transports.mjs`. Do not add
diagnostic endpoints, invent Google identities, sign synthetic production
cookies, disable authentication or inject records into the production database.
Do not create a second distribution merely to demonstrate a different app's
streaming; that would not prove the deployed product path.

The default command is a no-network plan and does not read a cookie file:

```sh
taskset -c 0,1 nice -n 10 node scripts/smoke-deployed-transports.mjs
```

The explicitly executed anonymous probe uses the fixed deployed HTTPS origin:

```sh
taskset -c 0,1 nice -n 10 node scripts/smoke-deployed-transports.mjs --run
```

It checks three things:

1. `/readyz` returns the existing readiness receipt.
2. `/api/sidebar/events` refuses anonymous access with HTTP 401.
3. `/browser/connect` accepts its existing extension-protocol WebSocket upgrade.
   The client uses a syntactically valid, test-only extension Origin and sends
   `{ "type": "transport-probe" }`. This unsupported type is rejected **before**
   pairing lookup/deletion, connection records or browser actions. The operator
   requires HTTP 101, delivery of the client frame, the server's exact fixed
   authentication-error frame and the expected close code 1008/reason.

The third check proves a real TLS/WebSocket upgrade and bidirectional framing
through the deployed edge/origin. It does **not** authenticate an extension or
prove the authenticated Shared Chrome viewer. It creates no Google users,
connections, chats or browser processes and sends no model prompt. It never
sends a valid `pair` or `connect` request, invents a pairing code, or consumes an
existing pending pairing. No cookie is sent on that WebSocket or anonymous HTTP
requests.

## Protected SSE requires the user's real session

To obtain an actual SSE 200, the user must first finish normal Google sign-in
on the deployed Relay hostname. An operator may then provide a private local
file containing only the existing `__Host-relay.auth.sessionToken` cookie (or
its numbered fragments) as one Cookie header value, without the `Cookie:`
prefix. Do not paste it into chat, a command argument, a repository or a log.
Do not copy a browser profile or Google's own cookies. The file must be an
owner-private regular file, not a symlink, and no larger than 64 KiB.

```sh
taskset -c 0,1 nice -n 10 node scripts/smoke-deployed-transports.mjs --run \
  --cookie-file /absolute/private/path/relay-session-cookie
```

That mode sends the session cookie only to the fixed origin's existing
`/api/sidebar/events` route. It requires SSE 200, `text/event-stream`,
`no-transform`, an initial `sidebar_changed` event within ten seconds and a
later heartbeat in a separate delivery interval. Coalesced/static frames do
not pass. It waits at most 40 seconds and aborts/closes the stream afterward.
The file is checked unchanged; the operator never modifies, prints or copies
it. TLS certificate validation stays enabled and redirects are refused.

Receipts contain only statuses, booleans and timing. No cookie, identity,
response body or message content is retained or printed. Without a cookie,
SSE is explicitly reported as unverified, not inferred from the HTTP 401.
No login or provider account is authorized automatically.

## Remaining end-to-end gate

Even after both probes pass, authenticated live-browser rendering/input and
chat-event `Last-Event-ID` replay need a legitimate owner session and a selected
owned chat. `/api/chats/:id/browser/live` can start Chrome and wake a worker;
this operator deliberately does not call it. A separate user-authorized
browser test must exercise that behavior and its cleanup. The existing
`test/remote-streams.test.mjs` proves those application contracts with isolated
local Google fixtures, not with a real AWS account or real product session.

Neither an anonymous WSS result nor a separate disposable echo server may be
reported as full authenticated browser acceptance or MVP completion.

## Local checks

```sh
taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 \
  test/deployed-transports.test.mjs test/remote-streams.test.mjs
```

Fixtures exercise the existing product auth and extension-pairing handlers,
no mutation of pending pairings/users/chats, real local WebSocket framing,
private-file validation, delayed/coalesced SSE frames, wrong/expired sessions,
bounded output and cancellation. The operator has no AWS mutation API.
