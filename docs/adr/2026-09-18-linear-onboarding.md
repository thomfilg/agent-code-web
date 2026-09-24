# ADR: explicit Linear workspace authorization and read verification

Status: accepted for implementation; real-user consent acceptance remains open.

## Context

Linear authentication is an MVP gate. Previously the generic MCP manager could
save settings or list tools without showing a completed workspace read; failed
consent only appeared in a popup, and blank scopes requested every advertised
permission. The user needs independent company accounts with the same MCP name.

## Decision

- Use Linear's official Streamable HTTP endpoint and dynamic client registration.
  Public metadata on 2026-09-18 advertises `/register` and PKCE S256. Do not impose
  manual client registration on Linear users. Retain the generic registered
  client fallback for custom MCPs that actually need it.
- Default new Linear OAuth connections to `read`, with an explicit read/write
  selector. Write access remains supported; read-only verification is not a
  restriction on the agent's consented product capabilities. Changing scopes
  invalidates existing credentials and requires fresh consent.
- Authenticate each connection independently. The exact provider endpoint, not
  its editable name, selects Linear-specific behavior. Preserve owner namespaces,
  explicit company scopes, primary-repository matching and environment selection.
- Verify access by calling the known non-mutating `list_teams` tool with a single
  result. Never infer a safe call from arbitrary custom-tool annotations. Store
  only the verification time/tool, not private team data. If the tool disappears
  or the call fails, do not claim verification from discovery alone.
- Present pending, declined, cancelled, expired and failed flow states in the
  parent connection UI. Provide a manual link when popups are blocked. Cancel
  invalidates pending callbacks without disconnecting an already-authorized
  account. Guard the serialized database write on both sides of persistence;
  cancellation waits for restoration of the previous record when necessary.
  Public/token reads wait for that guarded operation to settle, and existing
  worker grants are not revoked by a cancelled commit. Replacement and deletion
  also wait for the prior operation, preventing late credentials from becoming
  current. UI success matches a completed attempt ID distinct from OAuth state,
  not an unrelated revision increase while old tokens still exist.
- Forward explicit Authorization headers with fetch `credentials: omit`.
  Otherwise Node's fetch can attempt to replay a streamed body after a 401
  challenge and convert a revoked credential into a misleading 502. Preserve the
  upstream 401/403 and record Sign-in required; do not borrow other credentials.

## Consequences

Users choose the correct workspace during provider consent and explicitly map it
to Relay companies. The controller cannot prove that a human chose the intended
business workspace from a company label alone. Live two-workspace consent and
real-agent reads are still a user-acceptance gate, not satisfied by local tests
or public metadata. No new external OAuth app registration or account grant is
automatically created during this validation.
