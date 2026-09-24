# Copy a proven final answer

`/copy` is a local web control. It never sends a model prompt, starts a worker,
changes the queue, or infers completion from the last assistant transcript row.
The shared `public/completed-answer.js` selector also governs assistant-answer
eligibility in message search. It requires version 1 final provenance with the
matching Codex, Claude or mock provider, bounded nonblank text, and excludes
commentary, interrupted, generated, GitHub-event and rendering-sample rows.

The copied value is the stored, server-sanitized final projection, not the
concatenated display text. An empty segmented display suffix can still carry a
valid final projection. Later commentary does not displace that final answer.
Older/unclassified responses are intentionally unavailable rather than guessed;
the command remains in the composer with an explanatory error if none qualifies.
The transcript controls remain available separately.

Clipboard denial opens the existing literal-text manual-copy dialog. An operation
already submitted to the OS clipboard cannot be revoked by navigation, but its
late success/failure must not open UI or clear the draft after changing chat—even
when the user returns to the same chat. The selection epoch fences those effects.

Official Codex `/copy` reference: [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands).
The native meaning is latest completed output; this web implementation additionally
uses explicit final provenance to avoid copying intermediate or interrupted output.

Validation on 2026-09-19, serial on two CPUs:

- `node --test --test-concurrency=1 test/completed-answer.test.mjs test/message-search.test.mjs`: 11/11 passed, 3.43 seconds, no skips/cancellations.
- Playwright `copy-final-answer.spec.mjs`, `controls.spec.mjs` and `message-search.spec.mjs`: 15/15 passed, 29.1 seconds, one worker and zero retries. Five new cases cover exact final copy, missing provenance, denied clipboard, and held clipboard success/failure across chat navigation.
- Syntax and `git diff --check` passed. Independent source review found no blocker before the test run; source stayed unchanged during validation.

The original selector chose the last assistant row with nonempty display text,
so the regression fixture's later unclassified output displaced its real final
projection. The corrected tests assert exact clipboard text and zero create,
send, queue, wake, start or stop requests. Native CLI execution, real account/profile
access, real model calls and deployment were not performed.
