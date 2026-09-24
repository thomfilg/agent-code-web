# ADR 0002: AWS MVP isolation, stable HTTPS and durable single controller

Date: 2026-09-18
Status: Accepted under the user's autonomous MVP implementation authority

## Context

The user authorized billable resources and authenticated `code-web` in account
`456808212788`, region `us-east-2`. There is no brand or registered domain.
Future-pay's deployment documentation delegates reusable deployment machinery
to `12-apps/ci`; its current registry lacks AWS. Relay is a multi-user product,
so shared-host local workers are not the production isolation boundary.

## Decision

- Build the generic AWS CLI/SSM rollout engine and opt-in reusable workflow in
  `12-apps/ci`. Keep only Relay's infrastructure declaration, runtime image,
  thin entry point and operator documentation here. Deploy prebuilt immutable
  ECR digests; building is a separate step, not part of rollout.
- Provision a new tagged VPC, a small single controller (`t3.medium`), separate
  private controller/worker subnets in one AZ, and an outbound NAT gateway.
  CloudFront VPC origin provides a stable `cloudfront.net` HTTPS URL without
  buying a domain. Forward request headers/cookies/query strings and all HTTP
  methods, disable caching/compression and allow WebSocket upgrades/SSE.
  Controller ingress is only from CloudFront; SSH is not publicly exposed.
- Final workers are one-chat EC2 instances without an IAM role, with metadata
  disabled. Only the controller can SSH to them. The controller role can
  create/start/stop/terminate only the deployment's tagged workers, using its
  selected subnet, security group, key and tagged AMI; it cannot pass IAM roles.
  A separate temporary image-builder role has only SSM access and is never
  attached to final workers. No OAuth, Doppler or root AWS credentials go in
  worker images/user-data.
- Preserve state on a separate encrypted 40-GiB gp3 EBS volume. Retain that
  volume, application secret, artifacts and container repository on stack
  deletion/replacement. Mount by verified EBS volume ID; refuse to format a
  disk with any existing filesystem/signature. Keep the application encryption
  key in the deployment secret rather than baking it into the image.
- The single controller owns timers/workers; do not run old/new concurrently
  against one database. Refuse rollout while work or login is active, drain
  new admission, stop the old container, start the new digest, and verify actual
  encrypted database/directory readiness. Roll back to the prior stopped
  container/configuration on failure. A brief explicit maintenance gap is
  accepted for MVP; this is not a zero-downtime or multi-AZ availability claim.
- Source secrets from an explicit separate `code-web` AWS/MVP Doppler config;
  do not implicitly run the cloud controller against local `dev`. Provision
  fresh cloud state, preserving local test data. Google requires registration
  of the new HTTPS callback; no unattended browser consent is authorized.
- The current root CLI session is bootstrap-only. Use instance roles for
  runtime and narrowly scoped GitHub OIDC for CI, not copied root credentials.
  Verify private cross-organization workflow accessibility before enabling CD;
  direct use of a pinned engine revision remains an explicit alternative.

## Costs and limits

Budget expectation for this small topology is roughly US$70–85/month before
traffic, storage growth, image builds and active workers: a controller, NAT,
one NAT public IPv4 and encrypted disks. This is an estimate, not a price cap.
Workers bill while running; stopped workers retain billable EBS. NAT also
charges for processed traffic. No Savings Plan, reservation, domain purchase,
large instance or unrelated account change is included.

## Evidence and acceptance

Infrastructure invariants, readiness failure/redaction, busy/browser drain
rejection and no-cache CloudFront settings have deterministic tests. Cloud
readiness, real integrations, worker stop/resume, backup/restore and failed-
release rollback must be demonstrated separately before declaring MVP done.

References: [CloudFront VPC origins](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html),
[WebSocket support](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html),
[VPC pricing](https://aws.amazon.com/vpc/pricing/),
future-pay `DEPLOYMENT.md` and `12-apps/ci/.github/deploy/README.md`.
