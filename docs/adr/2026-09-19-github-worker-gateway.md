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

### Authorized actual-provider acceptance — 2026-09-18

Passed with gateway revision `5723ba609056ecce1637f15fcfeb11009b7d4822` and PR MCP
revision `b4fa736`. The isolated loopback fixture loaded the specifically selected
`thomfilg` native credential into RAM-backed records, verified account/repository
identity, then native Git pushed that actual feature commit through the gateway
only to `feat/github-worker-gateway` in `thomfilg/agent-code-web`. The GitHub branch
API confirmed the exact new SHA. The scoped MCP edit tool updated only the
acceptance evidence section of existing draft PR 19, with saved repository and
expected-head checks. No unrelated branch, PR, repository or main was modified.

Sanitized acceptance receipt:

```json
{
  "schema": 1,
  "fixture": "local-native-git-loopback-not-EC2",
  "pullRequest": 19,
  "revision": "5723ba609056ecce1637f15fcfeb11009b7d4822",
  "mcpRevision": "b4fa736",
  "actorVerified": true,
  "repositoryIdentityVerified": true,
  "nativeGitPush": true,
  "pushedRevisionConfirmed": true,
  "scopedPrEdit": true,
  "noProviderCredentialInWorkerEnvironment": true,
  "noSecretsInGitArgv": true,
  "grantRevoked": true,
  "sourceCredentialUnchanged": true,
  "gitConfigUnchangedAndSecretFree": true,
  "privateFixtureRemoved": true,
  "accepted": true
}
```

The source token, native GitHub credential store and repository Git configuration
were privately hashed before/after; only equality flags were emitted. The native
worker Git environment contained a revocable capability, never the provider
credential. Git argv contained neither capability nor provider credential.
Temporary HOME was removed and the fixture server/grant shut down. No global
GitHub account switch, production Relay record import, AWS call or model turn.

Independent bounded review cleared the service and its follow-up. The dedicated
suite has 14 passing tests (26 with existing GitHub native-login/API tests),
including decompression limits, per-grant/global concurrency and client abort.
Runtime lifecycle/native CLI wiring remains a separately reviewed companion
change. This receipt must not be presented as deployed EC2 worker Git evidence
or as a fresh user's interactive GitHub consent.

### Combined AWS Git acceptance remains pending

The accepted worker image intentionally disables TCP forwarding for the SSH
transport user (`Match User ubuntu`, `AllowTcpForwarding no`), while the native
operator clears all forwarding requests. Therefore exposing the isolated local
gateway on worker loopback with SSH `-R` is not an available shortcut. We did
not relax SSH policy, change security groups, invent a product user, import a
provider credential into production records, or introduce an unreviewed reverse
HTTP bridge merely to obtain an acceptance receipt.

The current evidence consists of distinct checks: local native Git through this
gateway to actual GitHub; native CLI capability/environment protocol fixtures;
and separately the accepted EC2 workspace transport. None of those proves the
combined selected GitHub connection → deployed CloudFront gateway → EC2 native
Git push/PR path. That combined gate requires the real user's selected GitHub
connection and a normal isolated worker after deployment; fresh interactive
product consent remains user-owned. Until then this gate is explicitly pending.

### Actual PR creation — ordinary feature PR 22

The scoped `github_create_pull_request` MCP tool also passed against actual
GitHub using the next ordinary feature delivery, not an unrelated test PR:
`fix/guest-chrome-diagnostics` at
`086db984f22a5213f13bcc5a7b4bf86d71e6d118` into `feat/codex-account-login`, in
`thomfilg/agent-code-web`. Creation was coordinated with that feature's author;
their ordinary PR command was held. Read-only preflight confirmed no existing PR
in any state for this head and verified the exact remote branch tip.

Exactly **one create attempt, zero retries** produced draft
[PR 22](https://github.com/thomfilg/agent-code-web/pull/22). A subsequent read-only
GitHub request confirmed the number, open/draft state, repository identities,
expected head SHA, head/base refs, title and body. The operator did not edit
another PR, push a branch or modify main. Its predeclared ambiguous-write policy
was read-only inspection, never automatic retry.

```json
{
  "schema": 1,
  "fixture": "isolated-controller-MCP-actual-GitHub-not-EC2",
  "branch": "fix/guest-chrome-diagnostics",
  "revision": "086db984f22a5213f13bcc5a7b4bf86d71e6d118",
  "createAttempts": 1,
  "actorAndRepositoryVerified": true,
  "branchTipVerified": true,
  "pullRequest": 22,
  "url": "https://github.com/thomfilg/agent-code-web/pull/22",
  "readOnlyConfirmation": true,
  "scopedMcpCreateConfirmed": true,
  "grantRevoked": true,
  "memoryCredentialRemoved": true,
  "sourceCredentialUnchanged": true,
  "gitConfigUnchangedAndSecretFree": true,
  "accepted": true
}
```

The specifically selected native GitHub credential existed only in the isolated
controller's RAM records; no product record, global account selection, disk
credential copy or worker credential was created. Private before/after hashes
confirmed source token/store and Git config were unchanged; only boolean checks
were emitted. The grant was revoked and RAM credential removed. Service code was
the reviewed gateway from `5723ba6` and PR MCP from `b4fa736`.

This is **isolated-fixture + real GitHub** acceptance. It proves scoped real PR
creation, not the deployed AWS gateway, not an EC2 execution path, and not a
user's fresh product OAuth consent. Those pending boundaries are unchanged.
