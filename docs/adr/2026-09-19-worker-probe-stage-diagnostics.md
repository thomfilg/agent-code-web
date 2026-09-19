# Stage-only diagnostics for failed private-worker audits

Status: implemented; the observed fresh-VM failure remains undiagnosed until
the operator runs another scoped probe. No additional bake is required for
this controller-delivered diagnostic change.

The previous worker probe collapsed unexpected failures into
`invalid-worker-receipt`. The latest fresh VM produced that category, which
did not establish whether the error came from native version checks, the root
helper, decoding its result, heartbeat access or the persisted sentinel.

Each probe operation now sets a fixed stage name. Failure receipts may include
only that stage, an allowlisted Python exception class, and—when root helper
stdout is not JSON—an allowlisted exception class parsed locally from its
private stderr. A helper traceback line number is included only for the exact
installed helper path and within 1..10000. Arbitrary paths, source lines,
traceback text, exception messages, stdout and tokens are never emitted.
The worker and controller independently validate these fields; the operator
formatter applies the same allowlists before displaying them.

The existing audit boolean/count predicates, retry policy, SSH pinning and
cleanup rules are unchanged. Tests now execute the complete rendered image
helper top level under a mocked OS as well as its individual functions.
These tests passed without reproducing the real failure, so they are not
evidence that the image passed AWS acceptance.
