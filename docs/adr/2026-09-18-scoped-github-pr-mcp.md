# Scoped GitHub pull-request tools for native workers

Status: implemented with offline RPC tests; shared gateway/lifecycle integration
and real selected-account acceptance are separate gates. This does not complete
the MVP or claim that a real provider consent or external PR write was tested.

The selected GitHub connection previously covered controller repository cloning
and PR UI operations, not native agents' PR creation. The bounded MVP addition
exposes exactly two MCP tools through `/gateway/github/mcp`:

- `github_create_pull_request`: an existing same-repository head and base,
  title/body, and optional draft flag (defaults to true).
- `github_edit_pull_request`: title/body only for an open PR whose head belongs
  to the selected repository and matches the supplied expected branch.

There is no generic REST/GraphQL proxy, fork creation, PR merge/state/base change,
review, label, workflow or administrative tool. Git smart HTTP and native worker
lifecycle are owned by the separate shared GitHub worker gateway integration.

The MCP configuration reuses the **same** revocable gateway capability; it does
not issue another grant or expose a GitHub token. The gateway owns admission,
exact chat owner/company, saved repository ID/name and selected connection,
connection revision/expiry, upstream immutable repository verification, and
revocation. Tool discovery lists only the currently selected repository IDs and
names so the model does not need a generic repository-list API. A worker must
supply both saved ID and exact name. Another selected or global connection is
never used as a fallback.

Every request and every asynchronous GitHub operation rechecks the capability.
Slow request bodies cannot preserve stale discovery access. A disconnected MCP
request aborts further tool work; gateway revocation can also cancel in-flight
requests. No promise is made to undo a write GitHub already received. Writes are
never retried automatically; a failure explicitly tells the agent to inspect the
PR before retrying.

The controller constructs only fixed repository branch and pull-request routes.
Branch names are bounded local `refs/heads` names, deliberately using an ASCII
subset, with no `owner:branch`, ref expressions, leading options or traversal.
Title length is 1–256 characters; body length is at most 20,000, with control
characters rejected except normal body whitespace. Unknown fields are rejected,
not silently stripped. Create verifies both branches first. Edit reads and
verifies the exact PR number, open state, immutable base/head repository IDs,
full names and expected head before PATCH. The returned PR is checked again,
including the requested title/body and create draft state.

Responses expose only the selected repository, PR number, reconstructed
`https://github.com/<selected-repository>/pull/<number>` URL and verified branch
names. Raw upstream URLs, titles/bodies, account data, exceptions, tokens and
provider responses are not forwarded. Tool argument errors are fixed messages
before SDK validation, preventing SDK errors from echoing arbitrary extra field
names. HTTP rejects browser origins, query parameters, missing/expired bearer
capabilities, non-POST requests, malformed JSON and bodies over 100 KB.

The implementation uses the repository's installed official MCP SDK and stateless
JSON Streamable HTTP transport, as does SharedBrowsers. No dependency changes.

Offline tests exercise the official SDK client/server over real loopback HTTP,
the actual capability broker, request/response schemas, current scope changes,
expiry/revocation, wrong repository/owner/company/connection, same-name wrong-ID
forks, async revocation before and after writes, aborts, bounded input, unsafe
upstream responses, slow bodies and fixed redaction. Upstream GitHub requests in
these tests are fixtures; no AWS, models, real account state or external PRs are
used. Gateway-specific and deployed acceptance remain separately required.

Validation: 20 MCP tests passed (16 strict-tool/HTTP/official-SDK tests and four
cross-module tests using the actual gateway). Together with the gateway's native
Git loopback and the existing GitHub login/company suites, 53 tests passed.
Independent root review reran the 20 MCP tests and found no blocker. The native
adapters must convert the MCP capability header to an environment reference,
not serialize it into native argv or persistent settings; that integration has
its own regression gate before activation.

Primary references:

- [GitHub REST pull-request endpoints](https://docs.github.com/en/rest/pulls/pulls)
- [Official MCP TypeScript SDK v1 server transports](https://ts.sdk.modelcontextprotocol.io/server)
