# Remote app preview operations

This describes the integrated implementation and its limits, not a real AWS
acceptance receipt. Consult the [feature queue](feature-queue.md) and
[AWS deployment record](aws-deployment.md) for the exact active revision, image,
configuration and observed cloud results. Local fixtures do not establish
Google/provider consent or an authenticated deployed round trip.

## Open and reconnect

In an owned EC2 chat, choose **Open app**, enter the HTTP app's worker-local port
(1024–65535) and a path beginning with `/`, then explicitly set up its address.
Setup can take several minutes. **Ready** means the address is provisioned, not
that the app is listening. Open can start/resume a worker and incur AWS cost;
it does not submit an agent prompt or authorize a provider account.

Each owner/chat/port has a separate generated HTTPS hostname. Another port
requires another assignment; paths do not select another worker or port. Polling
does not provision or mint access. Closing the dialog does not cancel provisioning.
Default live assignment limits are 8 per deployment, 4 per owner and 2 per chat;
pending, error and revoking assignments also count. See the
[UI contract](remote-app-preview-ui.md) and [host lifecycle](adr/2026-09-18-preview-host-lifecycle.md).

Access lasts **at most five minutes**, without silent renewal. Expiry, Stop,
logout, chat deletion or controller restart revokes access and closes live
bridges. Return to Relay and open again; copying an app URL does not grant
another browser access. Revoking an address denies access immediately, while
CloudFront disable/delete may take minutes. A later setup gets a new hostname;
old assignments are never reused across owners/chats/ports.

Bootstrap requires cross-site cookies for Relay and the preview site. Browsers
that block them receive an explicit failure; there is no less-secure URL-token
fallback. Decide whether to allow those cookies for these sites, then reopen.
The mechanism preserves service workers/PWAs, but does not promise compatibility
with every privacy policy. Its one-use ticket never enters an app URL/document;
the distinct grant is an HttpOnly, Secure, host-only cookie. See the
[trusted-origin bootstrap decision](adr/2026-09-18-preview-browser-bootstrap.md).

## Configure the app

- Serve **HTTP**, reachable on `127.0.0.1` at the selected port inside that chat's
  worker. This is not arbitrary TCP or a TLS-upstream tunnel.
- Allow the exact generated preview hostname in the app/dev server's allowed
  hosts. Upstream `Host` and `X-Forwarded-Host` are that hostname;
  `X-Forwarded-Proto` is `https`. Configure public HTTPS URLs, WSS/HMR host and
  client port 443, and any application OAuth callbacks accordingly. Do not
  disable host checking globally to make one preview work.
- Paths and query strings are forwarded without a proxy prefix. Fragments stay
  in the browser. No HTML/JavaScript rewriting repairs hard-coded localhost
  links. Only redirects to the selected localhost port are rewritten to the
  preview origin; other local ports and non-HTTPS external redirects fail.
- `/__relay_preview/` and the platform's reserved cookies belong to bootstrap,
  not the app. App cookies are confined to the assigned host. Requests carrying
  an Origin must match that preview origin; WebSockets require it. Cross-origin
  application APIs or OAuth `form_post` callbacks may therefore need an app
  design/configuration change; arbitrary CORS is not enabled.

Default proxy bounds: 32 MiB request body, 256 MiB HTTP response and 256 MiB per
WebSocket direction; 15-second connect, 30-second response-header, 60-second idle
and five-minute total connection deadlines. Limits count encoded transport
bytes. There are at most 32 concurrent bridges/requests globally, 12 per owner
and 8 per chat, with no admission queue. Policy may lower these limits.
Interrupted/oversized uploads may already have partially reached the app;
inspect app state before repeating a mutation. See the actual
[proxy](../src/worker-preview-proxy.mjs) and
[TCP bridge](../src/worker-tcp-bridge.mjs) contracts.

## Secrets and isolation

The preview HTTP boundary strips Relay session/preview cookies and recognizable
Relay capability headers; it does not import provider credentials into requests.
Ordinary application Basic/Bearer Authorization remains supported. Durable
account records are encrypted, but this is not a claim that secrets never exist
in runtime memory or private native-account files. The app still controls its
own origin and runs within its chat's worker trust boundary.

Exact ready hostname routing occurs before Relay API/static routing. Unknown
hosts fail closed; forwarded-host headers do not choose authority. Preview-host
`/api/...` is the application's path, not the Relay API. Worker traffic travels
through the existing authenticated SSH executor to that worker's loopback only.
Host assignments and tombstones live in controller records and must be retained
with controller backups. One active controller is required.

## Activation, publication and rollback

Preview hosting is explicitly opt-in: the owned stack's `EnableAppPreviews`
policy must be active and controller configuration must enable it. Normal
Doppler publication must retain `AGENT_PREVIEW_ENABLED=1` (or `true`) in the
published environment. Missing/false means disabled; publication does not infer
intent from existing host records. Do not accidentally omit it during normal
full publication or credential republication. The metadata-only `update-worker`
operator preserves the existing snapshot, including preview enablement/caps,
and changes only the accepted AMI. The reviewed `update-previews --enable` operator can
instead update only the six derived preview metadata fields in an existing
AWS secret using conditional version promotion; it does not fetch Doppler or
refresh credentials. See the host-lifecycle ADR for its exact boundary.

Before creating live preview hosts, retain a **preview-aware, enabled rollback
container**. The shared deployment engine can seed its single previous slot by
a second deployment of the same verified immutable image/configuration after
positive checks; observe both operations and preserve the encryption key.
This replaces the legacy previous slot, so record the new baseline explicitly.

A legacy image without the Host dispatcher could serve Relay UI/routes on a
preview hostname. Host-only Relay cookies still prevent automatic login there,
but that violates the origin contract. **Revoking grants or changing the enable
flag alone is insufficient.** Before rollback to legacy code, or an intentional
global disable, revoke assignments and confirm every relevant distribution is
disabled and `Deployed` (or complete exact deletion) before removing routing.
Do not modify unrelated distributions or bypass a busy deploy drain. Normal
preview-aware updates preserve host records but invalidate browser grants;
users reopen from Relay after restart.

## Evidence to record

The [integrated official-MCP fixture](preview-ui-acceptance.md), invoked by
`node scripts/smoke-preview-ui-mcp.mjs`, combines real local Relay UI/session,
bootstrap and framed HTTP/SSE/WebSocket transport with synthetic OIDC/CloudFront
and a local worker stand-in. The separate hostile-service-worker fixture is
`node scripts/smoke-preview-bootstrap-mcp.mjs`. Neither uses real consent or AWS.

For deployed acceptance, record the immutable revision/digest and healthy SSM
operation, actual generated host and scoped lifecycle, authenticated app
HTTP/SSE/WebSocket behavior, negative owner/session/host checks, revocation and
exact cleanup. Readiness/anonymous denials, IAM activation, secret publication,
and isolated host-credential tests are useful but separate evidence. They do
not close Google/provider-consent gates or establish the complete MVP.
