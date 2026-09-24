# Automatic pull-request follow-up — September 19, 2026

This receipt covers the change from optional check notifications to automatic,
exact-chat follow-up for pull requests returned by an agent tool. It records the
local release-candidate checks first; deployment identity and production
acceptance are appended only after an actual rollout.

## Behavior and scope

- A verified GitHub PR URL in a tool result creates an automatic subscription
  bound to the originating owner, chat, company, environment, selected numeric
  repository, GitHub connection/account and named agent account.
- Failed checks, merge conflicts, submitted reviews, inline review comments and
  PR Conversation comments wake that exact stopped chat. Busy chats are not
  interrupted; the event joins their FIFO. A manually paused ordinary queue is
  not resumed by the event.
- Follow-up reaches green only when canonical checks pass and GitHub reports no
  merge conflict. Manual Stop and scope/account/repository revocation continue
  to fence late delivery.
- Activity authored by the selected GitHub account is excluded to prevent a
  self-trigger loop. Review/comment bodies are not retained in control-plane
  events or copied into prompts.
- The worker receives one fixed read-only tool,
  `github_get_pull_request_follow_up`. It revalidates the exact selected
  repository, branch and open PR, then returns bounded current checks, failure
  annotations and the three review/comment surfaces. It exposes no token or
  generic GitHub API and cannot merge, approve, comment, change PR state or
  alter repository settings. All returned upstream text is labeled untrusted.
- PRs mentioned only in assistant prose still receive a status card but do not
  opt the chat into worker/model wakeups. Unrelated manual subscriptions remain
  off by default.

## Reference implementation finding

Inspection of `thomfilg/ai-plugin-work`'s `follow-up-pr` found that it reads
submitted reviews and inline review comments but omits general PR Conversation
comments from `issues/{number}/comments`. The bug is tracked as
[thomfilg/ai-plugin-work#810](https://github.com/thomfilg/ai-plugin-work/issues/810).
The Relay implementation includes all three surfaces.

## Local verification

- Focused Node/security integration: **76 passed**, zero failures/skips.
- Focused automatic-subscription browser flow: **3 passed**, zero retries.
- Complete Node suite after the final tool-catalog update: **1,595 passed, 0
  failed, 4 skipped** (1,599 total). Syntax validation passed for all source,
  public, script, test and extension JavaScript modules.
- An earlier complete run exposed one stale assertion that still expected two
  GitHub worker tools. It was tightened to assert the exact three names. The
  same run also experienced an unrelated embedded-PostgreSQL administrator
  shutdown; that six-case PostgreSQL group passed in isolation and the full
  repeat passed.
- The three new browser cases passed again alongside the previously failing
  baseline cases. Of those unrelated cases, failed-disconnect retry passed;
  account-selection readiness and held app-preview launch still fail as before.
  These failures do not exercise PR monitoring, GitHub events or the GitHub
  worker MCP.

No GitHub merge, review, comment, branch-rule change, provider consent, account
import or production mutation was performed by the local tests.

## Publication and production acceptance

Pending at this checkpoint.
