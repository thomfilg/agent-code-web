# Chat activity publication

Published and independently verified on 2026-09-19 at 00:07 UTC (September 18, 21:07 in Sao Paulo).

## Published scope

- Composer Stop / Escape interrupts the native turn, preserving the session, messages and worker. If input is queued, the next FIFO message is sent immediately. Explicit Stop worker remains separate.
- Working / Starting indicator with elapsed time, Escape guidance and active-tool count.
- Native Codex message boundaries preserve paragraphs rather than concatenating separate commentary updates.
- Commentary alternates with inline action groups; nested disclosures expose command/input, output and exit status. Disclosure state and keyboard focus survive streaming updates. Completed tools retain their original chronological position across reload.
- Old stored output with lost commentary boundaries is not heuristically rewritten. Internal reasoning events remain excluded.

## Exact release and deployment

- Runtime source: `4c45f1691e98c4036b95686f75263d5513a17657`.
- CodeBuild: `ImageBuild-t8BSbSkDsHYX:3ecd30ad-0237-429d-b184-0635ccfe7295`, SUCCEEDED.
- S3 source version: `OGbsnLBhOlVYtmrUe1hBTxjy5gAQRsK9`.
- Immutable image: `456808212788.dkr.ecr.us-east-2.amazonaws.com/agent-relay-mvp-applicationrepository-sujdgarjwejp@sha256:fd5f73382a35a710e05993b35492cadfc93885d56ae8cf48f2f82f703ad38328`.
- Manual rollout SSM: `83b0fc76-ed9e-4cda-b3a6-d39f2f5e3c28`, Success / 0.
- Independent running-image/readiness SSM: `d8482a05-a40c-49ee-854f-99223b72f607`, Success / 0; exact image matched and container was running.
- Public origin: https://d20atclccf8cku.cloudfront.net . Readiness returned 200 and anonymous `/api/chats` returned 401.
- The one scoped worker, `i-0bdd4bb50c3010e47`, was already stopped before rollout and remained stopped afterward. No worker deletion or data migration was performed. The manual interruption authorization was not needed for an active worker.

All five changed public assets matched the clean release's SHA-256:

| Asset | SHA-256 |
| --- | --- |
| app.js | b8e4878edb197cfb32743a93064eb9dcb5cd50a9706404ad178360ba0082757e |
| styles.css | 528d4053bb2493444efda0b90eaee925de41081e998ebfa09deac632acb1e6a5 |
| index.html | ffa69d8979de223836e747a89e84efa5be3aebdacdc14a8a1b6132e45f56111a |
| tool-activity.js | a6ea9dbef80da35095b3056e1cbce0221de035421ae307f6a11d31d9a8f5a056 |
| working-status.js | 7ad4176d86de7f6a02e8ea978bcc30fd13c288e47f8799e56ff0a2e3981547ed |

## Verification and limits

In a clean detached release worktree, 42 focused Node tests passed across activity-timeline, session-queue, runtime-manager, codex-message-boundaries, working-status and adapters. Six Playwright cases passed without retries: inline activity/disclosure preservation, 25-tool grouping, compact queue/draft behavior, message paragraphs/reload, live working indicator/Escape, and failed interruption recovery. Heavy tests used two-CPU affinity, nice 10 and one worker. These repeat/overlap earlier local receipts, not additional unique coverage. `git diff --check` passed.

All 13 deployed GitHub/MCP denial probes passed. Those establish rejection behavior, not authenticated provider acceptance. One probe's wall-clock elapsed measurement was negative; timings are not used as latency evidence. No real model prompt, provider approval or OAuth consent was submitted.

Company-tab settings/sidebar reorganization, compact Chrome header, hibernation and Claude-doctor changes remain uncommitted and excluded. Two-minute process-preserving hibernation and worker-preserving automatic rollout are not enabled. Automatic rollout remains disabled; this PR remains draft pending the remaining acceptance gates.

Earlier source-level receipts: [turn interruption](validation-2026-09-18-turn-interruption.md), [message boundaries](validation-2026-09-18-message-boundaries.md), [inline activity](validation-2026-09-18-inline-activity.md). Their local-only status describes the checkpoint before this publication.
