# Remote app previews on a separate browser origin

Status: **proposal only**, not implemented or deployed. Gate 45 (HTTP and
WebSocket app forwarding) remains open. No AWS mutation is authorized by this
document. The existing browser-link helper only constructs local aliases; there
is no reusable HTTP/WebSocket forwarding module in this repository.

## Feasibility and the origin decision

CloudFront VPC origins support WebSockets as of
[1 May 2026](https://aws.amazon.com/about-aws/whats-new/2026/05/amazon-cloudfront-websockets-vpc-origins/).
The existing private-worker topology can therefore support remote HTTP and WS
without exposing workers publicly or enabling general SSH TCP forwarding.

A second distribution separates preview content from Relay. However, putting
all chat apps on **one** second hostname, even under random paths, does not
isolate those apps from each other. Browser origins are scheme/host/port; paths
are not an origin boundary. Cookies, localStorage, service workers and same-origin
requests remain cross-chat risks. COOP/noopener is useful defense in depth, not
a replacement for that separation. This follows directly from the
[HTML origin and opener-policy model](https://html.spec.whatwg.org/multipage/browsers.html#same-origin).

Choose one of these before implementation:

1. **Preferred:** one preview distribution plus a dedicated wildcard preview
   domain and TLS certificate, with a stable random hostname per chat/port.
   CloudFront requires a certificate covering the alias and DNS control; it
   does not give us arbitrary subdomains under its generated distribution
   hostname. See [alternate-domain requirements](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/CNAMEs.html)
   and [distribution certificates](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesGeneral.html).
2. **No custom DNS:** a separate generated CloudFront distribution hostname per
   chat/port. This is technically possible but adds distribution provisioning,
   deployed-state waits, retention/cleanup and scope checks to the runtime
   lifecycle. It is not a single second distribution. Current default quotas
   include 500 distributions/account and 50 distributions per VPC origin;
   see [CloudFront quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html).

A single shared preview hostname with one active chat is not a safe multi-user
substitute: an older tab/service worker on that hostname could reach a newly
authorized chat. Do not recycle a hostname across unrelated chats/users. A
sandboxed opaque-origin wrapper would break ordinary app cookies/storage and
does not satisfy the requested direct, fully functioning app URL.

## Bounded proposed MVP

- The authenticated Relay UI offers **Open app** for an explicit localhost port
  and path. A same-origin POST checks owner, chat, selected VM and permitted
  port; it never accepts an arbitrary target hostname or controller address.
- Relay returns a preview-host bootstrap URL with a short, single-use random
  ticket in its fragment. The fixed trusted preview bootstrap exchanges it
  through its own origin, removes the fragment and navigates to the original
  path. Open with noopener/noreferrer; never place Relay cookies or a provider
  token in the link.
- The preview origin sets its own short-lived, Secure, HttpOnly, host-only
  cookie. The server-side grant binds owner/current login, chat, port, exact
  preview hostname and lifecycle generation. It is neither a public permanent
  URL nor a bearer that chooses arbitrary destinations.
- A separate preview listener/router serves only bootstrap and authenticated
  worker traffic. It cannot expose Relay API/static content just by requesting
  `/api/...` on the preview hostname. Unknown hosts fail closed.
- For each upstream connection, acquire the selected chat's existing executor
  and run a fixed Node TCP bridge over SSH to **127.0.0.1 and the granted port**.
  Use a custom Duplex for Node HTTP proxying/upgrades; never run user request
  strings as shell commands or enable SSH port forwarding. The hardened SSH
  launcher can carry the framing, but the TCP bridge/proxy still needs building.
- Keep streaming/backpressure for HTTP, SSE, uploads and WebSocket upgrades.
  Strip the preview-auth cookie and all Relay/provider credentials before the
  app receives a request. Preserve app cookies only within that preview host;
  reject/rewrite broader Domain attributes and reserved auth-cookie names.
  Strip spoofable forwarded/hop headers; construct only the explicit upstream
  host and trusted forwarding metadata.
- Preserve original paths/query strings and rewrite redirects only when they
  target the selected worker-local origin. Do not rewrite arbitrary HTML/JS.
  Apps with hard-coded localhost/WS ports or OAuth callbacks must configure
  their public origin/HMR endpoint for the preview URL; a generic proxy cannot
  transparently repair arbitrary application configuration.
- HTTP activity and active WebSockets hold a bounded worker lease. Stop,
  deletion, logout/account-scope changes, grant expiry and controller restart
  revoke grants and close bridges. A stale browser request cannot silently
  fall back to another worker, chat or port. No model prompt is needed to open
  or reconnect a preview.
- Disable CloudFront caching/compression for proxy behavior; forward required
  upgrade and application headers. AWS documents the WebSocket handshake
  requirements [here](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html).

## Work and acceptance estimate

### Unresolved bootstrap/service-worker boundary

A reserved bootstrap URL on the application's own origin is not sufficient to
keep that bootstrap trusted. A previously installed root-scope service worker
can intercept a later navigation to that path, supply its own document/script,
and read the new bootstrap fragment. Never reusing a hostname across chats or
owners prevents cross-chat origin reuse, but does not address this repeat-open
case within the same chat. See the [service-worker fetch handling
model](https://w3c.github.io/ServiceWorker/#handle-fetch).

The smallest proposed initial policy is to start only on fresh origins and
explicitly reject application service-worker script requests (the browser's
`Service-Worker: script` request), across all proxy paths and methods, before
upstream forwarding. This would intentionally exclude app service-worker/PWA
registration from that first preview version; it is a product limitation that
must be accepted and documented, not silently introduced. Keeping a bootstrap
path out of app routing or stripping `Service-Worker-Allowed` alone is not a
substitute. If service workers must work, design and review a bootstrap that
cannot be intercepted by the app's worker instead.

This is an unresolved design and real-browser acceptance gate: there is no
active route or service-worker restriction in this ADR or the dormant proxy.
Before activation, verify first/repeated opens, script-request rejection and
redirect variants, hostile root-scope registration attempts, reserved bootstrap
handling, logout/expiry and two-user/two-chat isolation in real Chrome. Do not
claim that bootstrap cookies or service-worker safety follow from the tested
HTTP/WebSocket transport alone.

This is a bounded security-sensitive feature, not just adding a distribution.
It has four implementation units: (1) grant/host lifecycle and isolated routing,
(2) HTTP/SSE/WS SSH bridge, (3) UI open/revoke plus worker-presence integration,
(4) deployment configuration and adversarial/end-to-end acceptance. A reasonable
engineering estimate is multiple focused implementation/review sessions, with
additional AWS/DNS/certificate deployment time; not a small patch to the existing
local-alias helper. The no-DNS per-preview-distribution option adds a fifth,
larger provisioning/cleanup state machine and broader operator IAM requirements.

Required tests before closing gate 45:

- Original app path, assets/root-relative routes, POST/upload, redirects,
  streaming SSE and real WS/HMR messages in an ordinary external Chrome tab.
- Distinct users and two simultaneous chats cannot read each other's cookies,
  storage, HTTP content or WS; guessed/stale/expired/replayed grants fail.
- No Relay cookie or preview-auth cookie reaches a worker; app `Set-Cookie`,
  redirects, Host/Origin spoofing and service-worker registrations cannot cross
  the assigned origin. No destination can reach controller/metadata/VPC IPs.
- Slow consumer/backpressure, upstream crash, half-close, body limits and idle
  timeout do not hang the controller or keep a VM alive forever.
- Worker stop/resume preserves the intended app workspace while preview grants
  remain correctly revoked or reissued; explicit Stop closes active bridges.
- One complete deployed CloudFront HTTP and WS round trip after all fixture
  tests, not merely a locally passing reverse-proxy test.

## No-DNS option: per-chat CloudFront lifecycle estimate

No domain purchase/registration is proposed or authorized. If the no-DNS option
is chosen, start with a fixed forwarded port for each generated hostname. Ports
inside one chat VM can share its trust boundary, but one hostname still cannot
transparently route simultaneous root-relative apps on different ports without
an unambiguous routing mechanism. A single mutable port cookie would silently
retarget older tabs. Use another hostname for another concurrently forwarded
root app, or explicitly restrict the first MVP to one fixed port per chat.
Every grant must still bind the exact port.

Needed additional lifecycle:

1. Persist a unique create intent/caller reference before the AWS request; lock
   per chat/port to prevent duplicate distributions. Reconcile timeout/restart
   by the saved reference and verify account, exact existing VPC-origin ID,
   immutable preview config and ownership tags before adopting a result.
2. Create with deployment/preview-purpose/chat/owner tags. The UI returns an
   asynchronous pending state, displays creation/deployment progress and does
   not mint an app grant before AWS reports the distribution deployed. Expect
   minutes on first use; do not hold a browser API request open for that wait.
3. Allow only the existing VPC-origin read; no VPC-origin or DNS/certificate
   mutation. `CreateDistributionWithTags` authorizes `CreateDistribution` plus
   `TagResource`. Creation supports request-tag conditions; subsequent reads,
   updates and deletion support resource-tag conditions. See the
   [API](https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_CreateDistributionWithTags.html)
   and [IAM action/condition table](https://docs.aws.amazon.com/service-authorization/latest/reference/list_cloudfront.html).
   The exact create/tag policy still needs a negative IAM test: permission to
   tag during creation must not let the controller adopt an unrelated untagged
   distribution. Application ownership checks are mandatory too; tags alone
   do not encode the browser user's identity or constrain every config field.
4. Persist distribution ID/hostname/ETag and never accept a browser-provided
   distribution ID as authority. Recheck deployment, purpose, chat and owner
   before any mutation. Explicitly deny Relay's own distribution ARN. Never
   recycle a preview hostname across different chats/users.
5. On deletion, revoke grants/close bridges immediately, then asynchronously
   disable, wait for deployment and delete using the current ETag. Controller
   restart and partial AWS failure must resume cleanup without leaking active
   hostnames or deleting a foreign resource. Enforce preview/quota limits and
   report useful pending/failed/retry states without exposing credentials.

Estimate: **6–10 focused engineering hours** for the one-fixed-port version,
including local adversarial lifecycle/streaming tests and independent review,
plus deployment/real-browser acceptance time. This is an estimate, not an AWS
latency guarantee. Supporting multiple simultaneous root apps per chat adds
host provisioning and UX work. With roughly four hours left while AMI/native
authentication acceptance is still running, treating this as a safely finished
feature would be high risk. Keep gate 45 explicitly open unless the complete
implementation and deployed negative/positive tests actually pass; do not count
a second distribution alone as completion.
