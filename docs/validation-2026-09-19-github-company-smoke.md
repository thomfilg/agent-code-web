# Company-bound GitHub acceptance refresh

Validated 2026-09-19 at approximately 12:07 UTC, based on runtime commit
`1047a9503a5019276fadef9b24f550d4550c872e` with the harness changes in this PR.

## Why the harness changed

The previous `scripts/smoke-real-github.mjs` instantiated `GitHubConnection`
without `Companies`, including after encrypted PostgreSQL restart. It therefore
exercised the older optional/unscoped service path instead of the production
single-company model. Its existing green result was insufficient evidence for
current company isolation.

The harness now registers two companies in its temporary owner-scoped database,
binds the one test connection to one company, and recreates the same scoped
services after restart. It rejects an unregistered/missing company, a second
connection for the same company, and another company's repository selection,
API read and clone-token request. Call counters prove those company denials do
not reach GitHub. Forged picker company metadata cannot override the connection's
saved company; the repository owner is deliberately different from that company.

Its provider wrapper refuses non-GET operations and non-GitHub API destinations.
Failure output contains only a fixed stage name and generic message, never
subprocess/provider errors or credential output. The CLI still requires explicit
`--allow-local-test-credential`; it never switches the host GitHub account or
imports any credential into Relay's live database.

## Actual real-account result

Executed successfully:

```sh
taskset -c 0,1 nice -n 10 node scripts/smoke-real-github.mjs \
  --allow-local-test-credential \
  --account=thomfilg --repository=thomfilg/agent-code-web
```

- Read the specifically authorized local GitHub credential without printing it.
- Confirmed the intended GitHub identity and provider-authorized repository list.
- Resolved and cloned the selected repository using the company-bound connection.
- Verified that the clone's Git configuration contained neither the token nor an
  HTTP authorization header.
- Read an existing PR and its head commit's checks through that connection.
- Reopened the encrypted PostgreSQL database and confirmed saved connection ID,
  registered company, provider identity and valid repository selection survived.
- Confirmed duplicate-company and cross-company denials before provider calls,
  including after restart; another user had no company or connection visibility.
- Confirmed GitHub rejected a deliberately nonexistent/unavailable repository.
  This is a provider-denial-path check, not evidence against a particular private
  repository belonging to another real company.
- Removed the isolated database and cloned workspace after completion.

The report explicitly states `remoteWrites: false`,
`deployedProductSelection: false`, and `workerGatewayAcceptance: false`.
No browser profiles were inspected or copied. No model prompt was sent.

## Regression evidence

```sh
taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 \
  test/github-real-smoke.test.mjs test/companies.test.mjs \
  test/github-login.test.mjs
```

**30 passed, 0 failed, 0 skipped.** Four new harness tests cover:

1. Full orchestration with real encrypted PostgreSQL restart and fixture-only
   provider/clone boundaries, including cleanup and explicit evidence limits.
2. Mutation and wrong-origin rejection before fetch.
3. Unowned-repository rejection before local credential lookup.
4. CLI explicit-authorization gate with sanitized failure output.

The first test's fake clone is harness regression coverage only; the separate
real command above exercised actual Git cloning and actual GitHub reads.

## Still not accepted by this check

This does not establish fresh browser OAuth consent, deployed UI selection of
the user's saved GitHub connection, selected AWS worker capability/gateway
operations, write/push/PR creation, agent-assisted GitHub use, or native-session
restart/resume. Those are separate MVP acceptance gates. The real smoke is
read-only by design; neither copying a local credential nor a successful local
clone is substituted for the product-selected AWS workflow.
