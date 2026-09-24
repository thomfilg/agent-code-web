# Auto mode and automatic chat titles

Integrated application source: `294dfe3` on `feat/codex-account-login`.
Components: Auto `a5a967e` (#56), titles `77aa65e` (#55).

- Claude mode changes now reach the running native session, require exact
  acknowledgement, preserve ongoing work and reconcile native policy statuses.
  They do not approve pending requests or bypass native restrictions.
- Automatic placeholder chats receive a bounded provisional title from their
  first substantive user request before startup, without another model call.
  Task-bearing `/goal` and `/plan` inputs are included; control-only commands,
  injected prompts and attachment contents are excluded. Credential-shaped
  input receives a neutral label; this is conservative screening, not a claim
  to detect arbitrary secrets.
- Existing placeholder chats recover on their next accepted message. Model
  titles can replace provisional names; manually chosen names are preserved.
- Claude background replies now retain their parsed title metadata.

Clean-worktree integrated verification: **205/205 Node tests**, serial, zero
failures/skips/cancellations. Suites cover Claude settings/session/control/trust,
runtime, queue, titles and workflow. Individual components additionally passed
184 Node + 5 browser (Auto) and 28 Node (titles); these counts overlap and must
not be added together. Adversarial review covered control acknowledgement and
event ordering, Stop/rebinding, pending persistence and manual-title races.

This is source/test integration only. No controller deployment, active-worker
restart, pending approval response or saved browser-profile operation occurred.
Real selected-account native acceptance after publication is not claimed.
