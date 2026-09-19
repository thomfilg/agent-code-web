# ADR: controlled failed-rollout acceptance on the existing AWS controller

Status: operator implemented and fixture-tested; live execution is a separate gate.

## Decision

Use the existing private CodeBuild project and immutable ECR repository to build
a deliberately non-starting candidate. The generated ZIP contains **only** a
Dockerfile: `FROM <current healthy immutable digest> AS runner`, two acceptance
labels, `ENTRYPOINT ["/bin/false"]`, and empty `CMD`. No tracked application
Dockerfile is changed, no executable build step is added, and no application
credential or private developer file is uploaded.

The operator defaults to a zero-call plan. Every external phase requires
`--run`, a UUID, the immutable currently healthy image, and the clean shared
engine pinned by `scripts/aws-deploy.mjs`. Build, status and verification are
separate so a timeout is never a reason to blindly resubmit a deployment.

The existing CodeBuild role/source bucket/repository are exact stack-owned
resources. The source object has an immutable S3 version, a unique
`source/rollback-<UUID>.zip` key, and an immutable `rollback-<UUID>` ECR tag.
The build retains its normal narrow role; it never receives application secrets.
The buildspec override only logs in to that ECR registry, builds the generated
Dockerfile and pushes the acceptance tag. Build timeout is ten minutes.

## Verification and safety

The real rollout runs on the existing controller using the unchanged reviewed
`Rollout` class from `12-apps/ci` revision
`848182b33461640e9ac0feb7315f747a67877c88`, under the same host-wide lock. A small
subclass observes prepare/start/readiness; it delegates those operations to the
shared implementation and does not replace its drain, stop, recovery or cleanup.
The engine source is read from a clean pinned checkout, compressed into the
public SSM payload, and checked against its content digest before loading.

Before draining, the current controller must be running the supplied base
digest and be ready. The candidate must have exactly the base image's filesystem
layers and image configuration except the fixed `/bin/false` entrypoint, empty
command and two known labels. Unexpected image contents fail before drain. The
engine retains its busy guard, exact data-volume check, stack ownership checks,
single-controller enforcement, and private runtime environment handling.

The acceptance requires all of these, not merely an expected error message:

- The candidate was created with a different container ID and actually exited 1.
- Its readiness check failed, invoking the real shared recovery path.
- The original **same Docker container ID**, image ID, complete configuration,
  host configuration and mounts returned unchanged and running.
- The stack's mounted persistent EBS volume still validates; database-backed
  `/readyz` is healthy again; the failed candidate is absent.

Docker inspection and application environment values stay in controller memory.
Only allowlisted booleans and public IDs/digests leave the SSM command. The
operator does not write Secrets Manager, create users, bypass Google login,
send model prompts, delete application data or provision infrastructure. The
candidate executes `/bin/false`, not application or migration code.

This is a **planned outage**: the engine stops the current controller before
trying the candidate, waits up to 30 seconds for candidate readiness, then
restarts the original. The original also has a 30-second recovery window. A
slow recovery fails acceptance rather than claiming success; inspect readiness
and the exact command before doing anything else. The shared SSM command has
the normal 3000-second execution budget and is not cancelled on local observer
timeout. Do not kill it while it may be recovering the controller.

Normal engine policy removes an older stopped `relay-previous` before trying a
new deployment. This acceptance can consume that older slot. The currently
healthy container and its full configuration are the rollback target and must
survive. This tradeoff was explicitly approved for the controlled acceptance;
it is not hidden as a read-only check. Source/build/failure-image artifacts are
retained as evidence, not automatically deleted.

## Operator steps

First take/verify the normal backup and ensure nobody is starting work or
authorizing an account. Use the currently deployed full ECR digest, not a tag.
For the initially planned run that digest was
`sha256:d00cf873d34af1676f52b954fc06218f265326c9c172003f51f957a16feb9bb1`;
do not reuse it blindly after another deployment.

```sh
taskset -c 0,1 nice -n 10 node scripts/smoke-aws-rollback.mjs plan

taskset -c 0,1 nice -n 10 node scripts/smoke-aws-rollback.mjs build --run \
  --base-image ECR_REPOSITORY@sha256:CURRENT_DIGEST \
  --acceptance-id NEW_UUID

taskset -c 0,1 nice -n 10 node scripts/smoke-aws-rollback.mjs status --run \
  --base-image ECR_REPOSITORY@sha256:CURRENT_DIGEST \
  --acceptance-id SAME_UUID --build-id PROJECT:RETURNED_BUILD_UUID

taskset -c 0,1 nice -n 10 node scripts/smoke-aws-rollback.mjs verify --run \
  --base-image ECR_REPOSITORY@sha256:CURRENT_DIGEST \
  --acceptance-id SAME_UUID --build-id PROJECT:RETURNED_BUILD_UUID
```

Wait for `SUCCEEDED` before verification. Keep the returned build and SSM IDs.
If the observer loses contact, observe that exact SSM command and current
readiness; do not submit the same test again. An `accepted: true` receipt is
the real rollback proof. Build success, a failed rollout exit code, or a
fixture test alone is not that proof. This does not assert zero data changes
from normal application shutdown/startup; it proves the same controller,
configuration and persistent mount were restored without data deletion.

## Local evidence

Five Node tests cover default zero activity, archive contents, exact versioned
source/build/digest boundaries, SSM payload and receipt redaction, pending builds
and invalid receipts. Five Python tests cover candidate-config/layer admission,
actual candidate exit/failure requirements, exact ID/config/mount recovery,
candidate removal and busy-controller refusal. A separate local fixture also
ran this observer against the **real pinned shared engine's** deploy/recover
methods with host commands mocked. No AWS call, build, deployment or model
request was executed while implementing these tests.

The cross-repository regression is saved and can be repeated against the
pinned engine without AWS or Docker:

```sh
taskset -c 0,1 nice -n 10 python3 -B test/aws-rollback-shared-engine.py /absolute/pinned/ci
```
