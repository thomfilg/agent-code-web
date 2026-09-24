# Company-bound local GitHub worker-gateway acceptance

Actual-provider run passed 2026-09-19 at approximately **12:34 UTC**, based on
`3f52aa617d6410ad4341f6667e6a1bafdb988d23` plus this acceptance change.

## Gap closed

The earlier refreshed company smoke checked controller-side repository clone
and API reads, not native Git through the worker capability gateway. Historical
actual-provider gateway evidence predates the current single-company connection
model. This opt-in mode combines the current registered company, encrypted saved
connection and immutable repository selection with a real native Git subprocess
using the actual loopback HTTP gateway.

```sh
taskset -c 0,1 nice -n 10 node scripts/smoke-real-github.mjs \
  --allow-local-test-credential --worker-gateway \
  --account=thomfilg --repository=thomfilg/agent-code-web
```

The standard mode remains controller-only. This mode additionally:

1. Starts a loopback gateway for the exact selected repository/company and gives
   native Git only its revocable capability. Git receives no provider token,
   host credential helper, global Git configuration or normal host HOME.
2. Clones the real selected GitHub branch through smart HTTP upload-pack and
   verifies a commit and a normal, secret-free GitHub origin in `.git/config`.
3. Denies an unselected repository's Git read, Git receive-pack submission and
   typed MCP PR-write request. Counters prove none reaches either provider API
   or Git transport. These are denied attempts, not external writes.
4. Shuts down the gateway, reopens the encrypted PostgreSQL database, rebuilds
   the company-bound service/gateway and rejects the old capability. A fresh
   grant fetches the selected branch through the gateway into the existing clone.
5. Renames only the isolated saved connection; its old capability is rejected.
   A new capability can read the remote branch. Changing the fixture chat's
   company then invalidates that grant and denies new grant admission.

The actual run performed **8 provider Git requests**, all read-only upload-pack
discovery/exchange. The API fence permits only GET, and a separate Git fence
permits only upload-pack discovery/POST for the exact selected repository,
never receive-pack or redirects. Native Git argv/config and its environment
are checked for provider-token leakage; capabilities are allowed only in the
ephemeral environment, not argv/config. The grant/server, isolated encrypted
database, HOME and workspaces are shut down and removed afterward.

Sanitized receipt fields:

```json
{
  "workerGatewayAcceptance": true,
  "workerGateway": {
    "environment": "local-native-git-subprocess-not-EC2",
    "nativeCloneThroughGateway": true,
    "nativeFetchAfterDatabaseRestart": true,
    "oldCapabilitiesDenied": true,
    "selectedConnectionMutationRevokes": true,
    "crossCompanyDenied": true,
    "unselectedGitReadWriteDenied": true,
    "unselectedPrWriteDenied": true,
    "noProviderCredentialInWorkerEnvironment": true,
    "noSecretsInGitArgvOrConfig": true,
    "upstreamGitRequests": 8,
    "remoteWrites": false,
    "deployedProductSelection": false,
    "nativeAgentOrAwsWorker": false
  }
}
```

## Regression acceptance

```sh
taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 \
  test/github-worker-readonly-probe.test.mjs \
  test/github-real-smoke.test.mjs test/github-worker-runtime.test.mjs
```

**16 passed, 0 failed, 0 skipped.** The new integration regression runs real Git
against `git http-backend`, with fixture provider identity/API responses and a
real encrypted PostgreSQL close/reopen. It exercises the same orchestration as
the actual-provider run. The separate fence regression rejects provider writes
and unrelated/redirecting transports before forwarding.

The runtime redaction regression now checks visible assistant messages across
commentary/tool segmentation instead of assuming the final saved marker has
text. The existing scan of the full stored transcript/events for every capability
and provider secret is retained. No production redaction or gateway policy changed.

## Exact remaining boundary

This is **not** the deployed user's product-selected connection → CloudFront →
EC2 worker route. The local fixture supplies a saved selection directly and
launches native Git, not a Codex/Claude model or production runtime. No browser
consent, live product credential import, browser-profile access, AWS access,
model prompt, actual Git push or actual PR write occurred. Existing PR/check
reads in the base smoke are controller-side API reads, not a new worker API.

GitHub gateway grants are repository-scoped, not branch allowlists. This check
does not prove a prohibition on writes to other branches within the selected
repository; GitHub permissions/branch protection remain authoritative, as in the
[gateway decision](adr/2026-09-19-github-worker-gateway.md).

Combined deployed transport/account/worker acceptance and native-agent session
resume remain separate pending MVP gates. This real local result must not be
used to mark those gates complete.
