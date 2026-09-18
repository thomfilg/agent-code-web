# Pasted-text goal: remaining work

Historical gap list. The full active objective and original request order are
tracked in [feature-queue.md](feature-queue.md); that queue takes precedence.

Source: the user-provided pasted task list in this conversation.
This is a verification checklist, not a claim that source changes are deployed.

| Requirement | Evidence needed for completion | Current state |
| --- | --- | --- |
| Auto approvals | Actual Codex Auto turn handles the reported local IPC approval without a manual prompt; Edits/Plan retain their intended policies | Source exists; live activation and exact-case verification pending |
| All slash commands | Inventory of native commands and installed skills for each provider; executable, tested handlers including `/goal` and `/plan`; no unsupported-command placeholders | In progress; current implementations, real-CLI checks and remaining gaps are tracked in `command-support.md` |
| Credential ownership and availability | GitHub follows provider permissions without a second company allowlist (2026-09-18 clarification); agents, environments and MCPs retain company scopes. Separate user-owned connections, no credential fallback, selected-repository worker grants and revocation tests | GitHub policy refinement in progress; see the active queue and provider-permissions ADR. Earlier GitHub company-save acceptance is superseded, not a remaining onboarding step |
| Browser quality and presence | Current deployed worker produces sharp frames at every preset after resizing; visible tabs/browser interaction prevent idle sleep; background tabs expire | Source tests passed previously; deployed verification pending |
| Playwright MCP | Official Playwright MCP used by agents against the correct guest/authorized personal browser; revocation, isolation and no automatic browsing-context injection verified | Not implemented |
| Long-chat cleanup | Remove only the 241 tagged synthetic records from the actual chat; preserve all real messages, workspace and later activity; exclude samples from future provider context | Filters/removal implementation exists; live cleanup pending |
| Paladira OAuth | Real Paladira discovery, browser authorization, persisted encrypted credentials and authenticated tools access; revoke/reconnect verified without exposing secrets | Live read-only discovery and matching local consent fixture passed; real user authorization remains pending |
| Direct URLs | Native-browser HTTP and WebSocket/HMR forwarding to the selected chat's remote worker; distinct origin, access control and worker lifecycle tests | Local aliases only; remote forwarding pending |
| Compact while busy (added during implementation) | Compact is always available for a selected chat; clicking queues `/compact` in order while busy and works for the selected provider, without the misleading Claude/idle tooltip | Source implemented; FIFO/provider/draft-preservation/interruption tests pass. Both installed CLIs successfully compacted through the real adapters against local deterministic API stubs, including Claude's native compact boundary. Live backend activation pending |

Operational constraints: preserve the current active session and unsent drafts; do not approve its command, restart it or discard its Chrome profile without explicit consent. No model-backed production turns are needed for fixture tests. Existing synthetic samples must not be recreated.

## New reports — append to the implementation queue

User clarification: append incoming reports after the existing items and
implement everything in order. Queueing is not a pause or a permission gate.

- **Internal title metadata displayed as HTML** (`tabwhoah/image copy 6.png`):
  `<relay-title>…</relay-title>` appears in an assistant response as code blocks
  and spurious HTML-preview buttons. Inspection identified Relay title metadata
  appearing after ordinary response text; the existing title filter only handles
  the beginning. Investigation only so far; no title/parser/rendering fix has
  been implemented. It is item 34 in the full feature queue.
- **PR failure/wakeup events**: item 35; notify the agent on failed checks and
  wake a stopped container with a GitHub event when checks pass. Not started.
- **GitHub event subscription**: item 36; promptly update PR/check/auto-merge
  status, retaining polling as a reconciliation fallback. The user accepted the
  current one-minute polling latency but explicitly still requested subscriptions.
