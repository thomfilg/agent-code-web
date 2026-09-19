# ADR: native Claude sign-in, controller-owned renewal, access-only workers

Status: accepted for implementation; deployed browser-consent acceptance remains open.

## Context

Relay is a multi-user product. Google identifies the Relay user, not their
Claude subscription. A user can have personal and company Claude accounts;
neither the server's login nor another user's account may be a fallback.
The existing Codex account boundary already supplies named records, encrypted
storage, owner/company admission, cancellation and account-bound chats.

Claude Code 2.1.222 supports `claude auth login --claudeai`. In a remote shell
it prints an authorization URL and accepts the complete returned `code#state`
on stdin. This works without forwarding a localhost callback to the user's
computer. Native Claude owns PKCE, the authorization request and initial token
exchange. Native `auth status` only reports cached state; it is not proof that
the provider accepts the credentials. Native SDK initialization also does not
renew expired tokens.

## Decision

1. Extend the named-account boundary to Claude. Run every sign-in in a fresh
   controller-only profile with a clean environment. Never copy/import the
   server's profile through a product API or UI. Only the owning Relay user
   sees the pending authorization URL and can submit its returned code.
2. Show each ceremony inside its named account card. Validate the printed
   HTTPS origin, native callback, PKCE method, client ID and state. Compare the
   returned state with the pending flow before writing to that native process;
   the inspected native manual-code handler does not make this comparison.
3. After native completion, validate the access token against Anthropic's
   fixed-origin OAuth profile endpoint. Bind both account UUID and organization
   UUID. Reconnecting an existing record cannot replace either identity.
4. Store the allowlisted OAuth credential document in the existing encrypted
   account record. Controller-only temporary credential files are private and
   removed when the operation ends. Retain the native login's public client ID.
5. Renew centrally with the installed CLI's refresh grant at the fixed
   `https://platform.claude.com/v1/oauth/token` endpoint. Reject redirects,
   malformed/oversized responses and missing inference scope. Serialize
   renewals per account and checkpoint rotated credentials encrypted under the
   existing immutable identity before fetching the new token's profile. No
   access is delivered until that identity is independently verified. A
   temporary network/5xx/429 outage preserves the checkpoint for retry without
   another consent ceremony; revoked access or identity mismatch requires
   reconnect. There is never another provider/profile fallback.
6. Workers receive only the selected account's short-lived access token and
   identity metadata. They get a private chat profile, not a refresh token or
   an imported `.credentials.json`. Native SDK `oauth_token_refresh` requests
   are answered over the private control channel after owner/account/company
   admission checks. They are not approvals and do not enter chat history.
7. Use the native SDK's account-profile model catalog, without shared-host
   catalog fallback. The provider enforces actual model availability at send
   time. Scope Fast/workspace-trust state to the selected named account too.

## Consequences and limitations

- The user must authorize Claude in their own browser and paste the returned
  complete code into that account's card. This differs from Codex's device code.
- A controller restart cancels unfinished consent; completed encrypted account
  records survive. Disconnect invalidates admission before stopping bound
  workers. Reconnect preserves the named account identity and existing chats.
- Cancel invalidates the owner's pending flow before waiting for native
  verification/storage. Guarded commits roll back provisional credential writes
  if cancelled while awaiting persistence; admission/status never use those
  provisional credentials. Another user's request cannot invalidate the flow.
- The native refresh/control contract is version-sensitive. The offline native
  smoke must run when upgrading Claude Code; it exercises a real executable,
  a 401, private renewal, inference and journal resume without external network.
- Local workers share a host filesystem and are not a strong hostile-tenant
  boundary. Use isolated cloud workers for untrusted multi-user workloads.
  An agent necessarily receives its short-lived bearer for direct native
  inference. It does not receive the controller's durable refresh token.
- For testing only, the user authorized an isolated copy of local credentials.
  Such a copy does not prove the product's browser consent ceremony. Refreshing
  it can rotate a token in the same provider token family; tests must never
  logout/revoke the host account or write back to its credential file.
- Account deletion is separate from disconnect; see
  [the account-deletion ADR](2026-09-18-named-agent-account-deletion.md).
  Deployment and real user-consent gates remain explicit.

## References

- [Claude authentication](https://code.claude.com/docs/en/authentication)
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Remote/manual authentication troubleshooting](https://support.claude.com/en/articles/14552646-troubleshoot-claude-code-installation-and-authentication)
- Installed Claude Code 2.1.222: native login URL/manual input, SDK initialize
  model catalog, refresh-grant implementation and `oauth_token_refresh` control
  contract inspected and exercised locally.
