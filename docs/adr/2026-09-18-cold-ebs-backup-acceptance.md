# ADR: cold EBS backup with an isolated database-only restore proof

Status: independently reviewed implementation; deployed run pending.

## Decision

Use an operator-initiated encrypted EBS snapshot of the stopped controller data
volume. A host-wide deployment lock spans drain, database fingerprint, snapshot
creation and original-container recovery. A bounded host lease recovers the
original even if the operator exits. An independent systemd timer is armed
before stopping and recovers the exact original after an SSM process-group
cancellation/kill; only verified readiness disarms it. Restore only onto a newly tagged same-AZ
volume, never onto the original data or root filesystem.

Validation uses the original controller's immutable image but overrides its
entrypoint to a database-only reader in `--network none`. Only its effective
encryption key is supplied through a private ephemeral file. The reader checks
all encrypted records and attachment content without starting Relay, workers,
scheduled jobs, OAuth or model clients. The output is aggregate hashes/counts,
not user content. Existing databases need no synthetic chat or consent data.

The source container is restarted/resumed in `finally` and verified healthy.
An unclosed database reader or changed identity blocks automatic recovery to
avoid concurrent writers. Cleanup is exact-ID, ownership-checked and requires
confirmed unmount before detach/delete. Retain the encrypted snapshot on all
paths; only a completed matching restore fingerprint qualifies it as verified.

## Limits

This is the MVP durability acceptance gate, not automatic retention/scheduling
or a production point-in-time recovery service. It has a maintenance gap and
creates a retained billable snapshot. AWS response ambiguity, host failure,
changed ownership or failed unmount may leave exact tagged resources for manual
inspection; safety takes precedence over forced cleanup. The controller role
does not receive operator backup privileges. Details and recovery constraints
are in [BACKUP.md](../../deploy/aws/BACKUP.md).

## Evidence

The bounded independent review found missing recovery after an SSM process kill
and an asynchronous helper-publication race. Independent systemd recovery,
private atomic helper publication/readiness, bounded probe/release waits and
interrupted credential-file cleanup address those findings. Local validation
passes 9 Node checks (including an actual temporary PostgreSQL copy) and 8
Python host-state checks. No AWS resources were read or mutated by that test
run. Only the authorized operator's deployed execution can close acceptance.
