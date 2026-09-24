# Dormant preview authorization primitive

`src/preview-grants.mjs` is an in-memory foundation for the
[remote app preview design](adr/2026-09-19-remote-app-preview-design.md).
It is **not wired into Relay** and adds no listener, route, cookie, UI, bridge,
CloudFront configuration or IAM permission. Direct remote app URLs and the full
HTTP/SSE/WebSocket deployed acceptance gate remain open.

## Controller-only API

```js
const previews = new PreviewGrants({
  isCurrent: binding => controllerAssignments.isCurrent(binding),
});
const { ticket, expiresAt } = previews.issueTicket(controllerOwnedBinding);
const { grant } = previews.exchangeTicket(ticket, observedPreviewHostname);
const { binding, signal } = previews.authorize(grant, observedPreviewHostname);
```

The binding is a copied/frozen plain record containing exactly:
`ownerId`, `sessionId`, `chatId`, `hostname`, `port`, `runtimeGeneration`.
IDs are bounded opaque strings; generation is a bounded opaque string or
nonnegative safe integer, without type coercion. The port is fixed in
1024–65535. Hostnames must be canonical lowercase DNS names for an HTTPS origin;
URLs, ports, paths, wildcards, IP literals and alternative numeric-IP spellings
are rejected. An observed request host is used **only for exact comparison**;
it never supplies a destination, owner, session or assignment.

`isCurrent` is a required synchronous controller callback returning exactly
`true` only when the verified Relay owner/login session, chat assignment,
hostname, fixed port and runtime generation are still current. It runs at
issuance, exchange and each authorization; exceptions, promises, stale identity
or reentrant revocation deny access with the same fixed `PreviewGrantError`.
It must use authoritative server state, never a browser-submitted binding or
hostname. It must reject Relay's own origin and foreign/unassigned hosts.

The future assignment registry must ensure preview hostnames never recycle
across unrelated owners/chats, including after restart. This primitive has no
persistent registry and **cannot establish that property by itself**. TLS,
forwarded-host validation and HTTPS enforcement belong to the future listener.

## Tickets, leases and revocation

- Tickets and grants have separate prefixes and 256 random bits. Only SHA-256
  digests are retained internally; there is no persistence, refresh or renewal.
  A fresh process/store accepts none of the old process's tokens.
- Tickets default to 60 seconds, grants to 5 minutes. Configuration can shorten,
  not extend, those limits. A successful matching exchange synchronously consumes
  its ticket and mints a distinct grant. Wrong-host exchange creates nothing and
  leaves a still-live ticket usable on its assigned host; expired or stale-scope
  tickets are removed. Replay and using one token kind as the other fail closed.
- `authorize` returns the same read-only `{ binding, signal, expiresAt }` lease;
  repeated requests do not move its deadline. Future HTTP/WS bridge consumers must
  check `signal.aborted`, subscribe before acquiring/using a bridge, recheck after
  awaited work, and close the exact bridge when aborted. Map removal alone is not
  stream cancellation.
- Each entry has an unref deadline timer; expiry actively aborts its signal even
  with no traffic/prune call. Removal clears the timer. The default clock is
  monotonic epoch time; an invalid/regressing injected clock closes the store.
- `revokeOwner(ownerId)`, `revokeSession(ownerId, sessionId)` and
  `revokeChat(ownerId, chatId)` revoke matching tickets and grants and abort their
  signals synchronously. Owner scoping prevents equal session/chat IDs belonging
  to another owner from being revoked. `revokeGrant(grant)` affects only that
  grant; `close()` irreversibly closes the store and aborts every lease.
- The controller **must call those revocation hooks** on logout/login expiry,
  chat stop/delete, account/scope changes and runtime/assignment replacement.
  `isCurrent` is not polled in the background; it cannot detect a change during
  an already-open bridge without the hook. `prune()` checks current bindings,
  but is not a substitute for timely lifecycle revocation.
- Default capacity is 1,024 total entries, at most 64 per owner, counting both
  tickets and grants. Configured caps cannot exceed 10,000 total. Overflow denies
  without evicting another session; exchange reuses the consumed ticket's slot.
  Tokens, bindings and session IDs must not be logged or serialized to workers.

`test/preview-grants.test.mjs` covers expiry without traffic, replay, exact host,
owner/session/chat/port/generation changes, guarded admission, scoped revocation,
immutable data, malformed inputs, capacity and reentrancy. All tests are local,
with synthetic bindings: no AWS, browser, cookies, user data, models or provider
operations. Integration and deployed acceptance are deliberately not claimed.
