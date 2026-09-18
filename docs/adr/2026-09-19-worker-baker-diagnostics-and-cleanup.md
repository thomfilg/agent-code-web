# Safe baker diagnostics and confirmed cleanup

Status: implemented; no running bake was changed or interrupted.

The previous generic AWS error hid actionable categories, including the
oversized user-data failure, and the finalizer logged "Terminated" immediately
after requesting termination. Neither behavior provided sufficient evidence
for an operator deciding whether another bake was safe.

Decision:

- Classify subprocess failures using fixed, allowlisted service/action pairs
  and AWS error codes only. A recognized CLI error envelope must match the
  invoked action. Unknown stderr, stdout, argv, profiles, payloads, paths and
  exception causes are never carried into the error. Timeout, missing CLI,
  output-limit and malformed JSON have fixed local categories.
- Retry `InvocationDoesNotExist` only when classified from the SSM
  `GetCommandInvocation` error envelope. A substring in an arbitrary error
  cannot trigger this retry. SSM failure status is separately allowlisted.
- Supply the unique bake UUID as the EC2 launch client token, matching the
  instance's bake tag. This supports SDK/CLI request retries without broad
  reconciliation, adopting other instances or launching another attempt.
- Before any termination request, revalidate the exact instance ID, base AMI,
  every deployment/worker-key/version ownership tag, bake tag, private network,
  key and exact account/profile ARN. Observe termination with the same identity
  and tags. Only read-only `shutting-down` or `terminated` observations tolerate
  EC2 removing network/profile attributes during shutdown.
- Return `cleanedUp: true` and log confirmed termination only after observing
  `terminated`. Timeout, disappearance or changed ownership fails closed;
  preserve the earlier bake failure and explicitly mark cleanup unconfirmed.
  Existing AMIs/snapshots remain retained for inspection, as before.

Offline fixtures cover scoped cleanup races, detached terminal networking,
changed ID/AMI/tags, never-terminated instances, preserved bootstrap errors,
idempotency token, malformed responses, eventual-consistency retry and secret
strings in every rejected diagnostic field. No AWS operation or running bake
was performed by these tests.

Retained limitation: if the launch response is lost before its instance ID is
captured, this operator cannot prove cleanup of that unknown outcome. The
client token protects retries of the same request, not a separately started
bake with a new UUID. Inspect the deployment's exact bake-tagged resources
before retrying; this change deliberately adds no automatic adoption or broad
instance cleanup.
