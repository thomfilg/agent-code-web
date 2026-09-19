# Remote worker credential and streaming boundary

Status: implemented transport hardening; actual AWS transport acceptance pending.

## Decision

A dedicated EC2 VM is the isolation boundary for one chat, not a claim that its
native CLI can use an account without access to an access token. Distinguish:

| Integration | What reaches the chat worker | What remains on the controller |
| --- | --- | --- |
| Named Codex account | Selected account's access token over app-server RPC; ephemeral native credential store | Refresh token, saved encrypted account record and ownership/company checks |
| Named Claude account | Selected account's access token in the native process environment; account-bound renewal | Refresh token and encrypted account record; no account substitution |
| Provider-key gateway mode | Chat/provider-scoped revocable Relay capability | OpenAI/Anthropic provider API key |
| HTTP MCP, including Linear | Selected-connection Relay capability and gateway URL | OAuth access/refresh tokens, client secret and service headers |
| GitHub repository preparation | Cloned repository without persistent authentication headers | Selected owner's GitHub token, used only for the controller's clone/API requests |
| Shared guest Chrome | Browser capability and private CDP pipe | Relay browser session and unrelated personal browser profiles |

Environment variables explicitly configured for a selected environment are also
worker inputs. They are not protected from that worker's tools. Native account
access tokens are usable by the native CLI and potentially by code running as
the same worker user/root inside that chat VM. They are **not** Relay-scoped
gateway capabilities. Disconnect stops the associated runtimes and prevents
further controller renewal; it does not magically invalidate a copied provider
token before the provider expires/revokes it. Local workers do not provide the
same filesystem/process isolation as dedicated VMs.

No controller role, SSH private key, provider master key, native refresh token
or other chat's account may be baked into or delivered to a final worker.
Workers have no IAM role and IMDS is disabled. This remains distinct from the
selected account's required access-only native authentication.

## SSH transport hardening

Previously, `Ec2Executor.spawn` embedded its environment and native arguments in
the SSH command. This exposed access tokens and MCP capabilities in controller
process argv and potentially in process-launch diagnostics.

The SSH command now contains only a fixed launcher. A bounded JSON frame goes
over SSH stdin, followed by the native stdin stream without interpretation.
The launcher uses `spawn` without a shell, an explicit environment, and no
temporary credential file. Native stdout/stderr stay separate, heartbeat stays
active, and termination targets the launched process group. Bootstrap failures
have a fixed diagnostic rather than echoing the private frame. Native output
still requires adapter-level redaction; this is not a general log sanitizer.
Normal exits drain buffered output. Explicit termination/transport failure has
a two-second kill deadline; a stalled consumer can lose buffered output during
that forced shutdown, rather than keeping a stopped worker alive indefinitely.

## Remote streaming audit and gate

Guest Chrome executes in the selected executor, not on the controller; its CDP
uses pipe descriptors, transported via SSH. Browser viewing/input uses the
owner-authenticated `/api/chats/:id/browser/live` WebSocket. Chat events use SSE
with Last-Event-ID replay. Both send 15-second heartbeats, below the configured
60-second CloudFront origin read timeout. Logout closes the owner's streams.
The configured proxy forwards the public Host, cookies and upgrade headers and
does not cache/compress responses. Do not trust arbitrary X-Forwarded-Host in
place of the canonical request Host.

Fixture tests cover the HTTP origin hop behind public HTTPS, Google Secure
cookies, owner/cross-owner WebSocket and SSE access, live browser input, replay
and logout. They do **not** prove the actual deployed CloudFront/VM path. Root
must still verify WSS frames/input and an SSE stream across an idle interval,
plus a real fresh-worker start/resume with the accepted AMI. No real model
prompts or account imports are part of these transport fixtures.

Direct native-browser preview URLs into a remote app are still unavailable.
`public/browser-links.js` explicitly reports that a forwarding URL is needed;
it must not advertise a local alias as a remote tunnel. Shared Chrome is the
current supported remote-app view. Any future forwarding must use a distinct,
access-controlled origin rather than serving arbitrary worker HTML on Relay's
authenticated origin.
