# Ambient notifications and workflow completion

Claude's native task telemetry is not always a queued model report. The locally
installed 2.1.222 package was inspected statically, without invoking a provider or
reading profiles: `Lf` forwards `skipTranscript` as `skip_transcript`; auto-dream
completion/failure (`RId`/`LId`) and auto-mode scan completion (`ndi`) mark their
housekeeping task notified and emit `skipTranscript:true`, without enqueueing a
report. The task schema describes these as ambient/housekeeping telemetry.

Previously an untracked completed/failed notification entered Relay's report FIFO
even with that exact flag. A later real Agent report could consume the phantom
entry, leaving the actual completed Agent permanently busy. Interrupting the idle
native owner then timed out with “Native workflow report did not acknowledge
cancellation; the queued message was not sent.”

Relay now excludes only **untracked** notifications with `skip_transcript === true`.
Unknown report-bearing notifications remain in order; a bound workflow still
requires its matched terminal event and actual report. Session, parent and tool
identity checks are unchanged. There is no timeout-based dropping, text-based idle
inference, automatic replay, process restart or change to native cancellation.

The synthetic regression reproduces the exact cancellation error before the fix,
then verifies the final report releases its real Agent, no phantom interrupt is
sent, and a follow-up uses the same owner. Other cases preserve unknown reports,
multiple-task FIFO, duplicate ambient telemetry, and strict bound-task identity.

This is a reproduced source defect consistent with the reported incident, not a
proven reconstruction of that production session. Its native journal did not
retain the wire-level result origins or task-notification flags. No production
session, queued message or native process was modified by this patch.
