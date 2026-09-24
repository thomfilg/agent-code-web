# MVP encrypted backup/restore acceptance

This is an explicit operator acceptance check, not a scheduled backup service.
It incurs one retained encrypted EBS snapshot and a temporary encrypted restore
volume. It briefly stops the controller and **never** sends prompts, authorizes
accounts, creates user chats, starts workers, or imports local credentials.

The target is deliberately fixed: profile `code-web`, account `456808212788`,
region `us-east-2`, application stack `agent-relay-mvp`. STS, stack resources,
instance tags/private address/state, and exact encrypted data-volume attachment
are checked before any mutation. There are no override flags for these targets.

```bash
# No AWS calls or changes:
taskset -c 0,1 nice -n 10 node deploy/aws/verify-backup.mjs --dry-run

# Explicit maintenance operation, only after application readiness is proven:
taskset -c 0,1 nice -n 10 node deploy/aws/verify-backup.mjs --run
```

The operator needs scoped CloudFormation/EC2/SSM reads, SSM SendCommand for the
exact controller, CreateSnapshot/CreateVolume/AttachVolume/DetachVolume/
DeleteVolume for this source and tagged test resources, and use of the source
volume's KMS key where applicable. The controller role does not gain snapshot
or restore permissions; the local operator performs these AWS operations.

## Sequence and boundaries

1. A static SSM helper holds `/run/12-apps-controller-rollout.lock`, the same
   host-wide lock used by deployment/rollback. It validates Docker ownership,
   immutable image, data layout, source EBS serial/mount and readiness. Another
   running container overlapping the data mount prevents acceptance.
2. Drain refuses busy work. Only the exact original `relay` Docker ID is stopped.
   A transient reader uses the **same local image ID**, `--network none`, UID
   1000, no capabilities, read-only root filesystem and a private tmpfs. Its
   entrypoint runs only existing embedded PostgreSQL plus a read-only SQL
   transaction; it never initializes a database or starts the Relay server.
3. The reader decrypts every record, verifies `system/encryption-check`, and
   returns only aggregate ciphertext hashes/counts and decoded attachment
   hashes/counts/byte totals. No record names, IDs, payloads, tokens or passwords
   are printed. The effective app encryption key is passed in a root-private
   0600 `/run` env file, immediately removed; unrelated app secrets are omitted.
4. While the controller remains stopped, the operator creates a snapshot of
   the verified source volume. Once AWS returns its snapshot ID, the operator
   releases the lease. `finally` restarts the **same** original container and
   resumes admission, then proves readiness. If the operator disappears, the
   host's 180-second snapshot lease expires and attempts this same recovery.
   Before draining, an independent systemd recovery timer is also armed for
   ten minutes. It survives SIGTERM/SIGKILL/SSM cancellation, takes the same
   rollout lock, stops only this run's labelled database reader if needed, and
   recovers the exact original. It is disarmed only after normal readiness.
   Host operations are bounded and the enclosing SSM budget includes recovery.
5. After snapshot completion, a new encrypted, same-AZ volume is created with
   an idempotency token and exact run/deployment/purpose tags. It attaches only
   as the unused `/dev/sdg` slot, never replacing `/dev/sdf` or the root disk.
6. The host identifies the restore NVMe device by the new volume's serial,
   verifies unmounted ext4, and mounts the explicit device at a run-specific
   `/run` directory. It never formats, repairs, edits fstab, mounts by UUID,
   copies restored data onto the source, or starts another Relay controller.
   The database-only reader compares the restored fingerprint with the cold
   source fingerprint and confirms the original controller is still healthy.
7. Exact unmount confirmation precedes detach. Ownership, snapshot source,
   encryption, AZ and attachment are rechecked before deleting **only** the
   temporary restore volume. Exact `InvalidVolume.NotFound` is observed before
   claiming removal. No force-detach or snapshot deletion exists.

## Failures and recovery

Every stage emits only the run ID and relevant command/resource handles.
Preserve those handles. AWS/SSM output and private Docker diagnostics are not
forwarded. A command-observation timeout is not evidence that it did not run;
do not blindly repeat a mutation. The snapshot is retained even if later
verification fails. A retained snapshot is **not** automatically a verified
backup; only the final `verified: true` result proves this gate passed.

The host recovers the original container on preparation/snapshot-lease errors.
If the database-only reader cannot be stopped, recovery deliberately refuses
to start another writer against that data. If Docker identity changes, mounts
are unexpected, unmount is unconfirmed, or resource tags do not match, automatic
cleanup stops. Inspect the emitted exact IDs; retain the test volume until the
reader is gone and the device is demonstrably unmounted. Never use broad tag
deletion, force detach, formatting or guessed device names as recovery steps.

If AWS creates a resource but its response is lost, its run tag identifies it
for **read-only inspection**; the script does not guess or automatically delete
resources discovered by a broad search. A controller/host crash can still need
manual recovery. A permanently unavailable Docker/AWS service cannot be made
safe by claiming completion or repeatedly retrying mutations.

Temporary control metadata and helper source remain root-private under the
run's `/run/relay-backup-*` paths until reboot; they contain only IDs and
aggregate fingerprints, never the removed env file. No application database
marker is needed or created. Existing empty databases are valid if their
encryption sentinel verifies; zero attachments is reported honestly.

## Local evidence versus deployed acceptance

Run the fixture suites before invoking the operator:

```bash
taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 test/aws-backup.test.mjs
taskset -c 0,1 nice -n 10 python3 -B test/aws-backup-host.test.py
```

They verify denial before mutation, exact cleanup, finally recovery, failed
cleanup retention, encrypted payload/attachment fingerprints, private reader
flags and a real temporary PostgreSQL stop/copy/reopen. Those local checks do
not prove EBS/SSM acceptance. Record the actual final run/snapshot IDs only after
the authorized operator executes the deployed check successfully.

The stop/flush/resume sequence follows AWS's guidance for a consistent
[EBS snapshot](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-creating-snapshot.html).
Snapshots of encrypted volumes and volumes restored from them inherit
[encryption](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_CreateSnapshot.html).
