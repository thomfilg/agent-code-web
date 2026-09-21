# EC2 hibernation and application-transport acceptance — September 21, 2026

This receipt records the first live AWS acceptance for the process-preserving
worker candidate. It does **not** activate automatic hibernation. Production
continues to use the ordinary worker image and the default `stop` policy.

## Exact scope and result

- AWS account `456808212788`, region `us-east-2`, deployment
  `agent-relay-mvp`.
- Accepted private candidate: `ami-0996341aaa0329b03`.
- Acceptance ID: `88114245-968d-4037-9abf-b14ec810be7c`.
- Fresh and resumed SSM probes:
  `fb547302-d2d8-469a-afc8-c52a98625de7` and
  `36bb7827-c3bd-4a93-bb75-275436ba20a9`.
- The exact disposable worker `i-0b9dd69fc15573a8e` was terminated and its one
  encrypted disposable volume was confirmed deleted before the acceptance tag
  was written.
- No provider prompt was sent and no account was imported.

The candidate booted without an instance role, public IP or IMDS. The fresh and
resumed receipts matched the machine identity, all three reviewed SSH host-key
families, a disk sentinel, kernel/process identity and a worker-owned native
process.

The stronger application gate transferred the exact nine-file supervisor
allowlist used by the EC2 backend, started an unauthenticated installed Codex
0.154 app-server, completed its local `initialize` request, committed the
output cursor and disconnected. After EC2 hibernation, a new controller probe,
SSH connection and supervisor lease attached to the same supervisor instance,
process instance, PID, start identity and cursor. A local `thread/list` read
completed without a prompt, and `inputAcceptedThrough` advanced exactly from 2
to 3. A replacement process or replayed input would fail the receipt. The
process was then explicitly terminated, its output acknowledged, and its
supervisor slot released before instance cleanup.

The run exposed and fixed four fail-closed acceptance issues before passing:

1. Jammy generated an obsolete DSA host key in addition to reviewed families;
   the image now creates only RSA, ECDSA and Ed25519 host keys.
2. EC2 initially reports a newly booted instance as not ready to hibernate; the
   verifier now retries only that exact allowlisted response while rechecking
   ownership before each mutation.
3. The user service can be `active` shortly before its control socket opens;
   both acceptance and production backend now use a bounded socket-readiness
   wait without reinstalling or duplicating the daemon.
4. The acceptance probe now validates the public supervisor receipt fields
   (`inputAcceptedThrough` and `state`) rather than internal implementation
   names.

Focused verifier, image, controller, backend and supervisor suites passed after
the fixes. The final complete `npm run check` passed **1,656**, failed **0** and
skipped **4** optional cases (**1,660 total**). Every failed cloud attempt also
confirmed termination of only its tagged disposable worker and deletion of its
encrypted volume.

The superseded, unaccepted candidate `ami-0ef9891cb87e2fc61` had no live
instances. It was deregistered and its exact encrypted snapshot
`snap-07f8c14411d9ad24c` was deleted after the stronger candidate passed.

## Production boundary

An independent SSM read of the running `relay` container found
`AGENT_WORKER_BACKEND=ec2`, ordinary production image
`ami-06f979453243f2fc1`, and no `AGENT_IDLE_POLICY` override. The effective
policy therefore remains the documented default `stop`.

Activation remains blocked on the still-open checklist items: live Chrome and
renderer preservation in AWS, repeated hibernation cycles and connection loss,
an actual controller service/instance restart while a worker is retained,
synthetic revocation/expiry on the cloud path, explicit Stop/Delete and failed
rollout exercises, and a reviewed migration/rollback plan. The accepted image
tag is necessary evidence, not authorization to enable the policy.
