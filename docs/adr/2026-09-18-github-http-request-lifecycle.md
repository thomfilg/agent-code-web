# GitHub capability HTTP request lifecycle

The scoped GitHub MCP endpoint must register authenticated work before awaiting
connection validation or reading its request body. Previously an incomplete body
was absent from the gateway's active count and cancellation controllers. The
Relay mutation counter already rejected deployment drain during that request,
but shutdown could still wait for its socket until the HTTP timeout expired.

One gateway lease now covers admission, body parsing and the one MCP operation.
The existing two-per-grant/four-global limits and 120-second total deadline apply
to all of those phases together; a tool reuses its HTTP lease instead of consuming
a second slot. Stop, own-connection revocation, shutdown, timeout and client
disconnect cancel the exact request. A stalled connection-validation queue is
also abortable, and any later completion must revalidate before proceeding.

MCP batches are rejected with a fixed error so one HTTP lease cannot fan out into
multiple concurrent tools or bypass pre-SDK argument validation. Existing exact
repository identity, owner/company/connection and post-await checks remain.

Early Git/MCP denials close incomplete HTTP connections. Otherwise a denied
request's counter could clear, drain could succeed, and its unfinished body could
still keep `server.close()` waiting. Git discovery rejects nonempty or chunked
GET bodies instead of returning success while ignoring unread input.
No generic server transport, authorization,
Git operation or PR write capability is added.

Verification uses local raw HTTP clients, the real gateway and official MCP SDK,
plus real Relay drain/stop fixtures with only synthetic credentials. It makes no
AWS, model or external GitHub calls. Regression coverage includes incomplete and
denied bodies, blocked admission, cancellation, timeout, owner isolation, slot
limits and successful PR tools sharing the existing lease. This is transport
shutdown evidence, not fresh provider consent or deployed AWS runtime evidence.

The final focused run passed 61 checks across gateway, MCP, real-gateway MCP,
runtime integration and readiness/drain suites, with no skips.
