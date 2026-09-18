# Trusted Relay-origin preview bootstrap

Status: implemented as a separately testable router module; end-to-end deployment
and real-browser acceptance are separate gates. No AWS resource or route is
activated by this module alone.

## Decision

Keep full application service-worker/PWA behavior. Do not put a redeemable
bootstrap ticket in a preview URL or a document controlled by the application.
The initially proposed preview → Relay → preview top-level nonce flow is not
sufficient: an application service worker could move an intercepted launch to
another browser, substitute that browser's challenge, and induce the victim's
Relay session to authorize it.

Instead, `PreviewBootstrap.start({binding,user,path})` returns a short-lived
**Relay-origin** launch URL. A GET requires the same actual authenticated owner
and login session. Its fixed CSP-constrained document performs:

1. Credentialed CORS POST to the exact assigned preview host's
   `/__relay_preview/challenge`. The response sets a per-launch Secure,
   HttpOnly, host-only browser nonce cookie and returns an opaque challenge.
2. Same-origin POST to `/api/app-preview/bootstrap`. Actual login, owner,
   session, runtime generation and host assignment are checked again. The
   matching challenge authorizes one server-held ticket, returned only to the
   trusted Relay document.
3. Credentialed CORS POST to preview `/__relay_preview/exchange`. It must supply
   that ticket **and** the exact HttpOnly browser nonce cookie. Only Set-Cookie
   delivers the distinct preview grant; JSON never returns it.
4. A credentialed `/__relay_preview/probe` must observe that exact new grant,
   not an unrelated existing cookie. Only then does the document navigate to
   the app's original path/query/fragment, without a ticket in the URL.

The service-worker [Handle Fetch algorithm](https://w3c.github.io/ServiceWorker/#handle-fetch)
selects the initiating client's controller for subresource fetches. A preview
app's worker does not control fetch initiated by a Relay-origin document. This
is the distinction from a navigation to a preview-origin bootstrap document;
it requires real-browser regression coverage, not just HTTP unit tests.

## Privacy/browser limitation

Both preview cookies use `SameSite=None; Secure; HttpOnly`. Browser policies
that block cross-site cookies may prevent this exchange. The page explicitly
reports that possibility and fails closed; it does not retry through an
interceptable navigation, disable service workers, or fall back to an URL
bearer. No existing cookie is cleared on failure. Compatibility is not claimed
for every browser or privacy setting. The [Fetch credentials/CORS model](https://fetch.spec.whatwg.org/#http-cors-protocol)
and [cookie HttpOnly attribute](https://httpwg.org/specs/rfc6265.html#http-only-attribute)
remain enforced; application code already controls its own same-origin content
and ambient app requests, but does not receive Relay/provider credentials or a
readable preview grant.

## Integration contract

- Constructor: `{relayOrigin,grants,lookupHost,isCurrent,authenticate}`.
  HTTPS Relay origin is operator-owned. `authenticate(request)` returns actual
  `{id,sessionId,expiresAt}` or null; expiry is epoch milliseconds.
- `handleRelay(request,response,url)` owns `/app-preview/open` and
  `/api/app-preview/bootstrap`; it authenticates internally even if dispatched
  before the normal API handler. `handlePreview` owns only `/__relay_preview/`.
  The outer dispatcher must never fall through from a preview hostname to
  Relay static/API content.
- `lookupHost` and `isCurrent` are synchronous controller-owned guards. Before
  app proxy admission, the caller additionally revalidates the saved login
  session and allowed user asynchronously, then calls `authorize` again.
- `authorize(request,hostname)` returns the existing immutable grant lease.
  Grant lifetime remains at most five minutes, without silent renewal.
- `revokeOwner`, `revokeSession(ownerId,sessionId)`,
  `revokeChat(ownerId,chatId)`, `revokeHostname`, and `close` invalidate pending
  flows and grants. Expiry/revocation aborts grant lease signals. Pending body
  reads are flow-bound, capped at 32 globally/4 KiB/5 seconds, and interrupted
  when that flow is revoked. The server must still count handler activity for
  deployment drain and bound its injected authentication operation.
- Launches are memory-only, at most 60 seconds, capped globally and per owner.
  Nonces are per launch so tabs cannot overwrite another launch's challenge.
  Headers/body launch IDs must match, and no caller-provided hostname selects
  authority. Restart restores neither flows nor grants.
- The proxy reserves the complete `__Host-relay-preview-` cookie prefix as
  well as `__Host-relay-preview`, in both request and response directions.

Tests use synthetic users and local fixtures only. They are not evidence of
Google/provider consent, deployed CloudFront forwarding, or MVP completion.

## Real-browser fixture receipt

`taskset -c 0,1 nice -n 10 node scripts/smoke-preview-bootstrap-mcp.mjs`
passed through the official Playwright MCP with isolated Chrome and two distinct
HTTPS sites on loopback. A root-scope hostile service worker first demonstrably
intercepted a same-origin bootstrap-path control request, then remained active
during initial and repeated successful opens from Relay without intercepting
their CORS bootstrap requests. Original path/query/fragment and HttpOnly grant
invisibility passed. Chromium's actual third-party-cookie restriction then
caused the explicit fail-closed privacy explanation, without navigating to the
app. TLS keys, cookies, users and hostnames were disposable fixtures; no provider
consent, model prompt or AWS call occurred. This proves the browser mechanism,
not deployed CloudFront/session/runtime integration.
