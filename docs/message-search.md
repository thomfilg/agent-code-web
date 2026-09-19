# Message search: provenance, privacy and coverage

MVP item 40 searches saved user messages and explicitly identified final AI answers across the current owner's conversations. Search and opening a result do not start, resume or prompt a worker. The existing chat/new-chat draft remains untouched; results open the corresponding message even outside the currently rendered history window.

## Decision: a final-answer projection, never a transcript guess

The existing display transcript can contain consecutive progress updates without an intervening tool. Its final persisted assistant row is therefore not itself proof that all its text is final. New completed results persist a separate, sanitized `meta.finalAnswer` projection in the existing encrypted message record. There is no reasoning index, provider/history query, background backfill or new database collection.

- Codex: only authoritative `item/completed` agent messages with explicit `phase: "final_answer"`, matching the active thread and turn, followed by matching successful `turn/completed`. Missing phase, commentary, tools, reasoning, failures and interrupted turns are excluded. Imported native conversations apply the same phase and completed-turn rule.
- Claude: only successful root SDK `ResultMessage.result` for the exact native session, explicit `is_error: false`, positive `num_turns`, `stop_reason: "end_turn"`, and absent or human origin. If `terminal_reason` is present it must be `completed`; abort/hook/background/unknown terminal reasons are excluded. Background/task-notification, unknown origins, null/missing stop reasons, interrupted and control-only results are excluded. Accumulated streaming assistant text is not used as the final projection.
- Legacy assistant records without provenance remain visible in their conversations but are not searched. The dialog discloses this gap; role, position, absence of commentary flags and final-looking prose are never used to guess.
- User messages use their saved user-written text, excluding rendering samples and generated sources, including GitHub event metadata. File bytes, tool output, hidden metadata, private reasoning and ephemeral `/btw` side conversations are not indexed.

OpenAI Docs was used to verify the native agent-message phase contract: [official app-server items](https://learn.chatgpt.com/docs/app-server#items). Claude's independent primary contract is [Agent SDK TypeScript ResultMessage](https://code.claude.com/docs/en/agent-sdk/typescript#sdkresultmessage) and [streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output). The local native acceptance option below validates the installed executable rather than assuming the current web schema alone proves installed behavior.

## Isolation and bounds

The POST search endpoint reads only conversations visible to the authenticated owner and revalidates the session before returning. Queries are not URL parameters. It uses literal case-insensitive matching, escaped DOM text and bounded snippets, not regular expressions or HTML. Each page examines at most 5,000 messages and approximately four million searchable characters, returning at most 40 results. Continuations count examined records, so old history remains reachable even through pages with zero matches. No fixed total-history cutoff applies. Concurrent conversation changes can shift page positions; restarting search refreshes ordering.

Final projections are credential-redacted and stripped of Relay response metadata before persistence. Projections above 100,000 characters are excluded rather than partially marked final. Unknown native versions fail closed for search coverage only; existing conversational display is unchanged. The UI fences stale query/account/navigation responses and supports keyboard selection, role filtering and mobile layouts.

## Validation status

Focused Node: 8/8 passed (4.1 s), covering exact provenance, sparse-history continuations, owner/session changes during final response authorization, imports and actual Codex adapter mapping with a fake native protocol. The first invocation stopped before tests because this fresh worktree lacked generated shared-auth output; running the existing build prerequisite resolved it.

Focused browser: 6/6 passed (25.4 s), no retries, covering older-message jumps, empty segmented final projections, drafts, literal output, pagination, stale replies, role changes and desktop/mobile dialogs. Initial run was 4/6: search-input Escape cleared text rather than closing, and mobile focus restoration targeted an off-screen sidebar button. The scoped dialog handler and visible-menu focus fallback fixed both. Desktop and 390-pixel screenshots were manually inspected; controls and literal snippets are contained and readable.

`node scripts/smoke-real-claude-run.mjs --search-provenance` uses the installed Claude executable, existing production adapter/runtime, a disposable profile and authored loopback-only provider inside a network namespace. It asserts the actual native result qualifies and the exact final projection reaches persisted search. It does not claim live-provider consent, real model quality or cloud acceptance. No real profile or saved authentication state is used.

That native run passed with 12 loopback requests, including its original run/verify/Stop/resume assertions. Actual native result frames were observed, not manufactured by the test.

Final compatibility: **163/163 passed**, zero skipped/cancelled, 34.1 s, across message search, Claude sessions, Codex message boundaries, Codex import files/runtime, runtime manager, message window and follow behavior. This includes the final defensive Codex interrupt-request guard and all eight search tests. No whole-application suite or production deployment is claimed by this component receipt.

### Integration follow-up: coherent live snapshots and keyboard focus

The larger integrated browser run exposed two failing search cases: the test injected synthetic messages into HTTP responses while leaving SSE attached to the canonical empty fixture chat. Trace records confirm real event streams opened after HTTP navigation, but do not retain their event bodies; an exact observed SSE revision is therefore not claimed. The fixture now supplies the same chat snapshot through both transports and waits for a snapshot on the newly opened EventSource, not a reconnect count from its predecessor.

A source review also identified that replacing the transcript DOM discarded the focused message article. The narrow renderer fix restores only that article's same-chat/message focus when the browser has fallen back to the body; nested controls and the composer keep their independent focus behavior. No pre-fix failing focus run is claimed. The regression deliberately delivers another live snapshot after the jumped-to message becomes visible and retains viewport, focus, draft and no-wake/no-send assertions; another case moves to the composer first and proves the snapshot does not steal focus.

The updated seven-case search browser suite passed **7/7**, 14.6 s. Both original failing jump cases then passed three explicit repetitions each: **6/6**, 15.3 s. Both runs used one worker and zero retries. This follow-up changes only transcript focus behavior and test fixtures; the earlier backend/native provenance receipts remain separately scoped.
