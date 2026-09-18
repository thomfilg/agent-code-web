# Prepare the worker before preview bootstrap

CloudFront waits 60 seconds for an origin response, while waking an accepted EC2
worker can need longer. Opening a ready hostname must not place that cold wait
inside the first application request or retry an application mutation.

`POST /api/chats/:id/app-preview/open` first validates the existing owner, Google
session, chat, fixed port, generation and normalized app path, then returns HTTP
202 with `{warming:{id,status:"pending",retryAfterMs:1000}}`. An in-memory job
holds only that chat's `PreviewActivity` lease; it does not create an agent turn,
send a prompt, connect to the app port, or assert that the application is running.
The hostname's `ready` status remains a hostname status.

The existing isolated blank tab and dialog display worker preparation progress.
The UI polls the same Relay endpoint with the same target and `warmingId`, with
a 30-second per-request timeout and a 250-second overall bound. This is not a
retry of any request to the worker application. Only a completed job can mint
the existing trusted Relay bootstrap URL. Opener isolation and noreferrer
navigation are unchanged.

Jobs are owner/session/chat/port/hostname/generation/path bound, capped at 16 total
and 4 per owner, and expire no later than 240 seconds or the Google session
deadline. Polling cannot extend that deadline. A poll with a missing, consumed,
cancelled or mismatched ID fails; it never implicitly starts a new-generation
worker after Stop. Every poll rechecks the durable session, and completion
rechecks scope after acquisition. Stop, logout, chat deletion, hostname revoke,
shutdown and expiry release only the affected hold. A late acquire cannot mint
access or retain a released hold. Ready jobs retain their bounded slot until
consumed or expired. Warming contributes to deploy-drain activity.
Cancelled/expired jobs whose backend acquisition is still outstanding keep their
capacity and drain reservation until that acquisition actually settles.

Closing the dialog/tab stops frontend polling; the server job remains bounded by
its fixed deadline (or an explicit lifecycle revoke). Consuming a ready job
releases its hold after creating the bootstrap; the existing worker idle grace
covers the browser's short cookie bootstrap. No SSH or EC2 cancellation semantics
are changed: invalidation cancels preview admission/holds, not an already-issued
AWS create/start command. The runtime's existing lifecycle owns worker cleanup.

Fixtures cover gated acquisition/fast 202, no pre-ready grant, deduplication,
session/generation invalidation, late completion, expiry, owner isolation,
drain accounting and visible polling. They are not a deployed cold-EC2 result.
