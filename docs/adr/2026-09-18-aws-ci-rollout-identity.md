# ADR: a separate, opt-in CI identity for application rollout

Status: accepted for the AWS MVP; infrastructure activation remains explicit.

The application stack and its durable resources must not be changed merely to
enable GitHub deployment. A separate `agent-relay-mvp-ci` leaf stack owns only
the deployment role and, if explicitly requested, a new GitHub OIDC provider.
An existing provider is referenced by its exact ARN and never adopted, updated
or deleted. New providers are retained on leaf stack removal because they may
later be shared. Build/publication/provisioning remain separate from rollout.

The role trusts only this repository's `aws-mvp` environment and the STS audience.
Read-only GitHub metadata on 2026-09-18 confirmed repository creation on
2026-09-14, repository ID `1370075262`, owner ID `648890`, and default OIDC claims.
Current GitHub documentation assigns immutable-ID subjects to new repositories;
the exact subject is therefore pinned with those IDs, without a legacy-name or
wildcard fallback. First real OIDC assumption must still confirm the claim.

The leaf renderer consumes completed, owned application stack metadata. It
allows only exact stack reads, one repository's manifest reads, required regional
describe/status calls and `AWS-RunShellScript` on one controller instance. No
direct secret reads, image publication, CloudFormation mutations or worker/EC2
mutation permissions are granted. SSM shell execution is nevertheless root-level
controller administration and can indirectly reach runtime secrets; only trusted
release administrators may approve the protected environment.

The manual-only workflow pins both shared workflow and engine checkout to the
same reviewed SHA, requires explicit activation and main-branch dispatch, and
does not inherit secrets. No AWS resources, GitHub variables or environment rules
are activated as part of implementation/testing.

References: [GitHub immutable OIDC subjects](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims),
[AWS CloudFormation OIDC provider](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-iam-oidcprovider.html).
