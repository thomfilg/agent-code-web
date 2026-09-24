# Automatic deployments must preserve running workers

## User requirement

On 2026-09-18 the user clarified that **automatic deployments must not bring
down instances that are already running**. The same conversation explicitly
permits interruptions for today's manual setup/update. That exception is not
standing authorization for disruptive automatic deployments.

## Current limitation and boundary

The current single-controller shutdown stops its chat executors and calls the
EC2 worker sleep path. Its drain check tracks active turns and known workflows,
but a retained native Bash task can outlive a turn without being reported busy.
Therefore neither a healthy `/readyz` nor a successful drain proves an update
will preserve running tasks or worker instances.

The AWS workflow remains **manual-only**, off by default, with explicit rollout
confirmation and a pinned engine. The existing `test/aws-ci.test.mjs` regression
rejects push, PR, schedule and workflow-run triggers. Do not enable automatic
rollout with the current disruptive shutdown path.

## Acceptance required before automation

- Updating or rolling back the controller must not stop, terminate, replace or
  recreate existing running worker instances as a deployment side effect.
- Preserve their instance identity, files, running applications/background
  tasks and chat ownership/account boundaries. Reconnecting the controller
  must not replay user prompts, lose queued messages or spawn duplicate workers.
- Separate controller handoff/reconnection from an explicit user-requested
  worker Stop/Delete. Normal product idle management is not permission for
  deployment-triggered shutdown.
- Test a live task and application across a deployment and a failed rollout/
  rollback, including late native task reports and controller reconnection.
- If continuity cannot be established, automatic publication must stay blocked;
  it must not silently use the manual interruption exception.

This records a required deployment capability, not a claim that worker-preserving
controller handoff has already been implemented.
