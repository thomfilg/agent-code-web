# ADR 0001: Parallel MVP delivery and explicit acceptance evidence

Date: 2026-09-18
Status: Accepted under the user's six-hour autonomous-work instruction

The user superseded sequential execution with parallel agents and authorized
development, tests, commits, pushes and PR updates. MVP work remains first;
non-MVP work may start only after the complete MVP has been manually verified.

## Decision

- Give each feature an isolated Git worktree/branch and a reviewable PR. Keep
  integration and live-controller activation under the main agent. Preserve
  the unrelated paused Claude doctor work.
- Keep the earlier two-CPU limit and serialize browser suites to avoid
  overloading the user's machine. Use small native checks before expensive
  model tests.
- GitHub and Claude host credentials may be copied into private disposable
  test profiles for the specifically authorized integration checks. This is
  test authority, not a product feature: no host-login import, global account
  switching, credential fallback or cross-user/company sharing in Relay.
  Do not extend this permission to Codex, Linear or unrelated browser profiles.
- Record fixture, native-protocol, real-account and browser-consent evidence
  separately. The user will perform interactive consent tests on return.
  Pending user consent no longer serially blocks implementation of another
  MVP feature, but it still prevents claiming that the whole MVP is verified.
- Make compatible product decisions in feature ADRs. Do not infer authority
  to provision billable AWS resources from permission to implement its deploy
  script. The user subsequently explicitly authorized billable AWS provisioning
  and initially selected the AWS CLI account used by `scripts/tabwhoah` QC tasks.
  The latest explicit target supersedes that reference: newly authenticated
  profile `code-web`, account `456808212788`, region `us-east-2`. STS verified
  the current bootstrap principal is the account root; do not copy those
  credentials to the application or CI. Use scoped runtime/CI roles and create
  isolated Relay resources. The user has no brand/domain yet, so an AWS-assigned temporary
  HTTPS hostname is acceptable; do not purchase a domain or reuse QC resources.

## Consequences

Stacked PRs target the current named-account branch until integration is ready.
Each agent must commit and push its tested feature, report remaining evidence,
and hand off before accepting the next feature. A draft PR or passing fixture
must not be described as a completed real-account or production deployment gate.
