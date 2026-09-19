# Manual AWS application rollout from GitHub

Implementation is **disabled by default**. This is an operator activation runbook,
not evidence that IAM, environment protections or OIDC login are active. Image
building, secret population and infrastructure provisioning remain separate. The
workflow only observes status, deploys an existing ECR digest or restores the
previous container through the reviewed shared engine.

## Pinned deployment

[`ci-target.json`](ci-target.json) records account `456808212788`, region
`us-east-2`, application stack `agent-relay-mvp`, separate identity stack
`agent-relay-mvp-ci`, environment `aws-mvp`, and engine commit
`848182b33461640e9ac0feb7315f747a67877c88`. Tests require agreement with the local
wrapper and manual workflow. Do not use an older released engine tag.

## 1. Inspect and render the separate IAM leaf

An authorized bootstrap operator, **not the deployment role**, performs setup.
Confirm STS account and completed application stack before creating anything:

```bash
relay_ci_dir=$(mktemp -d)
aws --profile code-web --region us-east-2 sts get-caller-identity
aws --profile code-web --region us-east-2 cloudformation describe-stacks \
  --stack-name agent-relay-mvp --output json > "$relay_ci_dir/application-stack.json"
aws --profile code-web --region us-east-2 iam get-open-id-connect-provider \
  --open-id-connect-provider-arn arn:aws:iam::456808212788:oidc-provider/token.actions.githubusercontent.com
```

If the provider exists, verify its GitHub URL and STS audience, then reference it
without changing its audiences, thumbprints, tags or ownership:

```bash
node deploy/aws/ci-template.mjs \
  --stack-json "$relay_ci_dir/application-stack.json" \
  --output "$relay_ci_dir/ci-template.json" \
  --existing-provider-arn arn:aws:iam::456808212788:oidc-provider/token.actions.githubusercontent.com
```

Only confirmed `NoSuchEntity` permits `--create-provider` instead of the existing
ARN option. Access/network errors do not mean absence. Creation is explicit;
new providers are retained on leaf deletion/replacement. An existing provider is
not a resource in this template, so it cannot be adopted or modified. IAM resolves
the CA thumbprint when omitted; no stale hard-coded certificate is used.
[AWS provider reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-iam-oidcprovider.html).

The renderer makes no AWS calls and refuses to overwrite its output. It checks
pinned account/region, completed owned app stack, exact controller and same-account
ECR metadata. Review the JSON. Provision **`agent-relay-mvp-ci`**, never apply this
template to the application stack. Use the shared engine's explicit provisioning
path (which rechecks AWS identity and any existing leaf's ownership):

```bash
# CI_AWS_ENGINE points to scripts/deploy/aws.mjs at the clean reviewed SHA above.
node "$CI_AWS_ENGINE" provision --profile code-web \
  --region us-east-2 --expected-account 456808212788 \
  --stack agent-relay-mvp-ci --template "$relay_ci_dir/ci-template.json"
node "$CI_AWS_ENGINE" status --profile code-web \
  --region us-east-2 --expected-account 456808212788 --stack agent-relay-mvp-ci
```

Submission is not completion: wait for a stable complete state. Read
`RolloutRoleArn` with `DescribeStacks`; shared-engine status intentionally
allowlists only application outputs. After controller replacement, regenerate
and review this leaf from fresh app outputs. Never broaden its resource ARNs.

## 2. Protect GitHub before activation

Create environment `aws-mvp` with trusted required reviewers, deployment branches
restricted to protected `main`, and administrator bypass disabled where supported.
Review/merge the workflow to `main`; manual workflows must exist on the default
branch. Do not enable CD before required environment protections are in place.

The exact audience is `sts.amazonaws.com`; the subject is:

```text
repo:thomfilg@648890/agent-code-web@1370075262:environment:aws-mvp
```

Read-only metadata confirmed creation on September 14, 2026 and default claims.
GitHub's documented format includes immutable IDs for new repositories. This is
an inference until a real OIDC assumption succeeds. If actual claims differ,
stop and review the exact subject; never allow a wildcard, legacy-name fallback
or all environments. Do not print JWTs or change repository settings to fit an
overbroad role. [GitHub subject reference](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims).

Set repository variable `AWS_DEPLOY_ROLE_ARN` to the leaf output. Only after review,
set repository variable `ENABLE_DEPLOY_AWS=true`. No long-lived AWS keys, Doppler
token or inherited secrets are needed. Both workflows stay off while the flag is
absent/false. Disabling it stops future runs, not a submitted SSM command.

The deployment role has no direct secret reads, image writes, infrastructure
mutations or worker actions. It can nevertheless execute a shell as root on the
one controller, which indirectly exposes its data/runtime credentials. Treat
this environment as privileged release administration, not a role for untrusted
contributors. Required regional EC2/SSM describe calls have wildcard read scope;
mutation resources remain exact. Provisioning/building use separate roles.

## 3. Real acceptance before release

Dispatch **AWS MVP application rollout (manual)** from `main`, action `status`,
image empty. This checks real OIDC, account, ownership and status without sending
a rollout command. A disabled/skipped run is not successful authentication.
Record the run and assumed role, never credentials. No provider prompt is sent.

Build/publish separately. Dispatch `deploy` with the exact existing
`ECR_URI@sha256:<64 hex>` and check `confirm_rollout`. The engine checks the digest,
drains active work, stops before starting, retains old configuration and checks
database-backed readiness. There is a maintenance gap. `rollback` also requires
confirmation and an empty image field; it restores the retained configuration,
not incompatible database migrations. Use backups and compatible migrations.

Record workflow run, digest, SSM command and HTTPS/app readiness. On observation
timeout inspect the same command using the local wrapper's
`status --command-id`; do not blindly resubmit or reboot. Busy rejection leaves
the current controller running. IAM creation, GitHub activation, real OIDC and
live rollout were not performed by this feature's local tests.

Local checks: `node --test test/aws-ci.test.mjs test/aws-template.test.mjs`.
