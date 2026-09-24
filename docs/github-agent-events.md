# GitHub PR/check notifications

This component implements per-PR agent notifications (MVP 35) and signed event-triggered status refresh with polling reconciliation (MVP 36). It does not deploy, register a real webhook, change GitHub permissions, merge a PR or change branch rules.

## Operator and user controls

- The operator supplies a high-entropy `AGENT_GITHUB_WEBHOOK_SECRET` and separately registers the public HTTPS `/webhooks/github` endpoint for `pull_request`, `check_run`, `check_suite` and `status` events. The endpoint verifies raw-body HMAC-SHA256; browser session cookies cannot substitute for a signature. Remote webhook registration and its permissions require separate coordination.
- Without that secret, the endpoint is unavailable and the UI says polling. Existing polling still reconciles approximately every minute.
- On a tracked PR's checks menu, **Notify agent when checks fail** and **Wake this chat when checks pass** are independent, initially off. Wake consent includes a worker-time/model-token confirmation. Enabling a subscription establishes a baseline; an already-green PR does not immediately start work.
- Failed checks remain pending while the worker is stopped. Passing checks can wake only the explicitly subscribed, authorized chat. Busy chats receive events through the ordinary FIFO, without interruption. An independently paused user queue stays paused.
- Stop in the owning controller wins pending/in-flight startup races. Removing a queued notification durably cancels it. Disabling consent works without upstream access or an active agent credential, including closed PRs.
- After uncertain native delivery, inspect the conversation before choosing **Review and retry notification**: retry may repeat work. Recovery never automatically replays an ambiguous native turn. **Discard notification** is available without retrying it.

The event message is fixed external-status data, with `meta.source: "github"` and its durable event ID. It is not user-authored content, a new merge authorization, a PR body or a check log. Admission binds the exact owner, company, connection/account identity, numeric repository identity, PR/head/check-run fingerprint, named agent account, provider and environment identity. Revocation, stale refreshes, changed ownership and missing durable scope fail closed.

See the [design and boundaries](adr-github-agent-events.md), including exclusive event-dispatcher ownership versus the application's broader single-controller lifecycle, explicit standby acquisition, storage limits and uncertain delivery semantics.

## Local validation receipt

Final feature run on this component's source:

- **33/33 Node cases**, zero failures/skips/cancellations, 10.85 s. Four files: `github-events`, `github-event-runtime`, `github-event-postgres`, `github-event-http`.
- **35/35 existing shared-code cases**, zero failures/skips/cancellations, 5.97 s: `session-queue`, `workflow` and `chat-controls`, covering ordinary queue behavior, PR polling and explicit auto-merge controls.
- **2/2 serial browser cases**, zero retries, 12.0 s; repeated with screenshot capture in 13.2 s: default-off independent opt-ins, wake confirmation/cancellation, reload, 320/390 px layout, closed-PR consent reduction, and explicit uncertain-delivery review.
- Final desktop/390 px screenshots were recaptured in a **1/1** no-retry run (6.8 s) after filling the fixture's ordinary CI/diff counters. No application behavior changed; final images show numeric counters and unclipped notification controls.
- Real disposable PostgreSQL: CAS, deferred-COMMIT failure, absent revocation marker locks, exact-session logout queued before consent commit, dispatcher contention/release, termination of the exact owned lock session, encrypted records, and database reopen/service replacement without replay.
- Actual loopback HTTP route: raw signature verification, duplicate delivery, stale subscription revision, held-request logout/owner change, safe retained hints, and zero GitHub mutations.
- Runtime fixtures: busy user/event FIFO, stopped failure versus authorized passing wake, paused user queue, Stop during startup and across held validation, late connection revocation, and durable queue dismissal.

Initial failures were retained during development: the first Node run had 27/29 passes (missing generated auth prerequisite and an absent-queue assertion); the second had 28/29 (CAS denial was HTTP 400 instead of the intended 409). These were corrected. The first two browser cases timed out because the real sidebar refresh overwrote the injected fixture's PR metadata; the corrected fixture models both API snapshots without weakening behavior assertions. Final results above apply after those corrections and the additional request/session fences.

These tests use synthetic accounts, fake GitHub responses and in-process native adapters. They do **not** prove a real GitHub delivery, cloud wake, paid model turn or production rollout. No real account, repository webhook, credential scope, browser profile, worker or cloud resource was changed. Background notification consent remains off by default, and production activation is separate.
