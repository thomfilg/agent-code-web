# Close incomplete request input after its response has finished

A client can declare a request body, send only a prefix and receive an early
401/403/404 or successful static/readiness response. Before this fix the response
handler could finish and deployment drain could approve, yet the incomplete
request's connection kept `server.close()` waiting for the client's remaining
input. This was independently reproduced in a disposable local Relay.

Register one small helper at HTTP request entry. On the response's `finish`
event only, if `request.complete` is still false, call `destroySoon()` on that
request's captured socket. Node ends its writable side and destroys it after
pending output finishes; the response is not cut off while queued output is
being written. Remove both helper listeners after response finish/close.

This does not patch response methods, change authentication, relax drain or
force-close all connections during shutdown. Complete inputs retain normal
keepalive. A declared incomplete body prevents parsing a subsequent pipelined
request on that socket, so this rule does not close another parsed request's
connection. A save/OAuth exchange still awaiting completion has not finished its
response and is unaffected; existing mutation counters remain authoritative.
SSE/streaming responses stay open until their normal completion/closure.

The existing request URL parse is also guarded with a fixed 400 response: a
malformed URL/Host must not reject the async handler before response completion.
No submitted URL is echoed in that diagnostic.

Local regression fixtures cover generic rejected input, static/readiness and
internal operator responses, malformed Host, chunked input, exact socket
isolation, complete POST→GET keepalive, slow authenticated input and a gated save
with drain409, live SSE, listener cleanup and a full 4MiB response delivered to a
paused consumer before closing the stalled request. Existing OAuth/server
regressions remain separate checks. No AWS, real provider, browser or user-data
operations are part of this validation.
