# Isolated local-controller public workspace acceptance

Status: operator implemented; real AWS execution is a separate root-owned gate.

`scripts/smoke-ec2-workspace.mjs` is a zero-network plan by default. Explicit
`--run --worker-id i-ID --image-id ami-ID --acceptance-id UUID` requires an
existing fresh dedicated native-acceptance worker. It reuses the exact account,
deployment, accepted-image, private-network/no-role/IMDS-disabled guards,
signature-verified SSM transport, private SSH key matching and fresh image audit.
It never provisions, stops, starts, retags or terminates an EC2 instance. The
root operator must retire that dedicated worker after every run.

The controller in this test is an isolated **local process**, not the deployed
AWS controller or its database. A sanitized child uses product `prepareWorkspace`
to clone only `https://github.com/octocat/Hello-World.git`. A private fixture Git
wrapper disables system/global configuration, credential helpers, redirects and
hooks. No provider or GitHub credential is read. `prepareRepositories` remains
unchanged: that selected-private-repository path requires a genuine scoped
credential and cannot honestly be tested with a fabricated token.

Only the existing `Ec2Executor` export is added to production code; its prepare,
tar upload and framed spawn logic is unchanged. After guard/audit, the fixture
constructs it with an exact-target, pinned SSM SSH transport. A fresh private
marked chat directory with a fresh per-invocation UUID receives the clone. Remote Git HEAD must match the local
clone; Git configuration must contain the expected credential-free origin and
no credential/include/header/URL-rewrite settings. A remote sentinel must
survive a second `prepare()` after the local copy changes, proving that the
seeded workspace is not overwritten. This is **not** a stop/start test.

Cleanup checks the exact private marked root (ordinary path, owned mode and
run identity) before removing it and closes only its own SSM session. Uncertain
creation still attempts exact-marker cleanup. A failed cleanup or receipt never
returns acceptance. Fixed subprocess errors do not expose private output.

The receipt explicitly leaves these gates open: selected private GitHub auth,
fresh product consent, deployed-controller execution, `Ec2Backend.acquire`,
VM stop/start, GitHub pushes and PR creation. Offline tests execute unchanged
tar/prepare/framed-spawn against a disposable shell transport; they do not
establish a real AWS result.

## Confirmed GitHub worker limitation

The selected `githubConnectionId` currently feeds controller-side repository
selection/clone and UI PR/check/file/auto-merge operations only. It does not
provision a worker Git credential helper, GitHub gateway capability, `GH_TOKEN`
or `gh` authentication. The worker image installs Git but not GitHub CLI. A
separate GitHub MCP connection can be selected by an environment, but its own
credential is independent of the repository's selected GitHub connection.
Therefore selected-account native `git push` or `gh pr create` is not delivered
by the current integration. This test does not claim otherwise and must not
work around the limitation by borrowing the controller's host credential.
