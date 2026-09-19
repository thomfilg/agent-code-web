# Remote app previews on a separate browser origin

Status: **implemented behind explicit configuration; deployed acceptance is a
separate gate**. Controller routing, durable owner/chat/port host assignments,
trusted-Relay bootstrap, Open app UI and lifecycle revocation are integrated.
The [integrated local browser fixture](../preview-ui-acceptance.md) covers their
combined HTTP/SSE/WebSocket flow; it is not AWS or real-consent evidence. This
ADR authorizes no AWS mutation and does not close gate 45.

The original fragment-ticket bootstrap and proposed PWA restriction below are
superseded by the [browser bootstrap decision](2026-09-18-preview-browser-bootstrap.md).
The user selected the [no-custom-DNS host lifecycle](2026-09-18-preview-host-lifecycle.md).
See [operating limits and rollback](../app-preview-operations.md),
[grant contracts](../preview-grants.md),
[TCP transport](2026-09-19-worker-local-tcp-foundation.md) and
[proxy boundaries](2026-09-19-worker-preview-proxy-foundation.md). The older
component ADRs describe what each primitive alone does, not current integration
or deployment status. Actual receipts remain in the [feature queue](../feature-queue.md)
and [AWS operations](../aws-deployment.md).

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

The original alternatives were:

1. **Custom DNS, not selected:** one preview distribution plus a dedicated wildcard preview
   domain and TLS certificate, with a stable random hostname per chat/port.
   CloudFront requires a certificate covering the alias and DNS control; it
   does not give us arbitrary subdomains under its generated distribution
   hostname. See [alternate-domain requirements](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/CNAMEs.html)
   and [distribution certificates](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesGeneral.html).
2. **Selected: no custom DNS:** a separate generated CloudFront distribution hostname per
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

## Implemented design and superseded proposal

- The authenticated Relay UI offers **Open app** for an explicit localhost port
  and path. A same-origin POST checks owner, chat, selected VM and permitted
  port; it never accepts an arbitrary target hostname or controller address.
- The original preview-origin fragment-ticket proposal is **not implemented**.
  Relay returns its own authenticated launch document instead. Credentialed
  CORS requests bind a one-use ticket to an HttpOnly nonce in that browser;
  a probe verifies the new grant cookie before navigating to the original app
  path/query/fragment. Neither app URLs nor app documents receive the ticket.
  Open with noopener/noreferrer; never place Relay/provider credentials in a link.
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
  launcher carries the tested TCP bridge/proxy framing. Admission and lifecycle
  are wired by [AppPreviews](../../src/app-previews.mjs); deployed acceptance
  remains distinct from local integration coverage.
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

## Bootstrap threat model and acceptance

### Superseded bootstrap/service-worker proposals

A reserved bootstrap URL on the application's own origin is not sufficient to
keep that bootstrap trusted. A previously installed root-scope service worker
can intercept a later navigation to that path, supply its own document/script,
and read the new bootstrap fragment. Never reusing a hostname across chats or
owners prevents cross-chat origin reuse, but does not address this repeat-open
case within the same chat. See the [service-worker fetch handling
model](https://w3c.github.io/ServiceWorker/#handle-fetch).

Threat-model clarification (2026-09-18): with a permanently assigned
owner/chat/port origin and correct revocation, that interception is not by
itself a cross-user, cross-chat or cross-port authority leak. The application's
scripts and service worker already control that origin's documents and can make
its authenticated app requests. The distinct risk in the old proposal was exporting the
single-use bootstrap bearer to another browser before redemption, giving that
browser the same scoped access until expiry/revocation. `PreviewGrants` binds
Relay session metadata but does not authenticate the redeeming browser. This
is not evidence of Relay/provider credential exposure. The implemented
[PreviewBootstrap](../../src/preview-bootstrap.mjs) adds the browser binding;
`PreviewGrants` alone still does not provide it. No same-origin app-script
secrecy is promised.

The historical suggestion to reject `Service-Worker: script` requests was not
selected and is **not an operating requirement**. PWA/service-worker behavior
is preserved. Merely reserving a URL or stripping `Service-Worker-Allowed`
would not make an app-origin document trustworthy.

The selected flow runs its bootstrap document on Relay's trusted origin, which
the app's service worker does not control. A real isolated Chrome fixture
proved first/repeated opens with an active hostile root worker and a positive
same-origin interception control. Actual cross-site-cookie blocking produced
the explicit fail-closed message. See the browser-bootstrap ADR for that receipt
and its privacy limitation; do not infer this proof from HTTP unit tests.
Deployed host routing, lifecycle and multi-owner negative/positive acceptance
still require separate receipts before gate 45 can close.

This is a bounded security-sensitive feature, not just adding a distribution.
It has four implementation units: (1) grant/host lifecycle and isolated routing,
(2) HTTP/SSE/WS SSH bridge, (3) UI open/revoke plus worker-presence integration,
(4) deployment configuration and adversarial/end-to-end acceptance. The no-DNS
per-preview-distribution option adds a fifth unit: the persistent provisioning/
cleanup state machine and its operator IAM requirements. These units now exist;
deployment latency and actual acceptance do not follow from fixture coverage.

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

## Selected no-DNS lifecycle

No domain purchase/registration is proposed or authorized. The selected design
uses a fixed forwarded port for each generated hostname. Ports
inside one chat VM can share its trust boundary, but one hostname still cannot
transparently route simultaneous root-relative apps on different ports without
an unambiguous routing mechanism. A single mutable port cookie would silently
retarget older tabs. Use another hostname for another concurrently forwarded
root app. Multiple assignments are supported within explicit caps.
Every grant must still bind the exact port.

Implemented lifecycle contract (see the host-lifecycle ADR for exact guards):

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
   CloudFront IAM cannot distinguish tagging during creation from standalone
   tagging like EC2's CreateAction condition can. The accepted trusted-controller
   boundary is explicit in the host-lifecycle ADR: application ownership checks
   are mandatory, not an IAM sandbox against a compromised controller. Tags alone
   do not encode browser identity or constrain every configuration field.
4. Persist distribution ID/hostname/ETag and never accept a browser-provided
   distribution ID as authority. Recheck deployment, purpose, chat and owner
   before any mutation. Explicitly deny Relay's own distribution ARN. Never
   recycle a preview hostname across different chats/users.
5. On deletion, revoke grants/close bridges immediately, then asynchronously
   disable, wait for deployment and delete using the current ETag. Controller
   restart and partial AWS failure must resume cleanup without leaking active
   hostnames or deleting a foreign resource. Enforce preview/quota limits and
   report useful pending/failed/retry states without exposing credentials.

The original **6–10 focused engineering hour** estimate was planning context,
not an AWS latency guarantee or completion receipt. Keep gate 45 explicitly
open until required deployed negative/positive tests pass; neither a second
distribution nor the completed local fixture alone establishes that.

### Read-only account inventory — 2026-09-18 10:25 UTC

Using the authorized `code-web` profile, CloudFront listed five distributions
in the account. Exactly one uses Relay's existing VPC origin
`vo_4Fp0yW32vpmGPSJWgmyW9i`: Relay's own distribution `E2FQ8W4AL72G7G`.
No preview distribution was created, adopted, changed or removed by this check.
Do not treat the other four distributions as available preview resources.

Service Quotas' default-value API returned 500 web distributions per account
(`L-24B04930`) and 50 distributions per VPC origin (`L-947322B3`, marked
non-adjustable). Its account-applied quota list returned no entries, so this
receipt does **not** establish an effective account quota or reserve capacity.
Recheck inventory and effective limits before provisioning; never derive an
unconditional create budget by subtracting this snapshot from a default value.
