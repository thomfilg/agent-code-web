# Hibernation image diagnostic and continuity boundary

This implements the image-probe portion of
[the hibernation checklist](hibernation-implementation-checklist.md), not product
hibernation. The requested policy remains two-minute idle hibernation and manual
full stop. Runtime admission stays unavailable; no deployment flag is enabled.

## Diagnostic versus admission

The ordinary AMI verifier rejects images carrying a hibernation-candidate tag.
The separate `--hibernation-probe` mode only produces a diagnostic receipt:
`accepted: false`, `productionReady: false`, and
`applicationContinuity.accepted: false`. It cannot create an AMI acceptance tag.
A candidate marker, kernel `disk` capability or hibinit marker file alone is
not evidence of memory survival or application transport support.

This command can launch/hibernate/resume/terminate a disposable AWS worker when
explicitly executed. It was NOT executed against AWS for this implementation.
Use `--dry-run` to inspect the planned actions without an AWS call. Real acceptance
still needs separately coordinated account/deployment/image/resource authority,
current provider prerequisite checks, and confirmation that no live user worker
or browser profile is used.

## Bound worker protocol, schema 2

The fixed controller-side script receives repository-owned probe source. It keeps
the transport key in private controller tempfs, validates the expected worker and
run, pins the SSH host on resume, and sends only synthetic probe arguments to the
worker. The probe runs as the ordinary agent user with a fresh temporary Chrome
profile, private CDP pipes and a mode-0600 Unix socket. It starts no native agent,
provider login or user task.

Both phases bind to `verificationId`, exact `workerId`, and `imageIdentityHash`
(SHA-256 of the existing immutable AMI identity tuple). Each HTTP POST supplies
a fresh 256-bit challenge. A bounded in-memory ledger rejects duplicate and
foreign-bound requests before querying Chrome; failure never triggers replay.
The response contains only allowlisted fields:

- Node and Chrome PIDs plus Linux process-start ticks, and a per-probe instance
  hash. A recycled PID is not a surviving process.
- Boot identity hash and hashes of random Node and browser-page memory values.
  Nothing writes those values to disk.
- HMAC proofs for the fresh challenge and for one run-scoped continuity challenge.
  Fresh proofs must change; continuity proofs must match before/after suspension.
- A strictly advancing request counter. Extra calls, replayed responses or a
  restarted fixture are failures rather than guessed continuity.

The verifier supplies expected binding/challenge values independently of the
receipt and compares both phases. Unknown worker output fields are discarded
before a receipt is published. Neither raw in-memory values, continuity challenge,
private SSH material nor arbitrary errors are included in the result.

These are observations through a trusted fixed operator/controller probe, not
cryptographic attestation of an untrusted kernel or a signed deployment approval.
Synthetic local test responses are protocol tests, never cloud acceptance.

## Exact cleanup and image identity

The verifier mutates only its returned launch ID, rechecking deployment/run/chat
ownership, image, isolation and volume ownership. It never searches for a user's
worker by a broad tag. Missing launch hibernation capability does not erase its
authority to clean up the exact worker it just created. Ownership or isolation
drift still blocks mutation and reports cleanup unconfirmed.

A successful diagnostic is returned only after observed termination and absence
of every discovered disposable volume, followed by another immutable AMI identity
check. Its cleanup receipt lists the exact instance/volume IDs and verification
run. Failed/partial cleanup or changed images cannot produce a passed diagnostic,
and no hibernation image is promoted on either success or failure.

## Required supervisor/application evidence — not supplied here

The transport partition proposes `relay-worker-process/1`. Its actual driver,
not a marker/receipt file supplied by a caller, must exercise the following
against the image probe before a future admission implementation can promote it:

1. Bind deployment, owner, chat, worker, provider, selected account and attempt to
   the same supervisor instance and child process instance/start identity.
2. Detach and reconnect with server-authorized lease generation, retain the same
   in-memory process and explicitly acknowledged output sequence, and demonstrate
   no automatic replay of input, a prompt, approval or tool side effect.
3. Repeat across actual hibernation and controller restart. Reject foreign/stale
   bindings and account/company revocation before any resumed work or capability.
4. Exercise the real idle coordinator, prompt-free wake, stopped/deleted worker
   races and watchdog/heartbeat behavior. No automatic ordinary-stop fallback.
5. Correlate that evidence with this exact run/image/worker, then confirm cleanup.

The currently returned `applicationContinuity` object deliberately cannot claim
those tests passed. The detached Node/Chrome fixture has neither selected-account
admission nor a native process supervisor. A later producer must be implemented
and independently reviewed before replacing this boundary.

## Local validation

The focused Node suite (`test/worker-ami-verification.test.mjs` and
`test/hibernation-probe.test.mjs`) exercises synthetic AWS responses, replay and
identity failures, cleanup ownership, and a real local Node child/socket lifetime
with synthetic browser memory. `test/worker-controller-verification.py` mocks
controller subprocess calls and verifies binding forwarding and secret locality.
The concatenated production browser/probe module is syntax-checked separately.
These checks do not establish Chrome memory survival, actual hibernation, native
provider resume, or a production supervisor/authorization integration.
