# Feature queue — original request order

Active objective: implement **all** features requested in this conversation,
one at a time, first to last. New reports go at the end and are automatically
worked through; they do not require another permission request or interrupt the
current item. Repeated reports below remain evidence that an earlier fix needs
verification, not permission to skip it.

This queue supersedes the narrower gap list in `remaining-goal.md`. Existing
source changes are retained, but are not treated as deployed merely because
tests pass. Deployment and external-account verification remain explicit gates.

Delivery instruction (2026-09-16): when the current feature work is verified,
create or update its PR and push the reviewed work so it is saved remotely.
Preserve unrelated changes; do not treat this as permission to merge, deploy,
restart live services or alter live user data/accounts. This delivery step does
not reorder the feature queue.

| # | Request / acceptance condition | State |
| --- | --- | --- |
| 01 | Render Markdown and HTML; isolate snippet CSS and malformed/unclosed tags from the chat UI | Verified: four browser checks; live isolated-preview CSP active |
| 02 | Sidebar MCP manager; environment selection configures the chosen agent with those servers | Verified: real Codex/Claude MCP discovery plus environment and browser checks; backend activation pending |
| 03 | Preconfigured development MCPs, including Linear and Atlassian | Verified: all seven provider endpoints and preset UI checks |
| 04 | Custom MCPs, including browser OAuth installation of `https://paladira.com/api/mcp` | Implementation verified against live discovery and local consent flow; real user consent remains an external gate |
| 05 | Store conversation/context usage outside disposable containers; continue viewing after stop | Verified: stop/restart, real PostgreSQL reload and stopped-chat browser checks |
| 06 | Composer Up/Down recall at text boundaries, previous/next messages and draft restoration | Verified: boundary/draft/chat-isolation unit check and browser interaction |
| 07 | Hover/touch message rail shows sent-message list; selection jumps to the original message | Verified: hover/mobile open, focused jump, visible target and Escape dismissal |
| 08 | Desktop HTML and other document previews occupy a third column, like workspace changes | Verified: column geometry, independent scrolling, HTML/Markdown/SVG/text and mobile overlay |
| 09 | Answer whether pages use WebSockets, distinguishing chat updates from browser streaming | Answered: Chrome uses WebSocket; chat/sidebar use SSE; commands/settings use HTTP |
| 10 | Independent per-organization MCP accounts, e.g. two Linear workspaces | Verified: same-name records, primary-company filtering and credential/revocation isolation |
| 11 | Delete chats from Organize; confirm target and preserve other chats | Verified: confirmation/cancel, target-only deletion, errors, last-chat cleanup and other-tab update |
| 12 | Compact single-line sidebar chats, without the Idle/age sub-row | Verified: single-line geometry below 40px, inline actions, accessible status icon |
| 13 | Reasonable default styling for unstyled HTML | Verified: typography, table spacing/headers/alignment, document CSS overrides |
| 14 | Improve composer / command UI | Verified: responsive controls, agent switching and command-picker keyboard/loading/error behavior |
| 15 | Make the specified chat itself a real long-chat rendering example, not a personal-folder copy or invented messages | Awaiting real source chat/transcript; 254 real and 241 synthetic records audited in target; cleanup needs backend activation |
| 16 | Private, persisted Chrome connections per user; authenticate separately, anonymous browser by default, top-right opt-in for agent access | Verified with a real Chrome extension, private profiles, consent/revocation/restarts and cross-user tests |
| 17 | Queued follow-up questions must be clickable and answerable | Fixed and verified: clickable options, text/skip, retained drafts and stale-reply protection |
| 18 | `/plan` works from the web composer | Verified: task/read-only mode, busy queueing and command preservation on errors; backend activation pending |
| 19 | Send now on individual queued messages, retaining the rest | Verified: selected item, interruption/FIFO, stop race, failed retry, attachments and draft retention |
| 20 | `/goal` and every available native/installed slash command work, without unsupported-terminal placeholders | In progress: core native commands and web aliases verified; remaining gaps in `command-support.md`; backend activation pending |
| 21 | GitHub, environments and MCPs have explicit multi-company availability; no credential fallback/crossover, including secondary repos | Relay scope tests pass; audit inherited host-CLI credentials/config too; live migration/scope choice pending |
| 22 | Resize sidebar, chat and third-column panels | Existing source; dedicated interaction verification pending |
| 23 | Shared Chrome viewport presets: xxs, xs, sm, md, lg, xlg | Existing source; pending ordered verification |
| 24 | Resizing changes the actual viewport correctly, without stretching or needing a new tab | Source fixes exist; live worker verification pending |
| 25 | Paste cropped/copied images and files into the focused composer | Existing source; pending ordered verification |
| 26 | Long chats mount a bounded message subset, retaining history navigation and reducing DOM memory | Source/tests exist; full verification pending, including intermittent Jump to latest detachment during automatic paging |
| 27 | Auto mode handles the reported local IPC/tool approval without manual prompts | Source policy fix exists; exact native/live case unverified |
| 28 | Remove invented rendering messages; do not inject browser activity into agent context; use official Playwright MCP when requested | 241 tagged records still stored; official dependency installed, integration not implemented |
| 29 | Sharp, non-opaque browser output at every viewport, including sm/md/lg/xlg, after resizing | Source high-DPI fixes exist; live worker verification pending |
| 30 | Visible chat tabs and browser interaction pause idle sleep/countdown | Source/tests exist; live verification pending |
| 31 | Attachment images are clickable to inspect before and after sending | Existing source; pending ordered verification |
| 32 | Direct native-browser app URLs per chat, preserving port/path; remote HTTP and WebSocket forwarding too | Local aliases implemented; remote forwarding pending |
| 33 | Compact always available; send native `/compact`, queue while busy, retain draft, no misleading Claude/idle tooltip | Source, FIFO, browser and real-CLI/local-stub checks passed; deployed backend pending |
| 34 | Hide internal `<relay-title>` metadata from streamed/saved responses; no bogus HTML previews | Queued; cause inspected, fix not started |
| 35 | Notify the agent when PR checks fail; if the container is stopped when checks pass, wake it and deliver a GitHub event message | New report appended; not started |
| 36 | Subscribe to GitHub PR/check/auto-merge events for prompt UI status updates, with polling as a reconciliation fallback | New report appended after clarification; not started |
| 37 | Composer attachments use one row of image thumbnails and file cards above the text, matching the supplied screenshots. Every card is clickable: large image preview; scrollable text-file preview with filename, size and line count, for both draft and sent attachments | New report appended and clarified with image + file examples; not started |
| 38 | Drag and drop files and images onto the chat to attach them to the current draft without sending automatically; preserve existing text/attachments and apply the same validation and previews | New report appended after item 37; not started |
| 39 | Add a saved-prompts composer dropdown: truncated prompt rows with per-row (…) edit/delete menus, + Prompt and edit popups, drag-to-reorder, and availability for selected projects or all projects. Clicking a prompt inserts it into the composer without sending | New feature appended after item 38; panel sketch and interactions captured; implementation not started |
| 40 | Search across messages the user wrote and the AI's final answers, with conversation/result navigation. Do not store or index reasoning/chain-of-thought for this feature; exclude tool activity and intermediate responses from results | New feature appended after saved prompts; search-screen reference received; not started |
| 41 | Deleting a worker/container must preserve the chat and its messages outside disposable storage; only explicit chat deletion removes the conversation. Reproduce actual container deletion independently of stop/restart, using disposable fixtures | New data-loss report appended; item 05 stop/restart verification does not establish container-deletion safety; not started |

## Verification ledger

- 20: fixed Claude `/config`/`/settings` effects being overwritten by Relay's
  stale next-turn model and permission flags. Private-profile readback now
  reconciles actually applied values, including partial failures and same-value
  requests; retains newer web choices; and survives Stop/resume in the original
  chat. Five native permission modes, explicit Auto effort, native effort status
  and the separate Claude account-default model are covered. Shared host writes
  stay gated on item 21; files are rejected before submission/queueing. Eleven
  new unit/controller and four browser checks cover failure, scope, FIFO,
  concurrency, file-read safety and desktop/320px controls. Actual installed
  Claude 2.1.222 verifies model and thinking changes with three loopback replies;
  original command smoke still passes with four. Normal suite **391/391**, related
  browser regressions **27/27**, syntax/whitespace pass. The existing slider test
  caught Auto being misordered as the lowest effort; fixed the picker without
  changing its Low assertion. Native Plan promotion of Haiku to Sonnet is
  documented separately from execution-model verification. No real credentials,
  live data, app/Chrome restarts or deployment. Save to PR #2 without merging.
  Item 20 stays active: next verify remaining stateful Claude `/fast`,
  `/autocompact`, `/goal` and other installed-command effects. Queue count/order
  and previous activation/account/browser gates are unchanged.
- 20: installed Claude 2.1.222 now has real command-first, custom-command/skill
  expansion, multiline/Unicode, native local alias and same-session resume
  acceptance. Four loopback fixture model replies; no external inference or
  personal/native host-profile changes. Reproduced and fixed stale Relay menus
  after successful `/reload-skills`: scoped invalidation plus a persisted
  catalog revision refresh controller/browser caches and an open slash query,
  without consuming drafts/files or accepting old replies. Failed/interrupted
  reloads do not announce success. Four controller/unit and three browser cases
  pass. Final normal unit suite **380/380**, related browser regressions **28/28**,
  native smoke and repository JavaScript syntax/whitespace checks pass. The
  initial unit fixture needed its missing broker; product regressions and
  assertions remain recorded in `command-support.md`. Existing broad browser
  history/network gates remain open. Next safe item-20 work: stateful Claude
  command effects and restart persistence, then other installed-command effects;
  account/host-profile and activation gates remain explicit. Update PR #2 without
  merge/deployment. The original queue order/count is unchanged.
- 20: `/init` now has document, controller and browser acceptance evidence.
  Installed Codex 0.154.0 reads a disposable repository and uses native Code Mode
  tools to create actual AGENTS.md bytes, preserves them after same-session
  resume, and cannot write in Plan mode. Unrelated files remain unchanged.
  Nine deterministic loopback responses; no external inference, personal
  credentials or live chat/profile/approval changes. This proves integration,
  not generated-prose quality, which still needs review. Six controller/unit
  cases cover routing, FIFO, attachments, Stop/restart, failures and ownership;
  three browser cases cover discovery, multiline idle/busy sends, newer-draft/file
  preservation and failed-send retry. Normal unit suite **376/376**; focused
  browser suite **3/3**. OpenAI Docs supplied the scaffold/review contract.
  Existing production dispatch required no change. Native fixture corrections
  and remaining gates are documented in `command-support.md`; earlier broad
  browser failures and activation remain open. Keep item 20 active; next safe
  work is installed Claude-command acceptance. Save checkpoints to PR #2 without
  merge/deployment.
- 20: `/fast` and `/personality` now have browser/controller and installed-native
  parameter acceptance. Settings persist per chat, honor FIFO, use real model
  capabilities, never become prompts, and clear unsupported native overrides.
  Fixed late writes after Stop or a newer model/Fast-off choice; the personality
  picker prevents duplicate pending selections, retains attachments and ignores
  stale dialog/chat responses. Delayed send failures no longer overwrite newer
  or other-chat drafts. OpenAI Docs supplied the native command contract.
  Eight new controller cases and eight browser scenarios pass; the final normal
  `npm test` passes **370/370**, and related browser regressions pass **22/22**.
  Actual Codex 0.154.0 acknowledges all three personalities and catalog Fast
  tiers, including clearing after same-session resume. Four disposable loopback
  responses, no external inference or personal credentials. Syntax/whitespace
  checks pass; the 320px picker was visually inspected. Initial reproduced
  races and smoke-fixture corrections are retained in `command-support.md`;
  earlier full-browser history/network failures remain open. No deployment or
  live chat/account changes. Save to PR #2 without merge. Keep item 20 active;
  next is `/init` document acceptance, then installed Claude-command acceptance.
- 20: `/app` now opens a scoped same-session desktop handoff panel. An awake
  worker supplies native metadata through read-only `thread/read`; a bound
  controller locator survives stop/restart without waking it. Local host-profile
  links require explicit same-computer/profile confirmation. No transcript,
  credential, account or SSH-key transfer; no prompt, native setting change,
  automatic stop or queue mutation. Refresh/account/navigation races clear old
  paths and links. Private gateway profiles and remote workers have explicit
  limitations, not fabricated local links or pretend handoff success.
  OpenAI Docs supplied the actual local deep-link and remote-connection contract.
  Nine unit/controller cases and seven handoff browser cases pass; the final
  related browser regression run passes 20/20. The actual installed Codex
  0.154.0 smoke passes on a disposable private profile: same native identity
  before/after resume, unchanged history, one loopback seed response and no
  external model calls. The normal, default-concurrency `npm test` passes
  **362/362**, including the real Chrome extension case. All JavaScript syntax
  and whitespace checks pass; the 320px panel was visually inspected.
  Initial checks caught a cache-header override (fixed) and test selectors that
  hit Stop instead of Queue and assumed a hash router (corrected to the real
  controls). No assertions/timeouts/launch flags were relaxed. This is a focused
  browser checkpoint, not a rerun or closure of the earlier full-suite
  history/network failures. Nothing was deployed or changed in live chats.
  OS desktop launch remains unverified; private-profile handoff and one-click
  remote selection remain unimplemented. Keep item 20 open. Next safe work is
  the remaining `/fast`/`/personality` browser/native parameter acceptance,
  followed by `/init` and installed Claude-command acceptance. Preserve these
  open gates while saving this increment to PR #2 without merge/deployment.
- 20: `/pets` and `/pet` now open a saved web companion picker; direct names/IDs
  and Off work while busy without sending/queueing a prompt. Eight actual
  OpenAI v4 built-ins are downloaded lazily, hash-checked and cached. Private
  accounts can explicitly upload bounded PNG/WebP sheets plus optional frame
  metadata and delete only their own custom pets. Current-chat states, still
  frames for reduced motion, hidden-tab pausing, released bitmaps, drafts/files,
  account/revision guards and visibly disclosed shared built-in preferences are
  implemented. OpenAI Docs informed CLI aliases/status and standard web sheet
  behavior. No native profiles or live services/chats/accounts/Chrome changed.
  Six pet unit/controller and eleven focused browser cases pass; all eight
  real built-ins pass checksum/decode/transparency/frame/state checks in a fresh
  browser without model calls. Mobile review caught cramped columns, corrected
  to full-width choices. A final account-change review also clears private
  picker text/files/labels, not just its image; its added browser case passes.
  The initial full unit/controller run passed 352/352 at concurrency two. With
  the added quota case, the next run passed 352/353 with one cancelled 60-second
  Chrome-extension test; that unchanged case passed alone in 46.7 seconds.
  The full browser run passed 140/147, including all eleven pet cases. Item 26's
  Jump to latest detachment remains; six other failures show startup/reload
  `ERR_NETWORK_CHANGED` in traces (MCP, organization, syntax theme, two title
  cases and Vim). The final combined follow-up passed 17/18, including the new
  privacy case and all six unchanged network-affected cases; a pet-state case
  failed before startup with the same network error, then passed unchanged in
  isolation. All twelve pet scenarios have passing evidence across those runs,
  but the broader timeout/network/history gates remain open. JavaScript syntax
  and whitespace checks pass; no assertions, timeouts or launch flags relaxed.
  Next UI command: `/app`; item 20 and activation remain open. Save this
  checkpoint to PR #2 without merge/deployment.
- 20: `/theme` now previews and saves four syntax palettes for conversation code
  and diff colors. OpenAI Docs guided preview/confirmation/persistence; this is
  a web equivalent, not a native configuration write or agent prompt. Per-account
  settings (or explicitly shared installation scope) have auth/origin, revision,
  account-change and late-response guards. Draft/files and busy work remain.
  A self-hosted, pinned tokenizer runs in a separate browser worker, never the
  page's opt-in Vim runtime. Source is literal and never executed; bounded jobs,
  source/line/token limits, deferred batches and stale-element checks protect
  rendering. Unknown/large/complex blocks remain intact as plain text. Retrying
  replaces failed worker/module state. Four new unit/controller cases and the
  full 347/347 suite pass at concurrency two; all JavaScript syntax checks pass.
  Thirteen new browser scenarios cover real colors/copy/preview isolation,
  save/cancel/defaults, private HTTP persistence, mobile, busy/draft/file safety,
  errors/late responses, accounts, worker retry and 70-block batching. A focus
  account-change test failed before the stale-panel notice/disable fix. The next
  combined run passed 21/22, including all nine Vim cases; the failure occurred
  during startup before that scenario, with `ERR_NETWORK_CHANGED` on preferences
  and MCP requests in the trace. It passed unchanged in isolation; the startup
  network condition is not declared fixed. Desktop/320px layouts were inspected.
  The full browser suite finished 134/136, including all thirteen theme cases
  and both shared-Chrome cases. Item 26's Jump to latest detachment reproduced;
  a sign-out case failed before its scenario when startup script requests
  reported `ERR_NETWORK_CHANGED`. No assertions/timeouts were relaxed. A final
  light-theme contrast correction applies the palette to diff line numbers,
  with an actual computed-color assertion. All thirteen theme, nine Vim and four
  unchanged sign-out cases then passed together (26/26). That follow-up does not
  erase the full-run failure or establish the network condition's root cause.
  Code-palette foreground contrast was checked (above 4.5:1); desktop/320px
  layouts were inspected. Prior default-concurrency failures remain recorded.
  No live service/chat/account/Chrome or native config changes. Next: `/pets`
  and `/pet`; item 20 and activation remain open. Save this checkpoint to
  existing PR #2 without merge/deployment.
- 20: `/title` now configures Relay's browser-tab title through an eight-field
  picker with preview, selection, drag/arrow order, explicit save, defaults and
  a neutral app-only title. OpenAI Docs guided behavior and spinner/project
  defaults; chat names and native terminal configuration are not changed.
  Account-scoped preferences (or explicitly shared installation preferences)
  reuse the tested footer picker/storage mechanics but separate record kinds.
  Stale/revoked writes and late acknowledgements cannot overwrite newer settings,
  panels or drafts. Account changes immediately neutralize the title. Saved
  runtime/branch/model/goal metadata drives the title; spinner animation pauses
  for approvals/questions, hidden tabs and reduced motion. Values are bounded
  plain text, not HTML/templates or copied prompts. Native Codex 0.154.0 lacks
  `update_plan`, even with goals disabled: initial step-count smoke attempts
  failed and exposed the capability difference. All six actual goal states and
  clearing now pass real-CLI smoke verification without inference/credentials.
  Optional native plan notifications retain only current-thread/turn aggregate
  counts, with schema/protocol-fixture, stop/reload and reset coverage; no claim
  that this installed CLI emits the legacy plan tool. Seven new unit/controller
  checks and eleven title browser checks pass; the ten existing footer and two
  attachment checks remain green (23/23 focused browser tests). Two deterministic
  title regressions failed before correction: slow preferences delayed startup,
  and another account discovered on focus could reuse a cached private chat's
  name. Title loading is now non-blocking and its title/preview verify ownership.
  Real HTTP/private-account browser persistence also passes without waking an
  agent. Full unit/controller suite: 343/343 with concurrency two. The first
  full browser run was deliberately interrupted to make corrections: 31 passed,
  two failed, one interrupted and 86 not run. The attachment test targeted a
  hidden input before startup selected a chat; it now asserts the actual chat
  and visible composer before file selection, without removing assertions or
  increasing timeouts. Item 26's Jump to latest detachment reproduced again and
  remains open. Prior default-concurrency failures remain open. The final full
  browser run completed 122/123, including all eleven title cases. The shared
  Chrome case reached its overall 30-second deadline late in its desktop-
  screenshot/expand flow, after typing and viewport checks passed. This is not
  a green full suite; no timeout/assertion was relaxed. Both shared-browser cases
  then passed isolated (the original case in 10.0 seconds), with no code changes;
  the full-suite timeout is retained, not declared fixed. Desktop and 320px title
  layouts were visually inspected. No live
  service/chat/account/Chrome changes. Next: `/theme`; item 20
  and backend activation remain open.
- 20: `/statusline` now configures the actual web footer: fifteen fields,
  live preview, checkbox selection, drag/arrow reordering, explicit save, hide
  and defaults. OpenAI Docs informed selection/order/persistence and disabling;
  the UI explicitly distinguishes this from worker terminal configuration.
  Preferences are account-scoped (or explicitly installation-shared without a
  private account), revision-guarded and never contain arbitrary scripts/data.
  Late loads/saves preserve newer panels, drafts, chat selection and account
  preferences. Missing metrics are not zero; context and cumulative counters
  remain distinct, cache/reasoning are not double-counted, expired limit windows
  are marked and stopped workers show saved snapshots. Native initialization
  captures bounded model/directory/version fields, not raw user-agent/host data.
  The actual Codex 0.154.0 handshake passes in an isolated profile without
  inference; Claude's init path has local protocol-fixture coverage. Separate
  read-only Git snapshots include main/default branches and detached HEADs on
  the worker; PR discovery behavior is unchanged. No settings action wakes a
  worker, sends a prompt or changes native config/credentials. Seven new
  unit/controller checks and ten responsive browser checks pass. The full
  unit/controller suite passes 336/336 with concurrency limited to two, without
  skipping tests or relaxing assertions. The prior default-concurrency failures
  remain documented, not declared fixed by this result. Desktop and 320px picker
  layouts were inspected; close/save/error state stay visible as the field list
  scrolls. The first full browser run passed 110/111, finding a mobile startup
  race: automatic initial chat selection closed a drawer already opened by the
  user. A deterministic regression test failed before the fix; initial selection
  now preserves that drawer, while explicit chat selection still closes it.
  All sixteen organization/status-line browser cases then passed, including the
  original failure, without altering its assertions/timeouts. The final full
  browser suite passes 112/112. No live service, chat, personal Chrome or account
  changed. Backend
  activation remains pending. Next: `/title`; item 20 remains in progress.
- 20: `/vim`, explicit on/off and Chat actions now control real web-composer Vim
  editing. The OpenAI Docs skill informed the per-session behavior; the mode is
  per chat in this page, not a native configuration change. A pinned, self-hosted
  editor loads only on opt-in. Normal/Insert/Visual editing, motions, operators,
  text objects, registers, undo, search and substitutions work on the unsent
  draft. Insert-mode Relay shortcuts, command/file pickers and attachments keep
  their existing paths. Normal Enter cannot send; mode, help and off controls
  are visible. Chat/account changes reset registers, macros, search and undo;
  late asset loads and load failures cannot erase newer drafts or switch chats.
  Two new unit/controller checks and nine actual-editor browser checks pass,
  including mobile, account changes, workspace references, clipboard files,
  busy queueing, IME and read-only/size limits. The full unit/controller suite
  passes 329/329 with `node --test --test-concurrency=2 test/*.test.mjs`.
  Default-concurrency `npm run check` is not green: after correcting the obsolete
  assertion that Vim must be unavailable, its latest run had 319 passes, nine
  failures and one cancellation, involving fixture timeouts and shutdown races.
  No timeout was relaxed and no test was skipped; the default-run failures are
  retained, not declared fixed by the bounded-concurrency result. The final full
  browser suite passes 102/102, including all nine Vim cases; repository-wide
  JavaScript syntax and `git diff --check` pass. Desktop and 320px editor layouts
  were visually inspected. Item 26's known intermittent paging failure did not
  reproduce in this browser run but remains open. No worker,
  native config, live chat/account, personal Chrome or live service changed.
  Backend activation remains pending. Save this incremental checkpoint to PR #2
  without merge/deployment. Next: `/statusline`; item 20 remains in progress.
- 20: `/keymap` now opens a working web keyboard editor, also reachable through
  Chat actions. The OpenAI Docs skill informed context/action selection,
  alternatives, unbinding and persistence; Relay explicitly distinguishes its
  web shortcuts from native terminal configuration. Seven actual actions cover
  new chat, composer/question focus, send/queue, newline and boundary-aware
  history. Composer overrides global; pickers, IME and browser editing retain
  their controls. Reserved/conflicting bindings are rejected. Preferences persist
  per signed-in Relay account, or in the disclosed installation-shared scope
  without an account. Scope/revision guards reject stale writes and late replies
  cannot roll back newer settings, replace a panel or clear a newer draft/files.
  Five unit/controller checks and five desktop/mobile browser checks pass;
  `npm run check`: 327/327, full browser suite: 93/93. Desktop and 320px dialogs
  were visually inspected. Item 26 passed in this full run but its previously
  reproduced intermittent paging failure remains unresolved, not declared fixed.
  No worker was woken for keymap settings; no native config, live chat/account,
  personal Chrome or live service changed. Backend activation remains pending.
  Save this verified incremental checkpoint to existing PR #2, without merge or
  deployment. Next: `/vim`; item 20 and the overall queue remain in progress.
- 20: `/logout` now opens saved status without waking a worker, explicitly
  inspects a private native account, and requires a separate idle confirmation
  before Codex clears its credentials. The OpenAI Docs skill informed native
  account/storage semantics. Main, side, child and goal work is not stopped to
  force sign-out; confirmed operations pause the queue. Owner/company/repos/
  environment/workspace/session/worker, file identity and startup/current/admin
  policy bind encrypted five-minute reviews. Intent precedes dispatch, and lost
  replies, Stop or restart cannot replay uncertain operations. No raw credential
  bytes reach the browser; account/limit snapshots are invalidated and late
  inspections cannot restore old account data. Profile file inspection rejects
  links/special/oversized files but is a preflight, not an atomic filesystem
  sandbox. Native removal is verified; history, workspace, draft/files and sibling
  profiles remain. Shared host and OS keyring/auto storage stay locked pending
  isolation (21). Real CLI 0.154.0 testing found gateway mode hides in-memory
  native accounts; this now has an explicit unavailable state, never false success
  or a claim that those credentials are absent. Default-file and observable
  ephemeral native removal pass with dummy accounts and loopback-only network/PID
  namespaces; an authenticated-provider fixture makes ephemeral accounts visible.
  Seventeen new unit/controller checks and four responsive browser checks pass.
  Final `npm run check`: 322/322. Full browser run: 87/88; item 26's previously
  recorded Jump to latest detachment/pointer-interception timeout reproduced at
  `test/browser/conversation.spec.mjs:79` and remains unresolved, not bypassed.
  Desktop/mobile sign-out controls were visually inspected; final native smoke
  passes. No live account, OS keyring, chat, worker or Chrome changed. Backend
  activation remains pending. Next: terminal UI equivalents; item 20 remains open.
  The user authorized saving the verified checkpoint to the existing PR #2 on
  `feat/mcp-connections`; auto-merge is off. This is a work-in-progress backup,
  not a claim that the full queue is finished or ready to deploy/merge.
- 40–41: appended the user's latest search request (only user-written messages
  and final AI answers, no reasoning/tool/intermediate-response index) and the
  report that deleting a container deletes messages. These follow saved prompts
  (39); no out-of-order implementation or live-data deletion occurred.
- 20: `/feedback` now opens an explicit report/policy/review flow. Only final
  confirmation uploads to OpenAI; logs are off by default, and draft text/files
  never become implicit attachments or agent input. Diagnostic consent is
  separate, explains conversation/code/path/account metadata, and is blocked
  for shared host profiles pending item 21. Private configuration and managed
  storage roots must stay within the native profile. The OpenAI Docs skill
  informed the native contract. Real 0.154.0 testing found that the upload
  handler caches startup configuration, so current policy is checked before
  dispatch and log consent is also bound to verified startup configuration.
  Changes never silently restart a worker. Encrypted bounded review/submission
  records bind owner/company/repos/environment/workspace/native thread/worker;
  stale reviews, Stop, lost replies and restart cannot silently replay uploads.
  The native reference is a session ID, not an independent external receipt.
  Actual CLI tests use loopback inference and a local TLS report receiver inside
  network/PID namespaces: four classifications, text-only versus native history
  and diagnostic files, positive/error responses, disabled policy and no extra
  agent turns pass. No report or diagnostic data reached OpenAI. Fifteen new
  unit/controller checks and five responsive browser checks cover the controls;
  the full browser suite passes 84/84. Desktop and 320px dialogs were visually
  inspected. The first targeted browser run had one transient bootstrap failure
  before the feedback dialog opened; its isolated, whole-file and full-suite
  reruns passed. It is not counted as a reproduced/fixed product defect.
  Live activation remains pending; no personal account, production data or live
  worker/Chrome changed. Keep item 20 in progress. Next: `/logout`, then terminal
  UI equivalents. Saved prompts remain item 39 after attachments/drag-and-drop.
  Final checkpoint: `npm run check` passes 305/305, the full browser suite passes
  84/84, and the final real-CLI feedback smoke passes. `git diff --check` is
  clean. No commit, deployment or live support submission occurred.
- 20: `/approve` is now a native automatic-review retry flow, not a blanket
  approval shortcut. Actual main-thread denials are retained in encrypted,
  owner/project/session-bound records; the web panel displays literal reviewed
  metadata and requires confirmation. It queues that specific action, preserving
  FIFO, paused queues, newer denials and the unrelated draft/attachments. Native
  approval is recorded before an explicitly requested retry through the tracked
  turn path; permission settings and automatic review remain in force. Durable
  phases prevent silent replays after lost replies, Stop or restart. The OpenAI
  Docs skill informed the contract; the installed CLI exposed and verified the
  snake_case, stdin file-URI and filesystem-representation conversions. A private
  real-CLI fixture proves same-thread resume, harmless command execution after
  review, continued denial on a later request, actual filesystem-permission
  metadata and all seven action formats. No live account, data, worker or Chrome
  session changed. Live activation remains pending. Keep item 20 in progress;
  next remaining inventory entry is `/feedback`, then `/logout` and terminal UI
  equivalents. Item 39's saved prompts remain queued after attachment cards and
  drag-and-drop.
  Final checkpoint: `npm run check` passes 290/290, the full browser suite passes
  79/79, and the final real-CLI approval smoke passes with private fixtures only.
  Eleven new unit/controller tests cover binding, tampering, duplicate/lost
  responses, Stop, bounded same-millisecond events and queued-selection retention;
  stale retries cannot cross companies/providers and remain removable after a
  switch. Four browser checks cover literal metadata, explicit confirmation,
  mobile layout, drafts/attachments, uncertainty and late responses. Desktop and
  320px dialogs were visually inspected. `git diff --check` is clean. No commit,
  deployment, personal account authorization or production-data change occurred.
- 20: `/import` now has a source/group/conversation picker, explicit selection
  confirmation, asynchronous result cards and incomplete-outcome recovery.
  Opening a selected imported conversation creates one independent stopped chat
  with a copied workspace and privately retained native history. It does not send
  input or copy personal accounts/profile settings; nonempty drafts and attached
  files stay in the original chat. Six new controller tests and five browser
  checks cover adoption, isolation, cancellation, cleanup, navigation and late
  results. The real CLI proves native continuation and same-thread resume after
  deleting the source chat. Both the original import smoke and regular fork
  smoke pass. The OpenAI Docs skill informed the native workflow.
  Real testing exposed two details: Claude image blocks become native unsupported
  markers, which are retained with a warning; temporary Git directories can
  mutate during inspection, so only their read-only safety scan gets bounded
  retries. Twelve inspector tests retain source-change/link rejection. An import
  warning initially disappeared into its closing dialog; the fixed positive
  navigation browser test now passes. The first full browser run also exposed
  intermittent Jump to latest detachment during automatic paging (26); its
  isolated rerun passes, but that does not establish a fix. No live data, account,
  worker or personal Chrome session changed. Backend activation is still pending.
  Keep item 20 in progress; next remaining inventory entry is `/approve`.
  Item 39's saved-prompts dropdown remains queued after attachments/drag-and-drop.
  Final checkpoint: `npm run check` passes 279/279 and the final full browser run
  passes 75/75. The five import browser checks and the long-chat isolated rerun
  also pass; the earlier intermittent paging failure remains recorded for 26,
  not declared fixed by a green rerun. Native import, imported-chat continuation
  and regular fork smokes pass with private fixtures only. Desktop and 320px
  mobile import dialogs were visually inspected; `git diff --check` is clean.
- 20: `/import` backend integration checkpoint: worker-side source/target
  fingerprinting, encrypted-record callbacks, owner/company/profile binding,
  native result notifications, exact worker-stop tracking, scoped HTTP routes,
  input/queue guards and idle keepalive are connected. Eleven filesystem tests,
  nine adapter/controller tests and seventeen execution/recovery tests pass,
  alongside the nine selection-plan tests. Lost SSH transport does not count
  as an observed native stop; a matching EC2 stop must finish before it can
  authorize acknowledgement. Native reconciliation reloads saved settings but
  never trusts hooks, authenticates accounts or starts an agent turn. The
  installed-CLI smoke exercises production inspection/reconciliation and the
  actual adapter across restart. It also verifies that an empty native root may
  be replaced without losing its recorded import or repeating a stale request.
  The OpenAI Docs skill informed the native flow. The inspector is a bounded
  preflight, not a sandbox for imported code. Composer/result UI and opening
  imported Relay chats are still pending; do not mark `/import` or item 20 done.
  No live data or account was changed. Item 39 remains queued in order.
  Final checkpoint: `npm run check` passes 272/272, the production-adapter
  installed-CLI import smoke passes, and `git diff --check` is clean. No browser
  UI change or deployment is claimed. Continue with the import picker/result
  flow and imported-chat adoption before moving to the next command.
- 39: The saved-prompts composer dropdown was appended after drag-and-drop, as
  requested. The supplied panel sketch places + Prompt above saved prompt rows,
  with long text truncated to fit and a per-row (…) menu for edit/delete. Add
  and edit open popups; saved prompts can be reordered by dragging and dropping.
  Clicking a row inserts its prompt into the draft without sending. Each prompt
  has explicit availability for selected projects or all projects. These details
  refine the same queued item, without interrupting `/import` work in item 20.
- 20: `/import` execution/recovery layer now records intent before dispatch,
  correlates native progress/completion, recovers history without replay, and
  makes confirmations idempotent across restart. Reviews are single-use and
  expire; discarded old result cards cannot authorize old confirmations again.
  Partial failures and unreported selections are not labelled successful. A
  missing history entry or timeout is not treated as a stopped worker; uncertain
  outcomes require its exact observed stop before explicit acknowledgement.
  Sixteen lifecycle tests plus the nine selection tests pass. The installed CLI
  smoke verifies the new layer, actual imported history, persisted operation
  restoration and no duplicate native import after process restart. OpenAI Docs
  informed the asynchronous native workflow. Production filesystem inspection,
  encrypted adapter storage, lifecycle/input guards, HTTP/UI and imported-chat
  adoption are still pending; this is not yet a usable web `/import` command.
  No live chat, native account or personal Chrome session was changed. Continue
  `/import` before advancing in the queue.
  Final checkpoint: `npm run check` passes 251/251; the 25 import-specific tests
  and the installed-CLI smoke pass; `git diff --check` is clean. No browser UI
  change or live deployment is claimed by this backend checkpoint.
- 20: `/import` native-contract and selection checkpoint: nine review-plan tests
  pass, and the installed CLI verifies Claude/Cursor migration in private
  fixtures, source/existing-file preservation, selected native chat history,
  asynchronous results and persistence after restart. The OpenAI Docs skill
  informed the contract. Real testing exposed that skill/command/MCP detail
  subsets do not constrain native imports; these must be confirmed as whole
  groups, while session selections are individually honored. Other-project
  histories are excluded from the review. The metadata planner is not a
  filesystem/authorization boundary. Execution controls, persistence, the web
  dialog and imported-chat opening remain pending; `/import` is not yet available
  through the web UI. No live data or account was changed. Continue this same
  item next, before advancing to the remaining command inventory or item 21.
  Checkpoint regression: `npm run check` passes 235/235, the installed-CLI import
  smoke passes including restart persistence, and `git diff --check` is clean.
- 20: `/memories` now offers native local-memory enablement, use and generation
  controls plus an explicitly confirmed private-profile reset. The OpenAI Docs
  skill informed the distinction between memory use and chat contribution;
  installed-CLI evidence established saved defaults and current-thread updates.
  Generation opt-outs are applied before saving defaults, and concurrent native
  opt-outs win over in-flight enables. Shared host profiles remain read-only
  pending company isolation (21), managed overrides stay locked, and settings
  operations never send a synthetic user message or restart the worker/Chrome.
  Nine unit/controller checks and three browser checks pass. The real CLI passes
  actual memory-summary injection versus disabled use, contribution state,
  restart persistence and reset retaining configuration, unrelated memories and
  conversation history. The first smoke's request-count assertion exposed native
  startup consolidation despite new chat contribution being off; the fixture now
  explicitly verifies those background requests and the UI explains their quota
  implications. It does not claim that resetting files erases existing context
  or stops an active native background pass. All native model responses were
  loopback fixtures, not paid inference or real account work.
  Next inventory entry: `/import`; overall item 20 remains in progress.
- Memories checkpoint regression: final `npm run check` passes 226/226 and the
  full browser suite passes 70/70. The native-settings targeted group passes
  45/45; the installed-CLI memory smoke passes after final concurrency checks.
  Desktop and 320px mobile confirmation views were visually inspected; the reset
  action includes irreversible-deletion and regeneration warnings. The three
  memory browser checks pass again after fixing destructive-button styling.
  `git diff --check` is clean. No live app,
  user conversation, native account or personal Chrome session was changed.
  Live activation remains pending the saved-data restart choice.
- 20: `/experimental` now lists the loaded thread's native beta features and
  confirms private-profile enable/disable actions. Native requirements and
  managed, project or session overrides stay locked; shared host profiles remain
  read-only pending company isolation (21). The OpenAI Docs skill informed the
  beta catalog, policy checks and restart distinction: saving a flag never
  automatically stops the worker, Chrome or background terminals. Network proxy
  is not a network-access grant, and native sleep prevention is separate from
  Relay's idle timer. Ten unit/controller checks and three browser checks pass,
  including stale confirmations, uncertain-write recovery and draft/file safety.
  The installed CLI passes private-profile toggles for Network proxy, Worktrees
  and Prevent sleep while running, configuration refresh, restart persistence
  and trusted project overrides with zero model calls. The native smoke caught
  unstable object ordering in revision hashing; canonical hashing now preserves
  revisions across equivalent responses while rejecting actual changes.
  Next inventory entry: `/memories`; overall item 20 remains in progress.
- Experimental checkpoint regression: `npm run check` passes 217/217 and the
  full browser suite passes 67/67. Updated desktop and 320px mobile confirmation
  views were visually inspected; the picker uses one dialog scroll area. Final
  real-CLI experimental and command/MCP hook smoke checks pass, and
  `git diff --check` is clean. Tests use only isolated fixtures; no live app,
  saved user conversation, account or personal Chrome was changed. Startup and
  live deployment remain pending the user's saved-data restart choice.
- 20: `/hooks` now has event/search filtering, literal source details and explicit
  source-review confirmation before trusting the exact native definition hash.
  Private profiles support verified enable/disable; trust does not enable a
  disabled hook. Managed hooks stay locked, while shared host profiles hide
  executable definitions and remain read-only pending company isolation (21).
  The OpenAI Docs skill informed trust/policy behavior and unsupported MCP
  SessionEnd handling. Eleven new unit/controller checks and three browser
  checks pass. The installed CLI passes real command and anonymous MCP hook
  execution against loopback fixtures, including disabled/untrusted/modified
  rejection, command and argument hash changes, retrust and restart persistence.
  The first native smoke exposed cached definitions differing from `hooks/list`;
  idle private refresh now reloads configuration before reporting state. No
  real account, paid model, live chat or personal Chrome was changed.
  Next inventory entry: `/experimental`; keep overall item 20 in progress.
- Hooks checkpoint regression: final `npm run check` passes 207/207 and the full
  browser suite passes 64/64. Desktop and 320px mobile review/confirmation views
  were visually inspected; the source-review checkbox follows the existing theme
  and remains keyboard accessible. The expanded real-CLI smoke passed both
  command and MCP execution with private loopback fixtures after the final
  controller checks. No live deployment is claimed.
- After the user's computer restart, port 8787 was confirmed offline. Source
  changes survived; restarting the saved-data app was offered separately, and
  tests resumed with isolated fixtures. Deployment is not implied by the reboot.
- 20: `/plugins` now provides marketplace tabs, search, details and confirmed
  install/enable/disable/remove actions in private chat profiles. Shared host
  profiles are inspection-only; company/account isolation remains item 21.
  The OpenAI Docs skill identified plugin mutation RPCs as not production-ready;
  the implementation uses supported CLI commands with native policy checks,
  configuration reload and skill refresh instead. Ten new unit/controller/process
  checks pass, including cancellation, stale revisions, output/time limits,
  minimal environment, policy overrides and interrupted-change reconciliation.
  Three browser checks pass for confirmation, drafts, late replies and mobile
  layout. Real installed Codex passes the complete private local marketplace
  lifecycle with a loaded native thread and zero inference. Remote authenticated
  marketplaces and deployment are not claimed. The next native inventory entry
  is `/hooks`; keep overall item 20 in progress.
- Plugins checkpoint regression: `npm run check` passes 196/196 and the full
  browser suite passes 61/61. The first targeted mobile check exposed horizontal
  overflow in the existing chat header at 320px; controls now wrap with an
  automatically sized header, and both horizontal and vertical containment are
  checked. Final desktop/mobile previews were inspected. The installed-CLI
  smoke passed again after the final controller changes. No live server, native
  account, user chat or Chrome session was restarted or modified.
- 38: Drag-and-drop images and files onto the chat was appended after the
  clickable attachment-card redesign, as requested. Drops should stage draft
  attachments, never submit automatically, retain existing text/files and use
  the same limits, upload errors and previews. Not implemented ahead of the
  current command work.
- 20: `/apps` now opens a searchable native app picker for the current Codex
  thread. Selection stages a token and a private, chat-owned reference without
  sending a message, installing an app or modifying credentials. Dispatch checks
  native accessibility/enabled/callable policy again, including queued inputs;
  stale owner/company/root and forked references cannot silently grant access.
  Seven new unit/controller/protocol checks and three desktop/mobile browser
  checks pass. The installed CLI also passes scoped discovery and unknown-app
  rejection in a private unauthenticated profile with zero model calls. Real
  authenticated connector invocation is not claimed, and shared host-profile
  credential isolation remains item 21. The OpenAI command/app-server references
  informed the structured `app://` mention implementation. Live activation is
  pending; the next inventory entry at that checkpoint was `/plugins`.
- Apps checkpoint regression: `npm run check` passes 186/186 checks and the
  full browser suite passes 58/58. The first parallel run hit an existing
  two-second Chrome capture deadline, which passed in isolation. A later full
  rerun exposed fixture shutdown waiting on an unfinished browser HTTP request;
  the new regression reproduced it before the fixture cleanup fix. The final
  full suites pass without manual cleanup. Only test-owned Chrome processes
  were stopped during diagnosis; the live server and the user's Chrome were
  not restarted, and no live chat or account was modified.
- 37: The latest examples extend the queued attachment redesign to both images
  and files, before and after sending. Preserve one card row, thumbnail images,
  filename/type cards, and click-to-open large image or scrollable text previews
  (including filename, size and text line count). This stays after item 36 and
  has not been implemented ahead of the current command work.
- 20: `/ide`, `/mention` and `@path` now use explicit workspace context. A
  read-only third-column viewer opens actual worker files, captures selected
  ranges, and stages references in the existing private attachment flow. Send
  waits for capture; queued/sent snapshots survive source edits and worker or
  controller restart. Twelve reader/controller checks cover containment,
  bounded search, binary/large files, Unicode/line endings, ownership before
  and after capture, remote executor roots, fork rebinding, Claude input,
  Stop races and viewer leases. Real installed Codex passes against loopback
  model responses: the selected text arrives as user-level untrusted context,
  without unselected text or later file edits. Native `UserInput.mention`
  silently ignored file paths in the first smoke; the implemented path uses
  `additionalContext` instead. This is Relay's viewer, not an external IDE
  connection. Selected text is kept out of ordinary chat/SSE summaries and
  fetched only for attachment previews. Live backend activation is pending;
  next command category is native configuration and connected services.
- Workspace-context regression: 178/178 unit/integration checks and 55/55
  browser checks passed, including five new workspace-context scenarios. The
  shared presence dependency now tracks announced transitions rather than
  racing wall-clock expiry; a deterministic regression reproduced the missing
  close notification before the fix. The real-CLI/local-model workspace smoke
  passed again after final integration. The first browser run
  exposed older agent-picker fixtures racing their underlying stopped-chat
  sidebar snapshots; their native fixture revision now consistently identifies
  the newer state, without changing assertions or production picker behavior.
  No live backend, user messages, personal Chrome profile or account was changed.
- 20: `/agent` and `/subagents` now open a native descendant picker with separate
  conversation, draft, approvals and stop controls. Nine controller/protocol
  tests cover ancestry vs. unrelated roots/forks, scoped actions, offline
  persistence, retry IDs, native completion races, snapshot restoration and
  live-history races, and automatic nested-agent discovery. Three desktop/mobile browser checks cover routing,
  aliases, saved reads without waking, pagination and late-reply draft safety.
  The real installed CLI passed bounded history, nested ancestry, direct child
  replies/steering, interruption and parent survival with private synthetic
  sessions and loopback model responses. No actual delegated work, paid model
  calls or changes to the user's live chat/browser were involved. Live activation
  still awaits the safe restart decision. Next in the command inventory:
  `/ide` and explicit workspace file mentions.
- Regression at the agent-thread checkpoint: 165/165 unit/integration checks
  and 50/50 browser checks passed. Native navigation passed three consecutive
  real-CLI/local-fixture runs; the nine targeted checks and native smoke then
  passed again after child Stop was extended to pause only that child's active
  goal. The first full browser run exposed fixture chats crowding the sidebar's
  existing drag test; the new fixtures now delete only their own temporary chats,
  and both the combined agent/organization run and full suite pass. No live
  backend restart, real chat mutation, account or personal-browser access.
- 20: `/fork [title]` now reaches the controller and creates an independent chat,
  copying native history, workspace and chat-owned attachment records. It keeps
  company/environment/model settings, not queues, approvals or browser grants.
  Ten controller checks cover isolation, private persistence, first-input goal
  activation, Plan, manual Stop, agent switching, idempotence, cancellation,
  empty chats and startup races. Two browser checks cover retry identities,
  successful navigation, duplicate clicks and late responses preserving drafts.
  The real CLI/controller smoke verified active-source isolation, deletion of
  the source, deferred goal continuation and budget, attachments, restart, and
  zero model calls for fresh/opened-empty chats. Remaining native commands are
  still in `command-support.md`; live activation remains pending.
- Regression after controller/UI fork integration: 156/156 unit/integration
  checks and 47/47 browser checks passed. An additional real-CLI/controller smoke
  passed after cancellation cleanup was added. All tests used isolated fixtures;
  the user's backend, live chat and Chrome profile were not restarted or changed.
- 20 (previous persistent-fork checkpoint, before UI wiring): Native history
  transfer preserves the fork's exact byte boundary and nested ancestry without
  copying credentials. Seven workspace-copy checks cover Git staged/unstaged
  state, ignored/untracked files, independent hardlinks, rebased internal links,
  worker-executor transfer, Git redirects, traversal, limits, cancellation and
  concurrent edits. Missing/mismatched fork history now fails instead of silently
  opening an empty session. The real installed Codex smoke passed fresh-profile
  and nested resume, independent workspace edits, goal-budget restoration and
  continuation after fixture source profiles were removed. Controller persistence,
  attachment rebinding, first-input goal activation and UI wiring were completed
  in the subsequent checkpoint above. No live chat, browser, account or backend
  process was changed.
- Regression at the persistent-fork checkpoint: 145/145 unit/integration checks
  and 45/45 browser checks passed. The five bundle checks were rerun after the
  final budget/operation-validation change. Remote workspace transfer used an
  executor fixture; no EC2 instance was provisioned for verification.
- 20: Implemented native `/side` and `/btw` using an ephemeral Codex fork in
  the existing worker, with a resizable third-column UI, isolated streaming,
  questions/approvals, attached files, and side-only stop/end controls. Main
  drafts, transcripts, queues and goals remain untouched. Reading side state
  does not wake a worker; active side turns prevent idle sleep. No transcript
  directory is copied and no side messages are injected into the main chat.
  The real installed CLI passed concurrent main/side turns, inherited context,
  active-goal isolation, cancellation, and main continuation after side close.
  It rejects `deferGoalContinuation` on ephemeral forks; that option is correctly
  omitted. Four controller checks cover authentication, ownership, attachments,
  question routing and close-during-fork cleanup; three browser checks cover
  responsive resizing, draft retention, answers, reload and delayed-response
  isolation. Full command coverage remains in progress; activation is pending.
- Regression after side-chat implementation: 132/132 unit/integration checks
  and 45/45 browser checks passed. An earlier run had 44/45: Chrome reported
  `ERR_NETWORK_CHANGED` on startup settings GETs before the Plan test could
  open its composer. The complete rerun passed; no assertion was weakened or
  failure hidden. Native side-fork tests used the real CLI with loopback model
  fixtures only, without accessing a real account, live chat or personal Chrome.
- Previous regression checkpoint during #20: 127/127 unit/integration tests and
  42/42 browser tests passed, including native-terminal/config-inspection and
  aliases. Real installed Codex and Claude compaction plus Codex review
  completion/interruption also passed against loopback API fixtures. Codex
  terminal/config inspection and empty-task cleanup passed against the real CLI;
  Claude reload-skills, autocompact and config help returned native output with
  zero model calls. Live backend activation remains pending.
- 20/21 dependency audit: host-auth workers intentionally use the host's
  `CODEX_HOME` / `CLAUDE_CONFIG_DIR`. Native settings/account/plugin commands can
  therefore affect shared configuration unless explicitly scoped. Do not wire
  arbitrary global config/account mutations as a shortcut to command coverage;
  company isolation acceptance must include inherited native configuration, not
  only Relay's own connection records. No host settings were changed by checks.
- 20 (in progress): Real installed Codex goal set/get/pause/clear and automatic
  continuation passed against a loopback-only model stub. Added native review,
  `/init`, goal editing, queued model/effort/permission settings and working web
  aliases. Native review exposed distinct inner started-turn and outer completed-
  turn IDs; the adapter now tracks both. The corrected real-CLI review smoke
  returned reviewer output. Browser goal-edit/queue/control/draft checks passed.
  Full command coverage and the remaining native/terminal controls are not yet
  verified; do not mark this queue item complete.
- 36: The user accepted the existing roughly one-minute auto-merge polling but
  explicitly still requested event subscriptions. Keep that as a separate queued
  implementation, not a retraction of #35 or permission to interrupt the current item.
- 19: Five queue controller tests passed for selected-only Send now, FIFO,
  paused queues, invalid/duplicate IDs, manual Stop winning races, preparation
  cancellation and attachment-preserving failures. New browser check passed for
  the per-row action, pending/disabled state, retry, other rows and composer draft.
- 18: `/plan <task>` reaches the controller as a plan action and uses read-only
  mode. Bare `/plan` now queues when busy instead of failing a mode update, and
  failed controls retain the typed command. Three command tests and the new
  browser task/queue/error-preservation check passed.
- 17: Added selectable question options and free-text answers, Skip, and Alt+Up
  focus. Stable request rendering preserves input/focus during live updates.
  Frontend and controller now retain a newer question if an older response finishes
  later; answers are validated against requested IDs. Nine relevant controller
  checks and the new browser interaction/race/retry test passed. Native request
  handling was checked against the official OpenAI app-server documentation.
- 16: Real-extension test passed (no skipped test), including signed-out guest,
  explicit UI grant, saved login reuse only in the automation tab, immediate
  revoke, late-result rejection, preserved unrelated tabs, persisted pairing and
  default-off after browser/controller restart. Five ownership/pairing/session
  tests and the desktop/mobile setup browser test also passed.
- 14: Five browser checks passed: composer/command UI at 320–1440px,
  agent switching, prefix selection via keyboard/click, delayed discovery,
  Escape cancellation, retryable errors, and no accidental prompt submission.
- 15: Read-only live audit: 495 records = 254 real (16 user, 10 assistant,
  227 tool, 1 system) + 241 tagged synthetic. The agent is idle with no queued
  input or pending approval. Asked for the source real conversation and for
  permission to activate the backend without interrupting work. No data changed.
- 12: Compact-sidebar browser check passed: no status/age sub-row, controls align
  with the title, row height stays below 40px, status remains accessible.
- 13: Preview CSS uses a low-priority layer with system typography, spacing,
  zebra tables, borders, code/list/heading styles, and responsive padding.
  Previously passed document tests verify actual table styles/alignment and
  author-CSS overrides without changing the host UI.
- 11: Both deletion browser tests passed: cancel keeps the chat, confirmation
  deletes only its target, other drafts remain, mobile controls fit, failures
  stay retryable, deleting the final chat clears previews, and another open tab
  updates. Tests delete isolated fixtures only, never the user's live chat.
- 10: Passing MCP tests demonstrate independent same-name Linear connections,
  distinct credentials, primary-repository filtering despite a secondary repo or
  display group, denied cross-company capability use, and independent disconnect.
  The browser check saves/selects both connections in one multi-company environment.
- 09: Read client/server transport paths: `/api/chats/:id/browser/live` is an
  authenticated WebSocket; `/api/chats/:id/events` and `/api/sidebar/events` are
  SSE with reconnects/heartbeats. Mutations use HTTP. Provider PR checks are
  separate scheduled HTTP polling, not page reload polling.
- 08: The already-passing document acceptance tests check desktop three-column
  geometry, HTML/Markdown/SVG/text, independent preview scroll across live updates,
  panel mutual exclusion, focus restoration, draft preservation and widths down
  to 320px. No iframe is mounted inside the message transcript.
- 07: Browser acceptance passed for hover/mobile opening, original-message
  positioning/focus and Escape dismissal.
- 06: Up/Down traversal stops at the first message, preserves the unsent draft
  and per-chat edits, ignores modifiers/selection/IME composition, and sends
  nothing. Unit and browser acceptance checks passed.
- 05: Real PostgreSQL restart restores messages and context into an empty new
  controller directory. Stop-time usage is flushed before worker cleanup; saved
  account/rate-limit data also survives. A stopped-chat browser reload shows the
  context snapshot without any wake/message/queue requests. Six relevant unit
  checks and the browser acceptance check passed.
- 04: Read-only discovery against the real Paladira endpoint succeeded: it
  advertises dynamic registration, PKCE S256, read/write scopes and refresh tokens.
  A matching `/api/mcp` + `/api/oauth/*` fixture completed registration, consent,
  code exchange, saved-token reload and tool discovery. Six OAuth tests and the
  popup-consent browser test passed. No live account was authorized; real consent
  remains a user action after backend activation, not a claimed completed install.
- 03: All seven presets fill the expected endpoint/authentication without saving
  or granting access. Verified against official [Linear](https://linear.app/docs/mcp),
  [Atlassian](https://atlassian.github.io/atlassian-mcp-server/),
  [GitHub](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md),
  [Sentry](https://mcp.sentry.dev/),
  [Figma](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/),
  [Notion](https://developers.notion.com/guides/mcp/get-started-with-mcp), and
  [Context7](https://context7.com/docs/resources/all-clients) docs. Updated the
  Atlassian help URL; its recommended v2 endpoint was already correct.
- 02: Both installed CLIs discovered selected HTTP and stdio MCPs using private
  temporary configurations, without model calls or real credentials. Nine
  connection/OAuth/environment tests and two MCP browser checks passed. Worker
  configuration contains scoped gateway capabilities, not upstream secrets;
  stopping/restarting revokes and refreshes those capabilities. Native Codex
  configuration was checked against the official MCP documentation.
- 01: Four browser acceptance checks passed for Markdown, raw/fenced HTML,
  malformed snippets, CSS isolation, blocked remote requests, desktop/mobile
  preview panels, and live updates. The running server returns the expected
  opaque-sandbox preview CSP and all required preview assets successfully.
- Prior regression run: 121 unit/integration checks passed. Browser run: 32/34;
  the old Compact-disabled assertion was updated and a real smooth-scroll/history
  paging regression was fixed. Both affected browser cases then passed three
  times each. This is not a substitute for ordered feature acceptance.
- Both installed Codex and Claude completed native compaction through Relay's
  real adapters against deterministic loopback API stubs; no real model calls.
- Do not discard the active live worker, unsent drafts or guest Chrome/cart state
  during deployment. Real OAuth consent must be completed by the user.
