# Slash command coverage — queue item 20

This is an implementation checklist, not a claim that all commands are complete.
Commands typed into the composer must perform their real action; sending a
terminal command as ordinary model text is not an implementation of that action.

Native behavior is checked against the installed Codex 0.154.0 app-server schema,
the official [command reference](https://learn.chatgpt.com/docs/developer-commands)
and [app-server reference](https://learn.chatgpt.com/docs/app-server). Claude's
installed commands and plugin aliases are discovered from its initialize response
and remain at the beginning of native stream-json input.

## Implemented paths

| Commands | Dispatch / verification |
| --- | --- |
| `/goal`, objective, `edit`, `pause`, `resume`, `clear` | Persisted native thread goals; resume queues when busy; objective edits preserve multiline text. Real CLI protocol checks pass; new edit/queue browser check passes. |
| `/plan [task]` | Native Plan collaboration/read-only mode; busy requests queue. Unit and browser checks pass. |
| `/compact` | Native compaction, FIFO while busy, wakes stopped worker. Real Codex/Claude adapters tested with local API fixtures. |
| `/review [--base branch / --commit SHA / instructions]` | Native `review/start`, not an ordinary prompt. Tracks both inner execution and outer completion IDs. Real adapter completion and interruption pass. |
| `/side [question]`, `/btw [question]` | Native ephemeral Codex fork on the same worker, separate third-column transcript/questions, scoped attachments and independent stop. Parent context/goal/turn are retained; no copied chat folder or injected main messages. Real installed CLI verified concurrent turns, inherited context, active-goal isolation, cancellation and parent survival. Controller/browser checks pass; live backend activation pending. |
| `/fork [title]` (Codex) | Independent chat, workspace, native history and attachment records. Same company/environment/settings, without queued inputs, approval state or browser grants. Active-source and nested-fork native tests pass; goals remain paused until explicit input. Empty chats need no fabricated native turn. Controller and browser retry/draft/navigation checks pass; live activation pending. Workspace portability limits are below. |
| `/agent`, `/subagents` (Codex) | Native descendant picker, separate conversation/composer/approvals, direct replies or active-turn steering, and child-only interruption. Bounded history pages and controller-owned snapshots remain readable while asleep. Verified with the installed CLI using synthetic stored sessions and loopback responses, plus controller and desktop/mobile browser tests. Live activation pending. |
| `/ide [task]` (Codex), `/mention [path]`, `@path` | Explicit workspace viewer and file/folder references. `/ide` stages its open files and the active file's selected range, optionally sending/queueing a task. Codex receives native untrusted `additionalContext`; snapshot attachments persist with queued/sent input. Real CLI, controller and responsive browser checks pass; external-editor integration is not claimed. Live activation pending. |
| `/apps` (Codex) | Current-thread native catalog, search and availability states; explicit selection stages a token and structured app reference. References persist with queued/sent input and are revalidated at dispatch. Protocol, controller and responsive browser checks pass; installed-CLI empty/private-profile check passes without inference. Authenticated invocation and inherited host-account company isolation still need acceptance; live activation pending. |
| `/plugins` (Codex) | Searchable marketplace/details UI; confirmed install, enable, disable and removal in a private chat profile. Native CLI, policy, recovery, controller and responsive browser checks pass. Shared host profiles remain inspection-only pending item 21; remote authenticated marketplace acceptance and live activation are pending. |
| `/hooks` (Codex) | Event/search browser, executable-source review, explicit hash-bound trust and verified enable/disable in idle private chat profiles. Unit/controller, responsive browser and real CLI command/MCP hook execution checks pass. Managed hooks stay locked; shared host profiles hide definitions and remain read-only pending item 21. Live activation pending. |
| `/experimental` (Codex) | Current-thread native beta catalog and confirmed private-profile toggles. Native requirements and higher-priority overrides stay locked. Config writes are verified; startup-only features retain a restart notice, without automatically stopping workers or Chrome. Unit/controller, responsive browser and real CLI persistence/override checks pass. Shared host mutations and live activation remain pending. |
| `/memories` (Codex) | Separate local-memory feature, use and generation controls plus confirmed profile-only reset. Native summary injection, current-thread contribution updates, persistence, background consolidation and retained conversation history pass real-CLI checks; unit/controller and responsive browser checks pass. Shared host profiles remain read-only pending item 21; live activation is pending. |
| `/import` (Codex) | Claude/Cursor selection and confirmation, whole setup groups or individual conversations, asynchronous results and explicit incomplete-outcome recovery. Imported conversations open as independent stopped Relay chats with copied workspaces and native history. Private-fixture unit/controller, browser and actual-CLI checks cover draft safety, idempotent opening, source deletion and native resume. Unsupported native content stays visibly marked. Shared host mutations and live activation remain pending. |
| `/approve` (Codex) | Review captured automatic-review denials and explicitly queue one exact-action retry. Encrypted owner/project/session binding, idempotent confirmations, FIFO/paused queues and fail-closed interruption handling. Real CLI tests cover approval context, same-thread resume, a harmless command execution, continued automatic review, an actual filesystem-permission denial and all seven action formats. Unit/controller and desktop/mobile browser checks pass; live activation pending. |
| `/feedback` (Codex) | Explicit policy check, literal report review and final external-upload confirmation. Logs off by default; private-profile diagnostics are a separate opt-in, shared host logs stay blocked. Encrypted owner/company/session/worker-bound intents prevent automatic repeats after lost replies or restart. Real CLI checks use a network-isolated local TLS receiver, not OpenAI. Unit/controller and responsive browser checks pass; live activation pending. |
| `/logout` (Codex) | Read-only status, explicit private-account inspection and separately confirmed native credential removal; queue pauses and history/draft/files remain. Native account and file removal are verified, with credential/policy/worker-bound consent and no automatic replay after uncertainty. Shared host, OS keyring/auto and gateway-hidden ephemeral accounts remain locked. Unit/controller, responsive browser and network-isolated real-CLI checks pass; live activation pending. |
| `/keymap` | Relay web equivalent: edit/save/unbind/restore actual global and main-composer shortcuts, with duplicate/reserved-key validation, context precedence, per-account persistence and conflict checks. Main history boundaries, draft/files, IME/pickers and busy queue behavior are retained. Terminal config and worker permissions are never changed. Five unit/controller checks and five responsive browser checks pass; live activation pending. |
| `/vim`, `/vim on`, `/vim off` | Per-chat web composer toggle using a lazily loaded, self-hosted Vim editor. Real Normal/Insert/Visual editing, operators/text objects, search/substitution and undo; Insert-mode Relay shortcuts and attachments are retained. Chat/account changes clear registers, macros, search and undo state. No worker/config/model action. |
| `/statusline` | Relay web equivalent: choose/reorder 15 footer fields with preview, explicit save, hide/defaults and per-account persistence. Saved worker data updates the footer without extra polling or wake-up. Missing/stale snapshots are labelled; default branches and detached HEADs work independently of PR discovery. Native terminal config is unchanged; activation pending. |
| `/title` | Relay web equivalent: configure the actual browser-tab title with eight ordered fields, live preview, explicit save, neutral app-only title and per-account persistence. Runtime/goal/plan updates use saved chat data; animation respects reduced motion and visibility. Does not rename a chat or change native configuration. Activation pending. |
| `/theme` | Relay web equivalent: preview/save four syntax palettes with per-account persistence; real self-hosted code tokenization in an isolated browser worker, plus themed diff colors. Keeps literal source, drafts/files and active work unchanged. Unknown/large/complex blocks stay readable; worker failures can be retried. Activation pending. |
| `/pets`, `/pet`, `/pets <name>`, `/pets off` | Relay web equivalent: eight real built-ins, saved selection/Off, private uploaded custom pets and current-chat activity. Preview/save, named selection, reduced motion, hidden-tab pausing, bounded image decoding and explicit custom deletion. No agent input or native profile changes. Activation pending. |
| `/app` (Codex) | Explicit same-session desktop link for verified local host profiles, with native locator inspection, stopped-session cache, computer/profile confirmation and no prompt/credential/history transfer. Remote/private profiles show their actual connection limits. Controller/browser and installed-CLI inspection checks; OS launch acceptance and private/remote handoff remain open. |
| `/init [instructions]` | Repository-instruction creation task, preserving existing AGENTS.md and unrelated edits. Parser/dispatch tests; resulting repository document still needs acceptance verification. |
| Installed Codex skills | `skills/list` plus structured skill input. No fake terminal entries substituted for skills. |
| Installed Claude commands / plugin aliases | Native input prefix retained, not hidden behind Relay system/handoff instructions. Real CLI `/reload-skills`, `/autocompact 200k` and `/config` return visible native results without any model call; full installed-command acceptance still pending. |
| `/model [id/default]`, `/effort [level/default]`, `/reasoning [level/default]` | Picker without arguments; queued validated settings with arguments. Model changes reset previous effort. |
| `/permissions`, `/mode` | Permission picker; `auto`, `edits`, `read-only` apply the existing native policy modes, in FIFO order when queued. |
| `/fast [on/off]`, `/personality [friendly/pragmatic/none]` | Catalog-driven, persisted per-chat settings, applied in FIFO order to later turns. Stop/model-change guards, retryable personality picker and draft/attachment protection. Controller/browser checks and actual installed-CLI parameter/resume verification pass; live activation remains pending. |
| `/usage`, `/status`, `/context` | Existing session/usage inspection. |
| `/diff`, `/mcp`, `/skills`, `/help` | Workspace diff, connection manager, installed-command picker. |
| `/new`, `/clear`, `/resume` | New-chat flow or searchable saved-chat picker; never implicitly delete the old conversation. |
| `/rename [title]`, `/archive`, `/delete` | Existing organization APIs; deletion retains explicit target confirmation. Delayed responses preserve newer drafts. |
| `/copy`, `/raw`, `/transcript` | Latest completed response and plain transcript preview. |
| `/stop`, `/quit`, `/exit` | Relay's stop-agent-and-pause-queue control. This is broader than native Codex `/stop` (background terminals only), and is labelled accordingly. |
| `/ps`, `/clean` | Native thread-only background-terminal discovery and confirmed individual/all termination; never send a model prompt or kill another chat's tasks. Controller/browser tests and real-CLI empty-task inspection/cleanup pass. |
| `/debug-config` | Explicit allowlist of non-secret effective Codex configuration and source layers; never dump raw config, MCP credentials or environment variables. |
| `/reset`, `/name`, `/cost`, `/stats` | Aliases to the same web new-chat/rename/usage controls, including typed arguments. |

## Remaining inventory

Keep item 20 in progress until applicable gaps below are implemented and tested.
Do not treat removing entries from autocomplete as implementing them.

- `/import` private-profile review, execution and conversation opening are
  implemented below; shared host mutations remain gated on company isolation (21).
- `/plugins` private-profile management is implemented below. Shared authenticated
  host-profile mutations remain gated on native company/profile isolation (21);
  remote authenticated marketplaces still need account-specific acceptance.
- `/hooks` private-profile management is implemented below; shared host profiles
  stay read-only until company/profile isolation (21).
- `/experimental` private-profile toggles are implemented below; shared host
  settings also remain read-only until company/profile isolation (21).
- `/memories` private-profile controls are implemented below. Shared host memory
  settings and resets remain gated on company/profile isolation (21).
- `/logout` private native credentials are implemented below. Shared host,
  keyring/automatic storage and gateway-hidden ephemeral accounts remain gated
  until their company/profile isolation and native visibility can be verified.
- `/app` local-session link and native inspection are implemented below. Actual
  OS desktop launch is unverified in this headless Linux test environment.
  Private gateway-profile handoff and one-click remote-host selection are not
  implemented; guidance is not counted as completing those paths. No documented
  chat-link parameter selects `CODEX_HOME` or a remote host, so Relay must not
  invent one or copy credentials to make a misleading local link appear to work.
- Windows-only sandbox setup and read-directory commands do not apply to the
  current Linux worker. Native APIs still need capability/version checks if a
  Windows worker is introduced.

### Fast and personality

OpenAI Docs' [developer commands](https://learn.chatgpt.com/docs/developer-commands)
defines Fast as a catalog-advertised tier toggle and personality as a supported
model's communication style for later responses. Relay keeps both choices in
the chat record instead of editing a shared host profile. Commands produce
visible confirmations without becoming model prompts. Busy changes run in FIFO
order; unsupported models do not receive stale Fast/personality overrides.

Slow capability lookups and validation recheck turn cancellation and the original
model selection before saving. A newer model choice or explicit Fast-off wins
over an older in-flight command. The personality picker allows only one pending
selection, retains unsent attachments, reports retryable errors, and cannot
submit into another chat or close a newer dialog. A delayed send failure restores
the failed command only if its original composer is still empty; it never
overwrites a newer draft or another conversation's input.

Verification: eight controller/unit cases and eight browser scenarios pass.
The normal default-concurrency `npm test` passes **370/370**; the related browser
run passes **22/22**, including desktop handoff and existing command controls.
The installed Codex **0.154.0** smoke uses real advertised model metadata and
asserts a new native settings acknowledgement for each turn, all three
personality values, the actual Responses service tier, and Fast-off after
same-session resume. Native clearing normalizes the tier to `default`. This
uses four loopback fixture responses, not external inference or user accounts;
real account entitlement, pricing and paid-service latency are not tested.
Repository JavaScript syntax/whitespace checks and 320px visual inspection pass.

Initial regressions reproduced post-stop setting writes, duplicate-enabled
picker choices, late modal dismissal, the attachment barrier and draft overwrite;
these are fixed. The smoke initially used the wrong acknowledgement field and
expected a literal null instead of the CLI's normalized default; the generated
protocol and actual native reply corrected those fixture assumptions. No
timeouts or assertions were relaxed to conceal a product failure. This focused
browser run does not close older full-suite history/network failures. Nothing
was deployed. Item 20 remains open; next is `/init` repository-document
acceptance, then remaining installed Claude-command acceptance.

### Desktop handoff

OpenAI Docs' [CLI command reference](https://learn.chatgpt.com/docs/developer-commands#continue-in-the-desktop-app-with-app)
defines `/app` as opening the same saved session (the native CLI documents this
for macOS/Windows). The [desktop deep-link reference](https://learn.chatgpt.com/docs/reference/commands#deep-links)
provides `codex://threads/<thread-id>` for a local chat. This differs from moving
a chat and its Git state between already connected desktop hosts. The
[remote guide](https://learn.chatgpt.com/docs/remote-connections#connect-to-an-ssh-host)
requires a user-configured authenticated SSH connection. These sources do not
establish a `CODEX_HOME`/remote-host selector for local chat links.

Relay's `/app` and Chat actions menu open a review panel, never an ordinary model
message or a process on the server. An awake Codex adapter reads its own native
`thread/read` metadata with `includeTurns: false`; it validates thread identity,
non-ephemeral history, workspace and profile-contained session path. Native
errors are not dumped into the browser. Authentication mode comes from the
actual worker startup, not a subsequently changed configuration. Relay returns
and caches only the validated locator; it does not request turns, read history
files, access account APIs/native settings or copy credentials or SSH keys.

A small locator is cached in controller records, bound to chat, owner, company,
environment, workspace, session, backend and configured host profile. Stopped
workers use a clearly labelled saved location, without waking. Owner/scope
changes invalidate it; explicit chat deletion removes it, including a late
write racing deletion. Unverified old/empty sessions get no fabricated chat or
forced seed message. Refresh while the existing worker is awake verifies them.

Local host-profile links require explicit confirmation of the same computer and
profile. The URL contains only the validated native UUID, never a Relay ID,
prompt, token or guessed path parameter. Relay keeps the chat/draft/attachments
and queue intact, warns about concurrent work, and says only that opening was
requested: a web page cannot prove that the installed desktop app received it.
Remote host profiles offer the documented SSH-settings link and guide; private
gateway profiles stay visibly unavailable for desktop handoff. Neither case is
silently exported or routed into an unrelated local profile. These limitations
remain open above, not disguised as full command completion.

The HTTP endpoint is authenticated, owner-checked, read-only and `private,
no-store`; it rechecks login after asynchronous inspection. The UI clears old
paths/links on refresh, failure, account/session changes or chat navigation, and
ignores late responses. Clipboard denial falls back to selecting literal text;
unsupported command arguments retain the draft. New tests cover these behaviors
without launching a personal desktop app. The actual installed Codex 0.154.0
smoke uses a disposable profile and one loopback fixture response to create a
saved thread, then proves identical session/profile before/after resume and an
unchanged native transcript. Inspection makes no extra inference requests.
OS launch, remote/private handoff and live backend activation are not claimed.

Verification: all nine handoff unit/controller cases pass; the normal
default-concurrency `npm test` passes **362/362**, including real Chrome.
All seven handoff browser scenarios pass in the final **20/20** related-command
browser run. The installed-CLI smoke passes on the final source, and JavaScript
syntax/whitespace checks pass. The 320px layout was visually inspected. Initial
failures found an overridden cache header (fixed) and two test-fixture mistakes
(busy Stop versus Queue, and assuming a hash router); the tests now exercise the
real controls without weakened assertions or longer timeouts. This targeted
browser result does not erase the earlier full-suite history/network failures.
Fast/personality browser/native parameter acceptance is recorded above. The
remaining `/init` and installed Claude-command checks still keep item 20 open.

### Pets

OpenAI Docs' [pet guide](https://learn.chatgpt.com/docs/pets) establishes the
CLI picker aliases, direct named selection, Off, custom companions and four
current-session states. Its web guidance supplies the standard transparent
1536 × 1872 PNG/WebP sheet and 20 MiB upload limit. The installed Codex 0.154.0
app-server protocol has no pets RPC. Relay therefore implements a web companion
using the actual built-in v4 sprite sheets, without writing native `tui.pet`,
scanning a host profile or substituting an agent prompt for the command.

Codex, Dewey, Fireball, Rocky, Seedy, Stacky, BSOD and Null Signal are selected
from a staged picker or by name/ID. Off is persisted too. Only the currently
selected, account-permitted chat supplies activity; missing/stopped states are
not presented as completed work. Pending input takes precedence over work.
One companion and one picker preview retain at most one decoded sheet each;
decodes are serialized per view, superseded work is discarded, replaced/late
bitmaps are closed, and closed pickers release their listeners and animation.
Reduced motion uses a still frame; hidden tabs and page suspension stop timers.
Canvas scaling preserves frame proportions, including custom non-square grids.

Custom pets require a private Relay account. The image is explicitly selected
from the user's computer; an optional JSON metadata file can describe a different
grid. Relay reads only those uploaded bytes, never a manifest's file/URL path.
Metadata uses `displayName` (or `name`), optional `description`, a `frame` object
with positive integer `width`, `height`, `columns`, `rows`, and `animations` keyed
by animation name. Each animation has zero-based sheet indexes in `frames` and
`fps`, or a `fallback` to another animation. `idle` is required. Display states
select `typing`, `waiting`, `bounce` or `sad`, falling back to idle when absent.
For example, this describes a 128 × 128 sheet with four 64 × 64 frames:

```json
{"displayName":"Local friend","frame":{"width":64,"height":64,"columns":2,"rows":2},"animations":{"idle":{"frames":[0,1],"fps":3},"typing":{"frames":[2,3],"fps":6},"waiting":{"fallback":"idle"},"bounce":{"fallback":"idle"},"sad":{"fallback":"idle"}}}
```

Without metadata, the standard eight-column/nine-row grid is used (idle,
right/left running, wave, jump, sad, waiting, typing, bounce). The parser bounds
dimensions to 4096 per edge, 256 frames, 32 animations and 60 fps, and rejects
invalid indexes or fallback cycles. Uploads have 20 MiB file and 12-pet/60 MiB
library bounds. The browser decodes the selected image before upload. The
server validates signatures/container headers/dimensions and PNG checksums,
and rejects SVG and animated containers; it is not a full server-side image
decoder. Custom assets are separate from chat attachments
and require the owning account on every read. This documents Relay's supported
metadata fields, not a promise to implement every undocumented native pet-pack
extension. The standard native v4 artwork is independently verified below.

Selection and libraries use per-account records, revision locks, auth/origin
checks, and revalidation after asynchronous operations. The signed-out fallback
is explicitly installation-shared and supports built-ins only. A changed
account clears private names, descriptions, selected files, labels and bitmaps
from an old open picker. Late saves cannot replace a newer preference or dialog.
Explicit deletion removes only that account's selected custom asset and turns
it off if active; built-ins cannot be deleted. Startup/typing/attachments do not
wait for cosmetic settings. No model request, worker lifecycle change, native
profile change, browser observation or new status polling is introduced.

Six pet unit/controller cases, twelve pet browser cases (across the focused
runs below) and all eight real built-ins have passed. The
public-artwork smoke uses a fresh browser, checks fixed SHA-256 hashes, decodes
every declared animation frame, verifies transparency and all four states, and
checks that cached repeats cause no additional external downloads. Its only
external requests are the eight fixed public artwork URLs; no model/account
credentials are used. The mobile layout was visually reviewed and corrected
for readable full-width rows; actual built-in artwork was visually inspected.
The private-picker regression verifies that changing accounts removes old
custom names/descriptions, preview labels, selected files and image pixels;
a cached foreign chat cannot supply activity under the new account.

Verification history is retained, not collapsed into a green aggregate:

- The initial five pet cases and full unit/controller run passed 352/352 at
  concurrency two. After adding quota/failure cleanup coverage, all six pet
  cases pass; the next full run passed 352/353, with one **cancelled** 60-second
  Chrome-extension test. That unchanged test then passed alone in 46.7 seconds.
  The timeout's cause is not established; default-concurrency gates remain open.
- Eleven focused pet browser cases passed together. The full browser run then
  passed 140/147, including all eleven pet and both shared-Chrome cases. One
  failure is item 26's Jump to latest DOM detachment. The other six have trace
  evidence of `ERR_NETWORK_CHANGED` during startup/reload: MCP connection,
  organization pin/drag, syntax-theme persistence, two title cases and Vim
  draft switching. The startup/network condition is not declared fixed.
- After the private-picker cleanup and final scoped CSS adjustments, a combined
  follow-up passed 17/18: the new privacy case and all six unchanged
  network-affected cases passed, but the pet-state case failed before chat
  startup with `ERR_NETWORK_CHANGED` on module requests. That unchanged case
  subsequently passed alone. These follow-ups do not erase full-run failures.
- Repository-wide JavaScript syntax and whitespace checks pass. No assertions,
  timeouts or browser launch flags were relaxed. Failure traces remain under
  `test-results/pets-full` and `test-results/pets-final-followup`; standalone
  follow-up evidence is under `test-results/pets-state-followup`.

No live service/chat/account/Chrome or native profile was changed. Item 20 and
live activation remain open; `/app` is the next UI command.

### Syntax theme configuration

The OpenAI Docs skill's [theme command reference](https://learn.chatgpt.com/docs/developer-commands#choose-a-syntax-theme-with-theme)
establishes a preview picker, confirmation and a saved syntax-highlighting
choice. Relay applies that behavior to the actual conversation code blocks
(including side/child replies) and diff colors, not an unrelated worker terminal
or the agent's prompt. Native `tui.theme`/`config.toml` remains unchanged.

Relay dark, Paper light, High contrast and Plain have a staged preview and
explicit Save. Closing cancels; Restore default is also staged. Busy slash
dispatch does not queue input or stop/wake the agent. Draft text and files stay
intact. Preferences are stored separately per Relay account, with disclosed
installation-shared fallback, authentication/origin checks, scope/revision
guards and account-reset/late-response protection. A newly discovered account
visibly invalidates old open controls. Preference loading cannot gate startup.

A separate module worker lazily loads an allowlisted, self-hosted minimal
CodeMirror tokenizer and grammars from the already-pinned dependency. The page's
opt-in Vim runtime is untouched. Tokens become text nodes/spans, never evaluated
HTML or code; tabs, line endings and Copy source remain intact. Limits cover
80,000 characters, 4,000 per line, 5,000 styled ranges, 40 queued source copies
and a worker deadline. Deferred mounted blocks drain in bounded batches;
discarded/replaced content cannot receive old results. Unknown/oversized/complex
blocks stay plain rather than truncating source. Retry recreates a failed worker
so failed module imports do not remain cached. Isolated document previews keep
their existing CSP, sanitizer and document styling.

Four new unit/controller tests exercise actual pinned grammars, exact source,
limits, persistence, revisions, account/origin/auth rejection and fixed asset
paths. The full unit/controller suite passes 347/347 at concurrency two;
repository-wide JavaScript syntax checks pass. Thirteen browser cases cover
actual token/diff colors, cancellation/defaults, private HTTP persistence, busy
dispatch, draft/files, mobile errors, slow/late settings, account changes, asset
failure/retry, replacement and 70-block batch draining. Initial eight cases
passed. An added account-focus regression failed before the explicit stale-panel
notice/disable fix. The following combined run passed 21/22 (including all nine
Vim cases); its one failure occurred before the theme scenario at chat startup,
with trace evidence of `ERR_NETWORK_CHANGED` on preferences/MCP requests. That
case then passed unchanged in isolation. This does not declare the broader
startup/network condition fixed. Desktop and 320px screenshots were inspected.
The full browser run completed 134/136, including all thirteen theme cases and
both shared-Chrome cases. The failures are item 26's known Jump to latest
detachment and a sign-out case that never reached its scenario because startup
script requests reported `ERR_NETWORK_CHANGED`. No assertion or timeout was
relaxed. A final contrast adjustment makes diff line numbers use the selected
palette's comment color; its computed light-theme color is asserted. After that
change, all thirteen theme, nine Vim and four sign-out cases passed together
(26/26). The sign-out test itself was not changed; passing its follow-up does not
erase the full-run network failure. Code palette foreground colors were checked
against their backgrounds (all exceed 4.5:1); desktop and 320px layouts were
inspected. The broader history/startup failures and prior default-concurrency
failures remain open. No live chat, account, Chrome, native configuration or
service has been changed. Next: `/pets` and `/pet`; item 20 and activation remain
open.

### Browser-tab title configuration

The OpenAI Docs skill's [title command reference](https://learn.chatgpt.com/docs/developer-commands#configure-terminal-title-items-with-title)
establishes interactive selection, ordering, confirmation and persistence. Its
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference#configtoml)
specifies spinner/project defaults and disabling title updates. Relay applies
these to its own browser tab; it never modifies native `tui.terminal_title`,
renames the chat or sends `/title` as ordinary model text. Empty selection uses
the neutral Agent Relay title instead of leaving private chat metadata behind.

Eight fields cover app name, project, activity indicator, status, saved chat name,
Git branch, model and task progress. Reordering supports drag handles and arrows;
the preview is staged until Save. Defaults and the neutral-title button are also
staged. Main draft/files, active work and queue remain untouched. Values render
as bounded plain text, without control/bidi characters, HTML evaluation, arbitrary
templates or prompt/goal/plan contents. The activity timer runs only for selected,
visible, working chats; reduced motion uses a static indicator and pending
answers/approvals stop animation. No additional worker polling is introduced.

Preferences share the tested ordered-field picker/storage mechanics with
`/statusline`, but use a separate record kind and strict field allowlist. They
persist per private Relay account, or explicitly in installation-shared scope.
Authentication, same-origin, account and revision checks reject stale writes.
Account changes neutralize the tab immediately; late acknowledgements cannot
restore another account's settings or overwrite a newer panel or draft.

The installed Codex 0.154.0 does not advertise `update_plan`, including with its
goals feature disabled. Initial native plan smoke attempts correctly failed
instead of claiming fabricated counts. Progress therefore uses the native goal
state when available: active, paused, blocked, usage-limited, budget-limited or
complete. `node scripts/smoke-real-title.mjs` verifies all six and clearing with
the actual CLI in disposable profiles, without model calls or real credentials.
Optional [`turn/plan/updated` notifications](https://learn.chatgpt.com/docs/app-server)
are implemented against the generated schema and a protocol fixture: only
aggregate counts from the current native thread/turn are kept, reset on new turns
or agent changes, and retained across stop/controller reload. Plan text and
explanations never become title metadata or synthetic chat messages. Other
agents and unreported progress remain explicitly unknown.

Seven new unit/controller tests, eleven title browser tests, the ten existing
status-line browser tests and both attachment browser tests pass (23/23 focused
browser checks). Two added regressions failed before correction: delayed title
preferences held up chat startup, and a new account discovered on focus could
project an old cached private chat into the title. Startup title loading is now
non-blocking and the title/preview recheck the cached chat's owner. A real HTTP
browser test verifies private preference persistence without intercepting the
settings endpoint or starting a worker. The full unit/controller suite passed 343/343 at
concurrency two; previous default-concurrency failures remain documented, not
claimed fixed. Native goal-state smoke and repository-wide JavaScript syntax
checks pass. The first full browser run was deliberately interrupted after
31 passes, two failures and one interrupted case to make corrections (86 cases
not run). Its attachment case filled a hidden input before a chat was ready;
explicit ready/visible assertions now precede that artificial file-selection
step, with no assertion removed or timeout relaxed. The known item-26 Jump to
latest detachment also reproduced and remains open. The final full browser run
completed with 122/123 passing, including all eleven title cases: the shared
Chrome case hit its 30-second overall deadline late in its desktop-screenshot/
expand flow after typing and viewport assertions passed. This is recorded as an
unresolved broader browser check, not a green full suite. No assertions/timeouts
were relaxed; both shared-browser cases passed a separate isolated rerun (the
original case in 10.0 seconds) without changing their code. That does not erase
the full-suite timeout or prove its cause fixed. Desktop and 320px title-picker
screenshots were inspected. No live service, user chat, personal Chrome, real
native profile or real account has been changed.
Next: `/theme`; item 20 and backend activation remain open.

### Status-line configuration

The OpenAI Docs skill's [status-line command reference](https://learn.chatgpt.com/docs/developer-commands#configure-footer-items-with-statusline)
establishes interactive item selection/reordering, confirmation and persistence.
Its [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference#configtoml)
also establishes ordered fields and disabling the status line. Relay applies
that behavior to its actual web footer, explicitly not to an unrelated worker
terminal's `tui.status_line` or native `config.toml`.

The picker provides a live preview, checkboxes, drag handles and accessible
up/down controls. Save applies the order immediately; Hide and Restore defaults
remain drafts until saved, and closing cancels unsaved changes. Main draft text
and files are untouched; a successfully opened bare command clears only that
same command, never newer text. It works while the agent is busy without queueing
a model input or stopping work. Footer fields wrap/truncate within the chat;
the responsive picker keeps its header, save/error state and close control
visible while the field list scrolls.

Fifteen selectable fields cover model, model plus reasoning, remaining/used/
maximum context, 5-hour/weekly limits, Git branch, total/input/output session
tokens, native session ID, worker working directory, primary Git root and agent
CLI version. Current context is not cumulative usage; cached input and reasoning
output are not counted twice. Zero is distinct from missing data. Expired limit
windows are marked awaiting refresh, missing fields say Not reported, and stopped
workers show saved snapshots. Metadata is rendered literally, not as HTML.

Native initialization supplies a bounded allowlist of model, worker directory
and CLI version; raw user-agent/host/config data is not stored in these details.
The installed Codex 0.154.0 handshake verifies actual metadata in an isolated
test profile without inference or real credentials. Claude's init path is
verified with a local protocol fixture. Read-only Git probes run on an already
awake worker after ordinary turns and use its primary repository, not a remote
worker's controller mirror. Their default/detached branch snapshot is separate
from PR discovery. Snapshots persist in controller-owned chat records, never as
conversation messages; selecting fields adds no worker/network polling loop.

Only allowlisted field IDs persist in revisioned preferences: per private Relay
account, or the clearly disclosed shared installation scope when signed out.
Authentication, origin, account and stale-write checks protect updates. Delayed
loads/saves cannot switch a chat, replace a newer panel, erase a newer draft or
restore another account's preferences. No provider, GitHub, MCP or Chrome
credential/configuration change occurs. `/title` follows in the checkpoint above;
item 20 stays open.

Seven new unit/controller checks and ten desktop/mobile browser checks pass.
The full unit/controller suite passes 336/336 with
`node --test --test-concurrency=2 test/*.test.mjs`; previous default-concurrency
failures remain recorded in the queue ledger, not declared fixed. Native Codex
metadata verification, repository-wide JavaScript syntax and whitespace checks
also pass. No real account or live worker/service was changed; activation remains
pending.

The first full browser run passed 110/111 and exposed a startup race: automatic
initial chat selection could close a mobile drawer the user had just opened
while settings were loading. A deterministic test reproduced it before the fix.
Initial selection now preserves the drawer; explicit chat choices still close
it. All sixteen organization/status-line checks pass afterward, including the
unchanged original failing test. The final full browser suite passes 112/112.

### Vim composer

The OpenAI Docs skill's [Vim command reference](https://learn.chatgpt.com/docs/developer-commands#toggle-vim-mode-with-vim)
establishes a per-session Normal/Insert composer toggle, distinct from changing
the native default in configuration. Relay therefore applies `/vim` to the web
composer, with explicit on/off arguments and a recoverable Chat actions toggle.
It is never sent as ordinary model text or queued as a worker action. Enabling it
while an agent works does not stop that agent, change permissions or send input.

The pinned, self-hosted CodeMirror 5.65.21 Vim editor loads only on explicit
enable, including its local search/dialog/bracket dependencies and styles. No
CDN, bundler or external script is involved. This provides actual Vim motions,
counts, operators and text objects, Normal/Insert/Visual/Replace modes, registers,
undo/redo, searches and substitutions. The existing textarea is bridged to the
editor's value, selection, focus and range operations, including its native
backing value, so drafts, forms, file paste, attachments and command/file pickers
retain the existing Relay paths. Programmatic replacement clears old undo state;
the existing 100,000-character limit also applies to Vim edits and substitutions.

Unmodified Normal/Visual keys belong to Vim. In Insert mode, configured Relay
send/queue, newline and message-history actions take precedence, as do open
command/file pickers. Modified configured send shortcuts and global controls also
remain usable in Normal mode. Tab leaves the editor when no picker is open. The
visible mode badge, contextual keyboard hint, Keys help and Vim off button make
the mode explicit; turning it off retains draft text and attached files. Ex
commands edit this draft only; `:w` does not save workspace files or send input.

The mode flag lives per chat in the current page. Reload and new chats default to
the ordinary composer; native `config.toml` is not mutated. Leaving a chat,
changing the Relay account or disabling Vim destroys its editor and resets the
pinned upstream Vim register/macro/search state, preventing cross-chat leakage.
No draft text is copied into preference storage. Failed asset loads retain the
typed command and can retry. Loading is generation-bound, so a late response
cannot enable another chat, erase a newer draft or restore a revoked account's
editor. New keyboard styles are scoped to the optional main-composer editor;
side chat, child-agent inputs and Shared Chrome are unchanged.

Verification uses the real shipped editor in isolated Chromium fixtures, not
mock Vim actions. Two new unit/controller tests and nine browser tests pass,
covering actual editing, busy queueing, remapped shortcuts, clipboard files,
workspace references, command/history navigation, chat/account changes, late
loads and errors, mobile controls and message limits. The full unit/controller
suite passes 329/329 with `node --test --test-concurrency=2 test/*.test.mjs`.
The default-concurrency check did not pass: its latest run had 319 passes, nine
failures and one cancellation involving fixture timeouts and shutdown races.
Those failures remain recorded; no tests were skipped or timeouts relaxed.
The final full browser suite passes 102/102, including all nine Vim cases;
repository-wide JavaScript syntax and whitespace checks pass. Desktop and 320px
editor layouts were visually inspected. Item 26's previously reproduced paging
intermittency remains open despite passing this run.
Next remaining command is `/statusline`; item 20 stays open and activation is
still pending.

### Keyboard remapping

The OpenAI Docs skill's [keymap command reference](https://learn.chatgpt.com/docs/developer-commands#remap-tui-shortcuts-with-keymap)
establishes native inspect/remap/persist/unbind behavior and context precedence.
Relay's worker uses the headless app server, not the terminal composer, so
changing the remote terminal keymap would not affect this web input surface.
`/keymap` therefore explicitly controls Relay's web keymap, not `tui.keymap` or
`config.toml`. The same dialog is reachable through Chat actions when a shortcut
has been unbound. It is available for all providers and never becomes ordinary
model input. It opens and saves without waking or stopping an agent.

Seven real actions are configurable: new chat, focus composer, focus the pending
question/approval, send/queue, newline, and previous/next sent-message recall at
the draft boundaries. Global and main-composer contexts are separate; composer
bindings win. Up to four alternatives may be assigned per action. Empty lists
unbind Relay actions while browser-native editing still works. Restore buttons
stage defaults; only saving applies them. Same-context conflicts, repeated keys,
unknown actions and standard browser/editing reservations are rejected by shared
client/server validation. Slash/file pickers retain their existing keys. IME and
AltGraph input is not interpreted as an app shortcut; repeated Enter cannot
resubmit a message. Side, child-agent and Shared Chrome inputs keep their own
controls. Account-specific keyboard settings do not change company credentials.

Preferences are stored in the controller records for the authenticated Relay
account. Legacy sessions without a private account explicitly use installation-
shared preferences; the dialog warns about this rather than implying privacy.
Authentication, same-origin checks, account-bound revisions and serialized writes
prevent cross-account or stale-tab overwrites. Account changes reset active
bindings before reloading. Refocusing the browser reloads saved preferences.
Late responses cannot overwrite a newer dialog, chat draft or newer keymap.
Save errors retain edits, and reloading dirty fields asks before discarding them.

Five unit/controller and five responsive browser checks cover validation, scope,
persistence through service/browser reloads, real dispatch of all seven actions,
busy queueing, draft/file retention, stale writes, IME and late acknowledgements.
Desktop and 320px mobile dialogs were inspected. This is a web-surface equivalent,
not a claim that terminal-only pager/editor keymaps were modified. Vim editing
was the subsequent checkpoint above; item 20 and the queue remain in progress.

### Native sign-out

The OpenAI Docs skill's [sign-out command](https://learn.chatgpt.com/docs/developer-commands#sign-out-with-logout),
[credential storage](https://learn.chatgpt.com/docs/auth#credential-storage)
and [app-server contract](https://learn.chatgpt.com/docs/app-server#api-overview-1)
informed `/logout`. It is native Codex sign-out, not Relay browser logout,
Chrome/MCP/GitHub disconnection, API-key revocation or removal of server-managed
gateway credentials. The dialog explains that gateway access remains available.
Opening saved status does not wake a worker. Explicit inspection may connect
it, using `account/read` with `refreshToken: false`, never an agent turn.

Only a separately confirmed idle private-profile operation invokes native
`account/logout`. Queued messages are paused; main, side, goal and child activity
blocks sign-out without automatically stopping it. File storage is fingerprinted
on the worker, without returning credential bytes. Symlinked parents/files,
hard links, special files and files over 256 KiB are rejected. This is a bounded
read-only preflight, not a filesystem sandbox or an atomic guarantee against an
external process replacing paths after inspection. No direct controller deletion
of auth files is used. Encrypted reviews bind owner, company, repositories,
environment, workspace, native thread, worker, policy and file identity. Native
account-update epochs also invalidate same-kind in-memory account replacements.

Current/admin and startup storage must agree. Shared host sign-out is blocked
before starting the worker or accessing its account. OS keyring/auto storage is
not silently changed to file storage. Real CLI 0.154.0 testing found that a
gateway provider with `requires_openai_auth=false` reports a null account even
after a native dummy API-key login. File-backed removal remains verifiable;
hidden ephemeral credentials are explicitly unavailable, not labelled absent or
successfully removed. The ephemeral positive native fixture uses a temporary
authenticated provider to make its account observable. Workload/unsupported
authentication is not treated as stored native credentials.

Intent is saved before native dispatch. Five-minute reviews cannot be reused
after changed credentials/policy/worker, Stop or scope revocation. Duplicates
return saved outcomes, including during I/O and after restart. Lost replies,
unrecognized acknowledgements and unverifiable removal remain uncertain and
never replay automatically. Success requires the native account to be empty and
the credential file absent. Account/limit snapshots are invalidated without
adding a message to the agent; delayed inspections cannot restore old account
details. History, drafts, files, workspace and sibling profiles remain intact.

Seventeen unit/controller checks, four responsive browser checks and
`node scripts/smoke-real-logout.mjs` cover these paths. The real CLI fixture uses
only private dummy credentials, loopback inference and Linux network/PID
namespaces, including native default-file storage, observable ephemeral storage,
gateway-hidden ephemeral rejection, credential replacement, deduplication and
post-restart state. It never accesses an OS keyring or signs out a live account.
Live activation remains pending. Next: terminal UI equivalents; item 20 remains
in progress, with inherited credential isolation tracked in item 21.

### Native feedback

The OpenAI Docs skill's [command reference](https://learn.chatgpt.com/docs/developer-commands#send-feedback-with-feedback)
and [app-server contract](https://learn.chatgpt.com/docs/app-server#api-overview)
informed the explicit report/review/submit flow. `/feedback` opens without waking
the worker. Checking options or preparing a review explicitly connects the chat,
but sends no report and starts no agent turn. Busy agents can keep working. The
final confirmation calls native `feedback/upload` with the server-selected
classification, exact reviewed reason, current native thread and explicit
`includeLogs`; arbitrary `extraLogFiles`, tags and client-supplied replacement
payloads are not accepted. Composer text and attachments stay untouched.

Logs are off by default. Even without them, the native event includes session,
version and diagnostic/authentication metadata. Opting in can include native
logs, conversation/code, tool activity, paths and diagnostic files. These are
collected at dispatch, not frozen by the review, and Relay does not preview or
redact their contents. Shared host profiles cannot upload logs pending company
isolation (21). Private profiles must have configuration/admin storage paths
within their native home; this configuration check is not a filesystem sandbox
or a guarantee that diagnostics contain no sensitive data. The dialog makes
that disclosure and requires the user's explicit choice.

Current and managed `feedback.enabled` policy are checked before dispatch. The
installed 0.154.0 feedback handler retains startup configuration after a reload,
so Relay also retains its startup policy. A newly disabled setting is enforced
immediately; an initially disabled worker must be explicitly restarted to enable
uploads. Changed or unavailable startup diagnostic configuration disables logs.
No control silently changes policy or restarts a worker or Chrome.

Encrypted bounded report records bind owner, project/repositories, environment,
workspace, auth mode, thread, worker and policy revision. Reviews expire after
five minutes. Durable intent precedes the native upload; repeated confirmations
return the saved outcome. Lost replies, Stop, crashes and malformed acknowledgements
produce an uncertain state, never an automatic retry. A stopped-worker status
read does not wake it. The returned reference is a native session ID, **not** an
independent external receipt or a diagnostic-file delivery manifest.

`node scripts/smoke-real-feedback.mjs` runs the production controller/adapter
against actual Codex with a private profile, deterministic loopback inference
and a local TLS feedback receiver inside Linux network/PID namespaces. No route
to an external service exists; unknown proxy destinations are rejected. It
verifies all four classifications, a text-only envelope with no conversation,
explicit native history/log attachments, matching acknowledgements, failure
handling, deduplication, native disabled policy and no extra agent input. This
does not claim a real support report was delivered to OpenAI. Live activation is
still pending. Native sign-out is covered above; terminal UI equivalents remain.

### Native automatic-review retry

The OpenAI Docs skill's [command reference](https://learn.chatgpt.com/docs/developer-commands)
informed `/approve`: it confirms a retry of a specific automatic-review denial,
not blanket permission or an answer to a currently pending prompt. The installed
0.154.0 schema exposes `item/autoApprovalReview/completed` and
`thread/approveGuardianDeniedAction`. The RPC records native approval context but
does not start a turn; Relay therefore queues a server-owned, reviewed identity,
records native approval at dispatch, and explicitly asks for one retry through
the normal tracked input path. Current permission settings stay unchanged and
the native reviewer can still deny the action.

Only actual main-thread denial notifications become encrypted records. Browser
requests select an opaque review ID/revision, never an event or replacement
payload. Owner, repositories, company, environment, workspace, authentication
mode and native session bind each selection. Display metadata is literal and
redacted. A bounded recent list retains queued selections; duplicate or late
notifications do not reactivate consumed records. Native outcomes predating this
capture cannot be reconstructed safely from the ordinary transcript.

Durable phases precede both the approval write and input dispatch. Stop, lost
replies or controller crashes cannot silently replay an uncertain operation.
Removing a queued retry cancels its selection without granting permission; busy
queues remain FIFO and stopped/paused queues require explicit resume or Send now.
Re-confirming an existing queued identity cannot add a duplicate. Reading the
panel never wakes a worker or sends input, and controls preserve draft text and
attachments. This is a request for one retry, not a promise that the underlying
native manual-approval context is an expiring one-use credential.

The native core's event format differs from the v2 notification: snake_case
fields, a file URI for `write_stdin.cwd`, and one filesystem representation
(deprecated read/write OR canonical entries, not both). Installed-CLI checks
verify all seven action variants and a real permission denial with redundant
deprecated path fields. Conflicting representations are rejected. The private
`smoke-real-approve.mjs` fixture runs a harmless print command after a reviewed
retry, confirms another request is still reviewed/denied, and never contacts a
paid model or user account. Unknown formats fail closed. Live activation and
external-service acceptance are not claimed.

### Native import

`/import` opens the native import picker in the web composer. The OpenAI Docs skill's
[import guide](https://learn.chatgpt.com/docs/import) and
[app-server contract](https://learn.chatgpt.com/docs/app-server) informed the
source selection, review and asynchronous-result design. The installed 0.154.0
CLI has now been exercised in private temporary profiles with Claude Code and
Cursor fixtures, without user accounts or model calls.

`planCodexImport` builds bounded, project-scoped review choices using opaque IDs;
it does not accept client-supplied migration items or paths. Home/profile
discovery is explicit, and chat candidates from other working directories are
excluded. Unknown metadata, duplicate identities, overlarge catalogs and empty
session selections fail closed. Public reviews omit native descriptions and
absolute source paths. A metadata revision is stable across catalog ordering;
it is **not** a file-content fingerprint, authorization check or symlink defense.
Those checks are supplied separately by the worker-side inspector and the
owner/company-bound adapter/controller below.

The real CLI revealed a material selection distinction: `SESSIONS` respects
individual selected session records, but skills, commands and MCP imports ignore
subsets of their detail arrays and copy their whole detected group. The review
planner therefore offers whole non-session groups, with explicit warnings and
complete entry lists, rather than promising per-entry selection. The fixture
also verifies preserving source files and existing instructions, readable native
imported history, matching progress/completion notifications and persisted
results/history after restart. A target instruction file created after detection
is retained and produces neither a success nor a failure record; the UI must not
label every selected item successful merely because the operation completed.

The execution layer, `CodexImports`, now persists confirmation intent before
issuing the native import, correlates asynchronous results by operation identity,
and recovers completed results from native history after a lost response or
restart. Repeated confirmations return the existing operation. Reviews are
single-use and expire after ten minutes; pruning the ten-entry recent-results
window cannot make an old confirmation execute again. Progress can arrive before
the RPC response and can be incremental or cumulative across scopes. Partial
failures and selected items with no reported outcome remain distinct from
success. Raw native error bodies are excluded from saved and public results.

An observation timeout or missing history never proves that a worker stopped.
Acknowledging an uncertain partial import requires an observed stop of its exact
original worker, fresh inspection/reconciliation and explicit confirmation; it
does not retry the import. Correlation does not depend on controller/worker clock
agreement. Lost SSH transport leaves the outcome uncertain; only an observed
native exit or a completed stop of the matching EC2 instance can confirm that
worker stopped. Starting a replacement does not certify an older process's exit.

`codexImportFileState` now inspects source/destination files on the actual worker,
opening each path component without following symlinks. It rejects hard links,
special files, out-of-scope local marketplace references and Git redirects.
Bounded content hashes invalidate stale confirmations; native rollout/SQLite
appends and owned temporary scratch activity do not invalidate an otherwise
unchanged review. Concurrent scratch-directory changes get at most three safety
scan attempts within the same overall bounds; links remain rejected and actual
source/configuration changes still invalidate the review. No import is retried.
Its limits are 50,000 files, 2 GiB total content, 512 MiB per
file, depth 64 and 30 seconds. Exceeding a limit fails instead of returning a
partial fingerprint. Remote inspection runs with worker-owned roots and a
minimal environment. This is a read-only preflight, **not a sandbox** against
arbitrary imported code or concurrent changes after inspection.

The production adapter stores operation records through Relay's encrypted
record store, bound to chat/owner/company/environment/auth mode and actual
workspace/profile roots. No plaintext fallback is added. Tests explicitly
inject test records. Confirmations are saved before native dispatch, and real
process-exit notifications preserve recovery state. Reconciliation rereads
native policy, reloads saved configuration with an empty edit list, checks hooks
and refreshes skills. It neither trusts hooks, authenticates accounts, restarts
Chrome/the worker nor sends an agent message. Some saved settings still require
a later user-controlled restart to take effect.

Authenticated, same-origin `/api/chats/:id/imports` POST routes now support
review, status, refresh, confirmed start, acknowledgement and conversation opening. Clients
cannot submit native paths, arbitrary RPC methods or migration items. Ownership,
company, native root and Stop are rechecked after asynchronous work. Unfinished
imports hold idle sleep and block main/side/child input, compaction, forks and
goal resumption; queued inputs remain queued. Stopped-chat input cannot bypass
an unreconciled saved operation. Deleting a chat removes only its own record.

Nine selection-plan, seventeen execution/recovery, twelve filesystem and nine
adapter/controller tests cover this backend. `node scripts/smoke-real-import.mjs`
now exercises the production inspector/reconciler and actual adapter with the
installed CLI, in addition to selective history import and restart recovery.
A never-messaged native root may have no rollout to resume; its saved import
outcome survives and a confirmation for the replaced root is rejected without
repeating the import. No synthetic turn is inserted to materialize that root.

The picker defaults to no selections, explains whole-group scope and shows
complete entry names as literal text. A second confirmation precedes mutation.
Progress polls only while the panel is open, and recovery errors never replay
an import. Result cards distinguish imported, failed and unreported items.
Closing or switching chats cannot let a late response overwrite the current
draft, attachments or newer dialog.

Opening a recorded imported conversation is separately confirmed and idempotent.
It creates an independent stopped Relay chat in the same company/environment,
copies the current self-contained workspace and stores its forked native history
privately. Personal accounts and profile-level configuration are not copied.
An empty draft can navigate to the new chat; a nonempty draft or attachments stay
in the source chat. No agent input is sent until the user explicitly continues.
The native bundle survives source deletion and resumes the same session after
restart. Workspace snapshot limits are the same as `/fork` below.

Visible history excludes private reasoning. Native inline raster images and
ordinary files inside the copied workspace can become chat-scoped attachments;
remote image URLs and files outside that workspace are never fetched. Missing
images remain explicit inert references. The installed Claude importer itself
replaces image blocks with `[external unsupported block: image]` text; Relay
preserves this marker and warns, rather than claiming image fidelity or silently
rebuilding different model context from the original source. Display history is
bounded at 50,000 messages / 32 MiB, and copied images at 5 MiB each / 64 MiB total;
exceeding a bound fails without publishing a partial chat.

Six imported-chat controller tests cover scope, copying, independent attachment
records, lifecycle cancellation and cleanup. Five desktop/mobile browser checks
cover review, recovery, navigation, drafts and late responses.
`node scripts/smoke-real-import-chat.mjs` exercises actual Claude import, native
unsupported-image markers, independent Relay adoption, source deletion and two
explicit continuations across restart using only loopback model responses.
The regular native `/fork` smoke also passes after sharing its capture path.
Overall item 20 remains in progress for the remaining commands. Shared-host
mutation remains gated on company/profile isolation (21); live activation remains
pending. No live data, account, worker or personal Chrome session was changed.

### Native memory controls

`/memories` distinguishes the `features.memories` feature gate from
`memories.use_memories` and `memories.generate_memories`. The official
[memory guide](https://learn.chatgpt.com/docs/customization/memories) and
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
inform the defaults, storage and contribution semantics. The installed 0.154.0
TUI specifically saves use/generation defaults to native configuration and also
updates the current thread's generation mode. Relay follows that behavior in a
private, per-chat native profile rather than modifying a shared host account.
It does not advertise this as a ChatGPT memory control or a global account change.

Use changes take effect when a native session loads the updated settings; they
do not erase memories already included in conversation history. Generation
controls whether chats contribute to future memories, including the current
thread via `thread/memoryMode/set`. An opt-out is applied to the current thread
before defaults are saved, and recovery cannot silently reverse it. If a native
opt-out races an in-flight enable, contribution is disabled again and the user
must refresh. Background consolidation of existing memories can still run on
startup with new contributions off: the real CLI fixture verified this, so the
UI explicitly warns about quota and keeps the Local memories switch separate.
Enabling or viewing this panel does not inject an ordinary agent message.

Only these three fixed config keys can be written. Discovery supplies the actual
native thread, reads admin requirements and config origins, and rejects missing,
ambiguous or incomplete feature metadata, unknown policy and pinned/overridden
settings. Mutations require an idle root/side/child state, fresh revision,
confirmation and matching owner/company/native root before and after async work.
Shared host profiles never write, change thread memory modes or reset data;
memory file contents, raw config paths, model overrides, credentials and native
error details are not returned to the browser. Incomplete changes block further
input until refresh reconciles them. No worker, browser or terminal is restarted.

Reset uses native `memory/reset` only after confirmation of irreversible deletion
from the chat's private profile. It removes generated memory files and rollout
summaries, not native conversation logs, Relay messages or configuration. It
does not promise that existing context is forgotten or prevent a still-enabled
feature/background job from creating memories again. An uncertain reset reports
possible partial deletion and is never automatically repeated on refresh.

Nine unit/controller checks and three browser checks cover policy, confirmation,
stale/cancelled writes, opt-out recovery, reset scope, mobile layout and draft/file
preservation. `node scripts/smoke-real-memories.mjs` verifies real native summary
injection versus disabled use, contribution mode in the native database
(read-only inspection), persisted choices, startup consolidation and reset
preserving unrelated memory files, config and native conversation history. It
uses only private fixture profiles and loopback model responses. It does not
claim to evaluate the quality of real generated memories, inherited host-account
isolation or live deployment.

### Native experimental features

`/experimental` uses `experimentalFeature/list` with the actual loaded native
`threadId`, rather than a process-wide/default feature snapshot. It displays
native beta entries with their descriptions, configured/default state and
announcements. Internal under-development, stable, deprecated and removed flags
are not presented as user-facing beta toggles. Pagination is bounded to five
100-entry pages, with at most 200 beta entries displayed; incomplete catalogs,
duplicate identities or incomplete policy/metadata cannot be mutated.

`configRequirements/read` supplies pinned feature policy; `config/read` resolves
the current workspace's config origins. Managed requirements, project/session
overrides and selected-profile overrides are locked. Only a fresh, confirmed
native beta identity can write its own boolean `features.<name>` key in the
private worker profile. The API does not accept arbitrary config keys, paths or
RPC methods. Effective state and write status are checked after hot reload;
partial or overridden writes require refresh before further changes or agent
input. Canonical revision hashing ignores native JSON object ordering while
still invalidating genuinely changed definitions, values and policy. Shared
host profiles perform no writes; source paths, native errors, credentials and
unrelated config are not returned to the browser.

The official [experimental command guide](https://learn.chatgpt.com/docs/developer-commands#toggle-experimental-features-with-experimental)
requires a restart for some changes. The UI distinguishes a verified saved flag
from startup-time effects and keeps a restart notice. Saving never restarts the
worker, background terminals or Chrome, nor creates an agent message. Network
proxy is not a sandbox network-access grant. Prevent sleep while running concerns
the worker computer, not Relay's browser-presence or idle-container timers.

Ten unit/controller checks and three responsive browser checks cover scoped
discovery, policy locks, confirmation, stale/cancelled writes, reconciliation,
late replies and draft/file preservation. `node scripts/smoke-real-features.mjs`
uses the installed CLI with a private temporary profile and zero model requests.
It toggles Network proxy, Worktrees and Prevent sleep while running, verifies
native refresh and restart persistence, and confirms a trusted project override
cannot silently overwrite the saved user-level choice. Model, approval, sandbox
and MCP config remain unchanged. This verifies flag configuration, not OS sleep,
proxy traffic or native worktree creation as separate end-to-end capabilities.
Inherited host-profile company isolation and live deployment remain explicit gates.

### Native hook management

`/hooks` uses `hooks/list` for exactly the selected worker workspace and exposes
bounded, literal command/MCP metadata, event filtering and search. New or modified
definitions require explicit source-review confirmation. Trust records the exact
native hash; it does not enable a disabled hook. Enable and disable have separate
confirmation, and managed hooks remain locked, following the official
[hook trust guide](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).
The hash covers the definition, not the contents of referenced scripts. Native
MCP metadata does not include input templates; the UI directs users to review
the source and arguments rather than pretending to show a complete MCP request.

The installed Codex 0.154.0 protocol has `hooks/list` but no hook-mutation RPC.
Private-profile actions use allowlisted `config/batchWrite` entries under
`hooks.state.<native key>.trusted_hash` or `.enabled`, with `reloadUserConfig`.
Those exact persistence keys and hot-reload behavior were verified against the
installed CLI, not inferred from undocumented request names. The browser cannot
provide a config path, trust hash or arbitrary RPC. Shared host profiles perform
no writes and omit commands, paths, matchers and status text from API responses.
Unknown policy, unsupported handlers/events, duplicate identities and native
configuration errors fail closed. Ownership, company, native root, revision and
idle main/side/child state are checked before mutations and after asynchronous
operations. Interrupted or overridden writes require reconciliation before new
mutations or agent input. Control characters are made visible in source reviews.

`hooks/list` reads current source files while loaded native threads can retain
old definitions. Refresh therefore reloads an idle private worker first, without
granting trust or changing unrelated config values. Inspection during active work
does not reload; the UI explains that its disk view needs an idle refresh. No
synthetic user input is created. Waking a worker can run its already-trusted
native lifecycle hooks, just as normal native startup does.

Eleven unit/controller checks and three desktop/mobile browser checks cover
actions, policy, stale state, cancellation, partial-write recovery, safe literal
rendering, hidden host definitions and draft/attachment retention. The real-CLI
`node scripts/smoke-real-hooks.mjs` verifies command and MCP hook execution into
loopback model input, skipped untrusted/disabled/modified hooks, retrust, reload
and restart persistence. It also verifies that changing MCP argument templates
invalidates the native trust hash. It uses only its own temporary profile, a
local anonymous MCP fixture and no real account or paid inference. Authenticated
MCP-hook acceptance, inherited host-profile company isolation and live deployment
are not claimed by that fixture.

### Native plugin management

`/plugins` opens searchable marketplace tabs with installation/enabled state,
details and explicit action confirmation. Catalog data comes from the supported
`codex plugin list --available --json` CLI plus `plugin/installed` policy.
Install/removal use literal-argv `codex plugin add/remove ... --json`; enablement
uses an allowlisted `config/batchWrite` key in the worker's private profile.
The official [app-server reference](https://learn.chatgpt.com/docs/app-server)
marks plugin list/read/install/uninstall RPCs as not ready for production clients,
so this implementation does not call those methods. Native plugin layout and
enablement follow the [plugin guide](https://developers.openai.com/plugins/build/plugins).

Host-auth workers share a host profile and are inspection-only. Private gateway
profiles permit mutations only with current chat ownership, primary company,
native root, fresh catalog/source revision, idle main/side/child agents, native
policy and explicit confirmation. Unknown/ambiguous installed policy, managed
plugins, admin restrictions, known native installation-interstitial requirements
and marketplace load errors fail closed. Uninstalled entries are absent from
`plugin/installed`; the supported CLI supplies and enforces their install policy.
No arbitrary RPC, config key, source URL or command arguments come from the UI.

CLI subprocesses run on the selected worker with minimal environment, no copied
provider keys/capabilities, a 30-second deadline and a 2-MiB output limit. Raw
source URLs, stderr, native error details, remote images and credential-bearing
configuration are not returned to the browser. Catalog rendering is limited to
200 plugins. Changes reconcile native plugin state, hot-reload configuration and
refresh skills without restarting the worker or Chrome. Both command caches
invalidate safely even when old discovery is still pending. An uncertain/failed
mutation requires a successful refresh before another mutation or agent input;
native/project overrides are reported, not silently claimed as successful.

Ten unit/controller/process checks and three browser checks cover the lifecycle,
policy restrictions, stale revisions, cancellation, recovery, mobile overflow,
draft retention and late replies. `node scripts/smoke-real-plugins.mjs` uses the
installed CLI, a loaded ephemeral native thread and a private local marketplace
to verify install, disable, enable, removal and actual skill discovery without
model inference or host-account changes. This is not remote authenticated
marketplace acceptance or a claim of completed company credential isolation.

### Native app references

The picker always supplies the current native `threadId` to both `app/list`
and `app/installed`; it never treats the unscoped `app/list/updated` notification
as authorization. Discovery is bounded to four 50-entry pages; repeated cursors,
ambiguous duplicate IDs, missing flags and unknown references fail closed.
Availability combines accessibility, enabled state and callable tool policy.
No installation, account sign-in, global config changes, arbitrary native RPC,
remote logo requests or external install links are exposed by the picker.

Selecting an app creates a chat-owned private attachment record containing only
metadata, not account credentials. Sending carries native `UserInput.mention`
with `app://<id>` and the current native app name; app references are never
materialized as files. Existing ordinary uploads cannot forge native-reference
metadata. Draft selection is guarded against late responses, changed chats and
replaced dialogs. Main and side input use their own native thread's callable
policy. Queued references are checked when they actually run; a revoked app
does not reach `turn/start` and the queue pauses with a visible error.

References are bound to the selecting native root, owner and primary company.
Stop/resume retains them only when that identity is unchanged; forked historical
references remain inspectable but require reselection for new input. This does
not establish company isolation for native apps already inherited from a shared
host profile. The host-credential audit remains item 21; do not interpret a
picker label or explicit mention as a new credential boundary.

Seven unit/controller/protocol checks and three desktop/mobile browser checks
cover these paths. `node scripts/smoke-real-apps.mjs` checks the installed CLI's
scoped APIs using a private unauthenticated profile, unknown-app rejection and
zero inference. It does not claim to verify authenticated connector invocation.

### Explicit workspace context

The browser supplies context from Relay's own read-only workspace viewer; it
does not claim an external VS Code/Cursor connection. `/mention [path]` and
`@path` search the actual chat worker, not the controller's filesystem. The
composer waits for capture before sending and keeps failed/stale selections in
the draft. Opening files, selecting text and browsing the shared browser never
create agent messages. `/ide` without a task stages context for the next input;
with a task it uses normal queueing. Only the active open file supplies its
selected text; the other open files supply explicit path/snapshot references.

The installed CLI's `UserInput.mention` is for app connectors and silently
ignores arbitrary filesystem paths. The real-CLI smoke caught that behavior;
workspace references instead use the documented `turn/start.additionalContext`
with `kind: untrusted`, plus ordinary attachment path information. The smoke
verifies the model receives the correct workspace path and selected text as
user-level context, without surrounding unselected text or later file edits.
Claude receives the explicit selection as quoted data after the original input,
so native command prefixes remain first. Existing attachment ownership, queue,
Stop/restart and fork-rebinding rules apply to captured context.

The Linux reader uses no-follow directory descriptors, rejects traversal,
symlinks, hardlinks and special files, and detects concurrent file changes.
Text previews/snapshots are bounded to 512 KiB; larger files remain usable as
path-only references. Selections use normalized LF text and UTF-16 offsets,
with complete-character boundaries, 100,000 bytes per range and 200,000 bytes
per message. File versions are rechecked before capture. Search returns at
most 200 entries (30 autocomplete choices), scans at most 10,000 entries for
two seconds, and skips dependency/cache folders during recursion; direct
folder browsing remains available. The viewer caches at most eight files per
chat and eight chats. Unsent viewer state is browser-local; captured attachment
records and queued/sent metadata use private controller storage.

Connecting acquires the chat workspace without starting an LLM turn. Viewer
leases expire if the tab disappears; remote heartbeats keep an explicitly open
viewer alive, and manual Stop cannot be undone by a presence heartbeat.
`node scripts/smoke-real-workspace-context.mjs` uses the installed CLI and
loopback-only model responses, without live chat, account or browser changes.

### Native agent navigation boundaries

The picker verifies native parent-thread ancestry to this Relay chat before it
lists, reads, resumes, replies to or approves a child. `sessionId`, shared native
homes, workspace paths and `forkedFromId` do not establish membership. Both the
current `parentThreadId` and the installed CLI's stored
`source.subAgent.thread_spawn.parent_thread_id` are understood. An API caller
must also own the Relay chat and supply its current native root ID for actions.
Reading cached state never wakes a worker. Connecting discovers descendants;
viewing joins a selected native thread without changing its role, goals or cwd.
Discovery joins already-loaded children so their questions/approvals can surface,
but does not awaken unloaded descendants. Main drafts, queued inputs, approvals,
goal and native session ID are not replaced by navigation.

Child input uses `turn/start` when idle or `turn/steer` with the expected native
turn ID while active. A definitive "no active turn to steer" rejection retries
as a fresh turn, covering a completion race without blindly replaying timeouts.
Retry IDs deduplicate delivered inputs within the worker session. Child stop
pauses that child's active goal and interrupts its turn, not the shared process
or parent goal. Running children
and their pending requests hold the worker's idle lease. Slash commands still use
the main command surface; the child composer accepts plain follow-up text.

History pages use native item pagination (20 items per request). The picker is
limited to 200 descendants; per-thread live windows are capped at 60 items /
500,000 characters, individual long items explicitly truncate at 16,000
characters, and public snapshots cap cached transcript text at 1,000,000
characters. Private reasoning is never rendered. Viewed content is saved outside
the worker in the encrypted `native-agents` record kind, without pending approval
capabilities. It can be read after a controller restart and is restored into a
new observer only after fresh native ancestry verification. Deleting the chat
also removes its snapshot. Native stored history remains authoritative for
loading earlier pages; the saved snapshot is explicitly a bounded preview.

`node scripts/smoke-real-agent-threads.mjs` uses the real installed CLI, synthetic
descendant rollout fixtures and a private loopback Responses server. It verifies
nested ancestry, no inference on list/view, native item pages, replies, steering,
interruption and parent survival without account credentials, real delegated
work, or changes to the user's active chat/browser.

### Persistent fork implementation and portability limits

`CodexAdapter.forkSession` now creates a real native fork and captures only its
required history lineage. `codex-session-bundle.mjs` validates thread identity,
UTF-8 records, ancestry, and exact native byte boundaries; later source messages
cannot enter the fork. It supports compressed rollouts and worker-side read/import
without copying auth files, settings, plugins, or an entire native home directory.
Imports are private, non-overwriting and retryable. The real-CLI
`node scripts/smoke-real-side.mjs --persistent` check resumes a nested fork in a
fresh profile even after the fixture's source profiles are removed.

`workspace-snapshot.mjs` now supplies a bounded streaming copy of the actual
worker workspace (local or EC2 executor), including the Git index, uncommitted,
untracked and ignored files. It creates independent files, rebases internal
absolute symlinks, and refuses external links, Git worktree redirects/includes,
linked worktrees, alternate object stores and special files. Linux directory
descriptor traversal prevents symlink swaps from reading another directory.
Changed sources, truncated transfers, cancellation and nonzero worker exits
discard only the copy's new destination. Limits are 8 GiB / 250,000 entries;
dependencies/caches are not silently omitted. This is a checked copy, not an
atomic filesystem snapshot: active writes can require retrying the fork.

The real native smoke also verifies independent workspace edits, native resume
into the new cwd, and explicit restoration of a goal's token budget. Adapter
`requireResume` (also enabled by `nativeForkSessionId`) rejects missing or mismatched
fork history without starting an empty conversation or changing the session ID.

The controller now saves the bundle in its encrypted `native-fork` record kind,
never public chat metadata. It publishes the chat only after copying files and
rebinding attachment records. Retried request IDs return the same fork. Source
Stop cancels preparation and removes partial controller records/workspaces;
the adapter archives its unpublished native forks while its RPC is available.
Committed forks are not archived when the original worker stops. A crash or
lost RPC before the native fork ID is returned can leave a parked native artifact;
it cannot start a turn on its own.

Initialization imports history only once into gateway workers' private profiles.
Host-auth forks reuse their existing native session; no ancestry or credentials
are installed into the global authentication profile. EC2 requires gateway auth.
Native goals are separately restored paused. Reading/compacting a fork and idle
sleep do not activate it; the first non-Plan main input owns continuation. Manual
Stop or goal pause/clear cancels that deferred activation. Historical attachments
receive new worker paths, supplied on the first actual input, not fake messages.

An unstarted source has no native history: its fork starts independently with the
same workspace and any Relay handoff transcript. The exact native “no rollout”
case is also supported only when the source has no messages, goal, or imported
fork identity. Populated/missing native history still fails closed. Switching
agents clears native-only restore and goal state while retaining provenance.

`node scripts/smoke-real-fork.mjs` exercises the real CLI through the controller:
fresh/opened-empty forks make zero model requests; an active source continues;
its fork survives source deletion, receives attached files, continues its native
goal only after explicit input, and resumes after a worker restart. Tests use a
private temporary profile and deterministic loopback responses, not an account.
Remote file operations are covered through an executor fixture; no EC2 instance
was provisioned. Linked Git worktrees, external mounts/links and oversized copies
remain explicit portability limits, not silently omitted workspace content.

The provider documents plugin management endpoints as under development. Do not
blindly ship an arbitrary-RPC bridge or grant access to global host credentials
to simulate those commands. Company/user scope must remain enforced.

Live activation is separate from source verification: the process on port 8787
still has old backend modules until an authorized safe restart.
