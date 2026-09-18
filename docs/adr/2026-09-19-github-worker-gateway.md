# Repository-scoped Git access without provider credentials on workers

Status: implemented; integration and external acceptance tracked separately.

## Decision

The selected user-owned GitHub connection remains encrypted on the controller.
Cloning an initial workspace on the controller did not by itself let an isolated
worker fetch, push or open a pull request. A separate `GitHubWorkerGateway` now
grants that worker a revocable capability for the chat's exact saved repositories.
It deliberately does not reuse the model-provider broker: issuing one provider
capability revokes the broker's previous capability for the same chat.

A grant snapshots owner, primary company, repository numeric IDs/names, selected
connection IDs/revisions and connection credential hashes. Every operation checks
the current chat and owner-scoped saved connection, expiry, both company scopes,
and GitHub's immutable repository identity. The worker cannot choose a connection,
company, owner, provider token or upstream URL. Stop/resume and connection changes
revoke old grants. Mutations notify before and after durable persistence; scope
changes/disconnect notify immediately before entering the shared write queue.
New admission waits for that queue and checks connection mutation epochs as well.

Git receives ephemeral `GIT_CONFIG_*` settings: exact saved HTTPS origin rewrite,
path-scoped capability header, cleared inherited headers/helper and no redirects.
The normal origin remains `https://github.com/<saved repository>.git` in Git's
configuration. The controller replaces the capability with its selected provider
credential only in the outbound request. No PAT, refresh token, host `gh` login,
credential file or secret-bearing remote URL is sent to the worker.

Only smart HTTP `info/refs` for upload/receive-pack and the two corresponding POST
operations are exposed. No generic REST/GraphQL proxy, free upstream URLs, LFS,
cookie forwarding, redirects or unselected submodules. Pull-request create/edit
is a separate strictly typed MCP module sharing this admission service; it is not
an arbitrary API tunnel. This gateway authorizes a repository, not a branch:
GitHub branch protection and the user's granted repository permissions remain
authoritative. It does not implement a branch allowlist or prevent a permitted
agent from proposing/deleting a branch in that selected repository.

## Bounds and failure semantics

Requests are buffered with a 32 MiB compressed **and** decompressed maximum before
forwarding. This is an intentional bounded-memory simplification for MVP, not an
unbounded upload stream. Responses stream with backpressure and a 256 MiB limit.
Maximum two active operations per grant/four overall, with a 120-second deadline;
larger repositories/pushes fail rather than silently bypass the gateway. Git's
gzip/chunked request forms are accepted within those limits. Fixed response MIME
types and status/header allowlists keep upstream error text and cookies private.

Active upstream fetches/streams are aborted on revocation or client disconnect.
Revocation cannot undo a push or PR mutation already accepted by GitHub. If the
connection drops after submission, inspect GitHub before retrying; the operation
may have completed. No failure receipt claims a rollback. Runtime capability
redaction and precise lifecycle hooks are a separate required integration change.

## Evidence and remaining gates

Local fixtures use the actual Git executable and `git http-backend`, not a mock
of Git's wire protocol. Clone, fetch, branch commit/push, revoked access and fresh
resume succeed; `.git/config` retains only the ordinary GitHub origin. Controller
and provider credentials are intentionally synthetic in these tests. Security
cases cover owner/selection/company changes, connection revision/token/expiry,
immutable ID mismatch, pre-write revocation, delayed writes, aborted identity
lookup/response, malformed routes, gzip and fixed error/header redaction.

This is not evidence of deployed AWS GitHub push or fresh user OAuth consent.
Any real external feature acceptance is restricted to this feature's own branch
and draft PR on `thomfilg/agent-code-web`, with parent coordination first. It must
never target main, another repository, or unrelated user data. Controller-local
prior GitHub clone/list/PR-read evidence remains distinct from this worker path.
