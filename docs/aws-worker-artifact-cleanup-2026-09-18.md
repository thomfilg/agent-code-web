# Scoped failed-worker artifact cleanup — 2026-09-18

Explicitly authorized cleanup completed before12:57UTC in account
`456808212788`, region `us-east-2`, deployment `agent-relay-mvp`.
Only these two failed test/bake pairs were removed:

| Rejected AMI, deregistered and observed absent | Exclusive snapshot, deleted and observed absent |
| --- | --- |
| `ami-0511b35c0d21d5ee0` | `snap-043571647a26cd803` |
| `ami-01358e3a58d2e7d20` | `snap-00e0be880a8c1bde0` |

The first had failed credential/metadata acceptance; the second had failed the
unexpected-authorized-key audit. Neither had the `verified-v1` acceptance marker.
This was normal cleanup of those rejected test artifacts, not deployment teardown.

## Guards and observed execution

- STS account verified. Each exact image and snapshot was private, owned by this
  account, and carried only the expected `ManagedBy=agent-relay`, deployment,
  worker-key and pinned Codex/Claude version tags. Both EBS snapshots were
  encrypted20GiB images. No acceptance marker was present on either rejected AMI.
- Image launch permissions and snapshot restore permissions were empty. No
  instance or volume references were returned. The complete owned-image listing,
  including deprecated/disabled images, showed no other AMI using either snapshot.
- Read-only SSM command `10bbfb7c-0b85-4f35-8af0-82a1260d4551` confirmed both
  stack-owned `relay` and `relay-previous` configurations selected accepted
  `ami-06f979453243f2fc1`, with only the current container running. Environment
  contents were processed in memory and never printed; only booleans/public AMI
  identity were returned.
- Preconditions were rechecked immediately before each pair. Each AMI was
  deregistered without automatic associated-snapshot deletion, then exact absence
  was observed. Snapshot ownership, sharing and all owned-AMI references were
  rechecked before deleting that exact snapshot and observing its absence.
  No automatic mutation retry or broader resource selection was used.

## Preserved and recovery boundary

Post-cleanup reads confirmed accepted `ami-06f979453243f2fc1` still exists with
`verified-v1`, and its encrypted snapshot `snap-0d92de1d7cb3a63e6` remains present.
The explicitly retained cold backup `snap-08d0e108e9596b5df` also remains present.
No instance, volume, controller configuration, credential, database or application
data mutation occurred. No additional test resource was created.

These artifacts were removed, not stopped or archived. Treat the cleanup as
irreversible; no recovery of the old artifact IDs is promised. A replacement can
be freshly baked from the reviewed source recipe and must pass fresh acceptance
before admission. The retention decisions for the accepted image and cold backup
remain in force. This receipt does not authorize any further cleanup.
