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
| `/goal [condition\|clear]` (Claude) | Actual native evaluator loop, status, native clear aliases and active-goal Stop/resume verified in private profiles. Literal commands retain FIFO ordering; evaluation failures are visible and streamed goal steps retain their boundaries. Uses Claude semantics, not fabricated Codex pause/resume/state APIs. Hook policies still apply; live activation pending. |
| `/plan [task]` | Native Plan collaboration/read-only mode; busy requests queue. Claude's native Enter/ExitPlanMode transitions now update the selector and subsequent turns, without overwriting a newer web selection. Unit, browser and installed-CLI checks pass. |
| `/compact` | Native compaction, FIFO while busy, wakes stopped worker. Real Codex/Claude adapters tested with local API fixtures. |
| `/review [--base branch / --commit SHA / instructions]` | Native `review/start`, not an ordinary prompt. Tracks both inner execution and outer completion IDs. Real adapter completion and interruption pass. |
| `/code-review [level] [--fix] [target]` (Claude) | Native bundled review with actual diff/read/findings and explicit file-fix verification. Findings survive Stop/resume; Plan blocks edits. SDK interruption checkpoints the first review for Stop and Send now; flags, targets, FIFO, drafts and remaining queued inputs are retained. GitHub `--comment` and live activation are not covered by this acceptance. |
| `/simplify [target]` (Claude) | Native cleanup instructions reach the CLI; actual diff/read/edit/run preserves behavior. Empty diffs, refused Plan exceptions, Stop, Send now and retained applications verified with authored inference. This is integration acceptance, not a model-review-quality or parallel-reviewer claim. |
| `/loop [interval] prompt` (Claude) | Fixed schedules survive replies and ordinary resume without a readback turn. Dynamic `ScheduleWakeup` retains its pending native worker, reconciles replacement/fire/cancellation and preserves unrelated jobs. Timed effects, Send now, Stop, unavailable rollout and idle release verified. Fixed expiry does not replay; dynamic jobs do not restore after Stop. Installed-version fallback limits are below. |
| `/run`, `/verify` (Claude) | Actual native tools drive an HTTP application that remains available between replies. Native Send now preserves it, including interruption of the first command; Stop terminates it and the same native history resumes. Private-profile native approvals support recipe creation, denial and cancellation; saved recipes reload and run. Native shell-classifier routing, refusals and cancellation are accepted below; remaining workflow/shared-host gates are explicit. |
| `/run-skill-generator`, generated project run skills (Claude) | Native generation creates the driver and recipe through explicit protected-file approval after actual HTTP interaction. Reload/discovery, direct invocation, `/run` reuse and `/verify` all execute against the app. Native background Bash ownership now retains apps launched by any private SDK input, not just those two built-in command names. Denial, Stop, Send now and saved-context resume pass. |
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
| `/init [instructions]` | Repository-instruction creation task with multiline instructions and attachments, retaining the same chat, queue and permission mode. Six controller/unit and three browser cases pass; installed CLI verifies actual AGENTS.md creation, preservation on resume and no writes in Plan. Generated prose still needs repository-owner review; live activation pending. |
| Installed Codex skills | `skills/list` plus structured skill input. No fake terminal entries substituted for skills. |
| Installed Claude commands / plugin aliases | Native prefixes and arguments remain intact. Installed legacy commands and skills with the same basename execute distinct file effects, retain Unicode/multiline FIFO and resume history. Native Plan refusals and private-chat isolation pass. `/reload-skills` refreshes both menu caches; actual plugin reload is covered below. Other advertised commands and account-backed acceptance remain open. |
| `/reload-plugins [--force]` (Claude) | Actual native `reload_plugins` SDK control, verified component counts and sanitized catalog/connector refresh; no inference or fake native input. First-command Stop/retry works without a missing journal. Same live CLI and HTTP app/state survive reload; explicit Stop ends the app. Failed/partial/late results, bounded cancellation, files and shared-host gates are covered. |
| `/deep-research` (Claude) | Native private-SDK workflow orchestration, owner lifetime through the final report, FIFO, Stop/resume and targeted Send now. Actual native phase/dedup/voting execution with authored structured replies is verified; this is not a claim about public-source retrieval or research quality. Running apps remain intact until explicit Stop; account/shared-host/live gates remain. |
| `/batch` (Claude) | Native plan approval/refusal, foreground research, five background worktrees and their separate reports. Actual local edits, tests, CLI effects, FIFO, Send now and Stop/resume are verified with authored inference. Running HTTP apps/PIDs/data survive until explicit Stop. Native launch errors remain visible for agent-driven recovery; Relay does not replay tools. Remote commits/PR publication and account/company/live gates remain unverified. |
| `/config key=value`, `/settings key=value` (Claude) | Native private-profile settings, with verified model/mode readback into Relay and subsequent-turn/Stop persistence. Partial native results remain visible; newer web selections win over late readback. Shared host mutations stay locked on item 21. Attachments are rejected before accepting/queueing the command. |
| `/fewer-permission-prompts` (Claude) | Private native history review, exact project-rule merge and explicit web workspace-trust setup verified, including actual enforcement, denial, retained apps and Stop/resume. Chat actions → Workspace trust requires an exact-path review and separate confirmation. Shared-host profiles and broader/linked trust roots remain locked. |
| `/doctor`, `/checkup` (Claude) | Private diagnostic integration verified: actual native expansion, broken-JSON diagnosis without implicit repair, local memory deduplication, selected skill/plugin cleanup and separate consent for an exact project-local read rule. Changed plugins reload on the same native owner before FIFO; readback, refusal/skip, retained apps and Stop/resume pass. Shared-host profiles remain locked; broader check coverage and installation/account effects remain unverified below. |
| `/autocompact [auto/tokens]` (Claude) | Native current-window inspection, private-profile threshold persistence and reset. Actual automatic summary/compact-boundary and same-session Stop/resume verified; disabled state and native environment precedence retained. Shared host mutation and linked files fail closed; attached input is rejected before sending/queueing. Live activation pending. |
| `/model [id/default]`, `/effort [level/default]`, `/reasoning [level/default]` | Picker without arguments; queued validated settings with arguments. Model changes reset previous effort. Claude also supports explicit Auto effort, native `/effort status`, and its account-default model separately from Relay defaults. Installed-CLI acceptance verifies effort changes inside a retained application session and explicit worker-environment precedence. |
| `/permissions`, `/mode` | Permission picker; `auto`, `edits`, `read-only` apply the existing native policy modes, in FIFO order when queued. |
| `/fast [on/off]`, `/personality [friendly/pragmatic/none]` (Codex) | Catalog-driven, persisted per-chat settings, applied in FIFO order to later turns. Stop/model-change guards, retryable personality picker and draft/attachment protection. Controller/browser checks and actual installed-CLI parameter/resume verification pass; live activation remains pending. |
| `/fast [on/off]` (Claude) | Per-chat private-gateway opt-in, fresh authenticated account checks, structured native status, FIFO and same-session Stop/resume. First opt-in and later toggles preserve a running app. Native Fast/standard requests, credits, API denials, persisted cooldowns, configuration/model interop and managed-policy enforcement verified. No provider key in workers. Host profiles, custom upstreams, native managed-policy limitations and live activation remain gated below. |
| `/usage`, `/status`, `/context` | Existing session/usage inspection. |
| `/diff`, `/mcp`, `/skills`, `/help` | Workspace diff, connection manager, installed-command picker. |
| `/mcp reconnect/enable/disable [server\|all]` (Claude) | Actual native SDK controls with post-action status verification, per-chat native persistence, FIFO, error/Stop recovery and no model call. Bare `/mcp` keeps the saved-connection manager; `/mcp verbose` shows worker-reported status. Private-file preflight and host-profile mutation gates apply; live activation pending. |
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
- Claude acceptance below covers command transport, native local results,
  custom expansion, configuration readback, reload, Fast, goals, native MCP
  actions, bundled `/code-review`, retained applications, shell classification
  and resume, not every command's effect. `/simplify` integration and active
  `/loop` scheduling now have effect-level acceptance below, including dynamic
  wakeups with the installed SDK's limitations. Installed plugin namespaces
  and actual SDK reload are accepted below. Native `/deep-research` orchestration,
  lifetime, report delivery and cancellation are accepted below. `/code-review --comment`, account-backed
  commands and shared
  host-profile writes also need the company-isolation gate in item 21. Do not
  infer support from a catalog entry or treat a native removal notice as a
  working replacement. Use the installed version's capabilities, not commands
  added only in newer documentation.

- The fresh installed **2.1.222** SDK catalog also advertises these entries
  without effect-level evidence in this ledger: `/claude-api`,
  `/agents`, `/color`, `/heapdump`,
  `/workflow-launch-exec`, `/security-review`, `/insights`, `/recap`, `/design`,
  `/design-consent`, `/design-revoke` and `/team-onboarding`. Next classify their
  installed behavior and verify/implement each applicable action, starting with
  the first entries. This is explicit inventory within item 20, not new feature
  requests or an increased queue count. Discovery is not effect acceptance.

- `/doctor` and alias `/checkup` now have private diagnostic/cleanup/permission
  evidence below. Other native doctor check categories remain unverified;
  partial private coverage does not close item 20 or authorize host installation
  changes. Continue this acceptance before starting the next native command.

- `/debug` private capture/reproduction and `/dataviz` resource/tool integration
  are accepted below. `/design-sync` has
  only private unauthenticated refusal acceptance: upload/account authorization
  remains an item-21 gate. `/update-config` private user/project/local settings,
  precedence and retained-owner integration are accepted below. Shared-host
  account/company isolation and live activation remain external gates; they
  are not enabled by these private fixture results.

### Claude private doctor and checkup integration

Installed **2.1.222** expands `/doctor` (alias `/checkup`) as a mutating bundled
prompt, including bare/help invocations. It is not the narrower `claude doctor`
terminal command. Relay now classifies both as private settings prompts before
startup, saved input or queue admission. Arguments and attached reference files
stay literal; free-form text is never parsed as a configuration assignment.

Diagnostic preflight still verifies bounded, regular, unlinked private files
and the owning worker/profile, but does not reject malformed JSON before the
native diagnostic can examine it. This path returns a file-safety attestation,
not guessed settings. Native SDK before/after snapshots retain only model,
permission mode, an error-present flag and an opaque plugin-settings fingerprint.
The fingerprint is used only during reconciliation, never published or persisted;
raw errors/settings never reach the UI. Existing parse errors with unchanged
effective selectors/plugin settings can be reported without an implicit repair
or selector change. New errors or changed unverified settings pause the queue.
Other configuration commands remain strict.
Readback, newer UI choices, owner changes and retained-app lifetime reuse the
existing settings guards. Neither cleanup consent nor a saved rule grants
workspace trust or disables native permissions.

`node scripts/smoke-real-claude-doctor.mjs` uses the actual installed prompt,
SDK, tool engine and questions in a loopback-only namespace with temporary
profiles and authored model replies. Confirmed cases:

- `--broken-user`: **11** replies; malformed user JSON is diagnosed, not repaired.
- `--application`: **13** replies; confirmed local memory deduplication and a
  separately approved exact local read rule take effect; app/PID/data survive.
- `--alias --deny-permissions`: **9** replies; `/checkup` cleanup is allowed,
  permissions stay unchanged, and the attempted read still requires approval.
- `--broken-project --deny-cleanup`: **9** replies; invalid project JSON is
  diagnosed; declining cleanup does not decline separately approved permissions.
- `--skip`: **7** replies; neither unanswered question grants a write.
- `--application --stop-cleanup`: **5** replies; Stop at the cleanup question
  leaves both files untouched, rejects a late answer, keeps other queued input
  paused and terminates only at the explicit Stop. The journal still resumes.

All cases preserve unrelated settings/safety instructions/chat and resume the
same journal after Stop. Completed diagnostics verify actual permission
enforcement; cancellation verifies that no proposed write took place. Nine new
unit/controller/transport checks cover classification, worker-side file safety,
parse-error handling, verified repair readback, FIFO, stale ownership and newer
choices. Two desktop/mobile browser cases keep drafts/files through refusal,
queue both names literally and require distinct, unselected question answers.
Syntax/unit checks pass **581/581**; Claude command browser checks **48/48**.
An intervening full-suite repeat was **580/581**: the Chrome connection fixture
timed out because its username field was not visible. The unchanged isolated
Chrome test then passed **1/1**; its intermittent cause is not established or
claimed fixed by this diagnostic work. A final full run passed **581/581** with
unchanged assertions. Chromium's sandbox was not disabled.
The retained-project `/update-config` regression also passes with **7** authored
replies, preserving model/mode/environment effects and the running application.

#### Skill and plugin cleanup effects

The real `--extensions --application` fixture reproduced a stale native cache:
the plugin's effective local override was `false`, but its skill still executed
in the retained owner. Relay now reloads plugins through that owner's native SDK
only after a verified effective plugin change, before completion/FIFO releases.
The same validated receipt updates the web command/connector catalogs. No
process restart, repeated diagnostic prompt or raw configuration publication is
needed. Refused/unchanged/policy-overridden changes do not trigger a reload.
Failure or partial reload pauses completion; Send now waits for a clean receipt,
and Stop/revocation reject stale publication while retaining existing guards.

The fixture creates actual project/user skills and installs one authored local
marketplace plugin into a disposable private profile. After separate cleanup
consent, the local override defeats the project's plugin enablement, and each
project/user `skillOverrides: off` prevents **model** invocation. Native skills
may still appear for explicit user invocation; the web catalog follows the
actual native catalog rather than hiding them to simulate a fix. A kept skill
still expands; project settings, source files, marketplace metadata, unrelated
environment/permission entries and other-chat catalogs are preserved.

Confirmed real CLI cases, including probes again after Stop/resume:

- `--extensions --application`: **33** authored replies, one native reload;
  disabled skills/plugin cannot execute, and app/PID/data survive until Stop.
- `--extensions --application --alias --deny-cleanup`: **27** replies, no reload;
  all extensions still execute, while separately approved permissions take effect.
- `--extensions --application --stop-cleanup`: **13** replies, no reload;
  pending cleanup is cancelled, files/queued input remain, and extensions still
  execute after the same journal resumes.
- `--extensions --skip`: **23** replies, no reload; unanswered cleanup and
  permission questions leave settings unchanged and every extension executable.
  The extra ordinary-turn probes require eleven separate native query startups:
  the original two-minute aggregate fixture limit expired, while a traced run
  completed all unchanged assertions. Extended one-shot fixtures now allow five
  minutes overall; individual queries retain their forty-second deadline. No
  production timeout or permission setting was changed.

Six added fingerprint/transport tests cover native boolean/version-array settings,
effective policy precedence, unchanged state, failed/partial reloads, no overtaking,
Send now, Stop and revoked capabilities. Syntax/unit **587/587**, focused settings
and session tests **131/131**, existing command browser tests **48/48**. Actual
`smoke-real-claude-plugins.mjs --application` also passes **15** main replies and
**2** titles with the same app, FIFO, explicit disable/enable and Stop/resume.

These fixtures establish selected effects, not autonomous diagnosis quality or
all ten native checks. Installation repair/uninstall/update, MCP cleanup,
checked-in instruction migration, hook/context/history analysis and a native
auto-default grant still lack doctor-specific effect acceptance. Do not alter
the user's installation/account to test them. Shared-host company isolation and
live activation remain separate gates. No live service/profile was changed.

### Claude explicit private workspace-trust consent

**Chat actions → Workspace trust** now provides inspection and a separate,
unchecked confirmation. Opening the dialog does not wake the worker; explicit
inspection may connect it without sending a user turn. The server pins each
five-minute review to the authenticated actor, chat owner/company/environment,
workspace and worker lifecycle. Confirmation rechecks native canonical scope,
private profile, authentication and expiry before attesting consent. Stop,
scope changes, missing reviews and failed/uncertain outcomes require another
inspection, never an automatic retry. Shared-host profiles, unsafe/linked paths
and native trust roots broader than the exact workspace fail closed.

The separate control-only native CLI uses the existing private capability,
starts outside the chat workspace and disables hooks, tools and MCP startup.
It sends only SDK controls, never a prompt or raw trust-latch edit. This avoids
the existing-cwd no-op without moving the chat's native owner. Raw profile
contents/errors are not exposed; an uncertain post-attestation result warns
that trust may already have been saved instead of falsely claiming rollback.
Active turns/background agent work and native schedules block this operation.

The actual installed **2.1.222** fixture now exercises the product's
`nativeWorkspaceTrust` path rather than performing consent directly in the
test. Inspection, missing/foreign confirmation IDs and cancellation grant
nothing. Explicit acceptance persists, with no model request, new conversation
message, session ID replacement, permission-mode change or application restart.
`--application --trust-running` starts untrusted, reviews rules, then grants
explicit trust while the original application is alive: the following real
native command is allowed without another approval on the same owner, HTTP
app, PID and data. Extra arguments and original ask/deny rules still hold.
`--untrusted --application`, `--deny` and ordinary trusted cases also pass;
all use disposable profiles, authored model replies and loopback-only namespaces.

Eight unit/transport/adapter/HTTP tests and five browser tests cover exact scope,
stale/expired/replayed confirmation, late cancellation/revocation, shared host
refusal, untrusted native output, privacy, desktop/mobile, unchanged drafts and
attachments, idle-timeout protection, queued input and the distinction between
closing a dialog and undoing a submitted confirmation. Syntax/unit **572/572**
pass. The broad browser run had **212 passing / 4 failed**, all four traces
showing `ERR_NETWORK_CHANGED` while loading local UI resources. A loopback-only
namespace rerun of all four affected suites plus the five new trust cases is
**36/36 passing**; this is not a claim of a fresh all-green full-suite run.
This completes private-workspace consent for this command; item 20's remaining
command effects, shared-host/company isolation and live activation remain open.

### Earlier private permission-review checkpoint (consent completed above)

`/fewer-permission-prompts` is a native mutating prompt, including its bare/help
forms. It scans native history and writes project permission rules; it is not
a read-only local settings query. Relay now routes the literal prompt and
reference files through private settings reconciliation and blocks shared-host
profiles before startup, accepted history, or queue writes. No free-form
permission/model assignments are inferred from its text.

Installed **2.1.222** reproduced an important distinction: `get_settings` shows
saved project allow rules even when the native engine drops them because the
workspace is not trusted. This also affects pre-existing rules, not just the
newly written entry. Relay was losing the native warning before its logical
turn began. That warning now persists as a bounded, fixed-text chat notice;
raw private profile paths and instructions to edit a trust latch are not
published. No grant, settings write, mode change or consent is inferred from
diagnostic output.

`scripts/smoke-real-claude-permissions.mjs` uses actual native tools, private
profiles, authored history/model replies and loopback-only network namespaces:

- Baseline existing exact rule, a refused non-allowlisted command, actual
  cross-project history scan, project-only merge and the following command's
  real approval reduction, including same-history Stop/resume.
- Additional arguments still require approval; original ask/deny rules remain
  enforced. User/local settings, unrelated env values, original fixture
  histories and another chat remain unchanged.
- `--deny` verifies refused protected-file writes and continued approvals.
- `--untrusted` verifies saved rules do not silently grant trust and the actual
  native warning is visible in chat, including startup.
- `--application` verifies hot-loaded rules on the same native owner, HTTP app,
  PID and data, with the application terminated only by explicit Stop.

Trusted fixtures obtain an actual `set_cwd` `needs_trust` response in a separate
idle native consent session, then simulate an explicit user acceptance pinned
to that exact canonical directory. There is no seeded trust latch, policy
override, permission-mode bypass, inference or automatic acceptance in Relay.
The untrusted fixture declines that setup. Final cases use **16** authored main
replies, or **18** with an existing application; approvals are asserted by
operation, not automatically accepted to make the tests pass.

Five new unit/controller/session cases and two responsive browser cases cover
classification, all shared-host input paths, literal FIFO, startup warning
delivery, non-authoritative diagnostics, queued files and refusal/draft
retention. Syntax/unit suite **564/564**; command browser suite **46/46**.
Native retained-project `/update-config` and retained `/debug` regressions
pass (**7** and **5** authored main replies). Other browser suites were not
rerun for this checkpoint; their older results are not a new full-suite claim.

At that earlier checkpoint, web workspace-trust consent/setup remained open:
a pre-trusted fixture alone did not establish new-workspace support. The
explicit private consent path above now covers it. The SDK's `set_cwd` on the
existing directory is still a no-op, not a trust request; an active chat is
never moved elsewhere to force consent. Shared-host/company isolation and live
activation remain gated. Neither checkpoint closes all of item 20.

### Claude native batch lifetime and report checkpoint

Installed **2.1.222** reproduced two Relay defects: a `/batch` launching reply
terminated its native owner and cancelled all five worktree agents; after
retaining that owner, the first report released the queued user input even
though four more native reports were still pending. Background `Agent` calls
(including the native default when `run_in_background` is omitted) now use
the same bound main-session task lifecycle as `Workflow`/`RunWorkflow`.

Native print mode drains task-notification queries individually; it only
coalesces ordinary prompts. The controller observes notification order and
releases one task after its own report, persisting that report before FIFO
drains. Unrelated notifications do not consume another task's report.
Synchronous `Agent` calls also emit completion telemetry, but consume their
result through the foreground tool call and must not reserve another report.
Foreign/child/unbound/mismatched/denied events cannot retain an ordinary owner.
Zero-token report errors release only their own task and remain visible.
Send now waits for actual task-stop receipts and separately acknowledges each
in-flight report cancellation; it does not replace the native process or
discard other Relay queue entries.

`node scripts/smoke-real-claude-batch.mjs` uses the installed CLI, five real Git
worktrees and actual per-unit Edit/Bash/Node-test/CLI effects. All inference is
authored test data, not delegated implementation or a claim about model work
quality. Fresh profiles, a loopback-only network namespace and a dummy gateway
keep real accounts, personal Chrome, remote Git and live chat data out of scope.
The fixture explicitly prohibits worker commit/push/PR operations; it does
not replace their native implementation or claim account-backed publication.

Variants: `--deny-plan` verifies no worktree writes; `--application` retains an
existing real HTTP app/PID/data; `--send-now` cancels all five held agents and
keeps the same owner/history; `--stop` terminates that owner and resumes the
saved native history; `--report` with either interruption exercises a report
before its first token. `--retry-launch` deliberately requests one nonexistent
native agent type, then an authored coordinator retries that unstarted unit
while preserving the other four. Every variant preserves the main workspace
and an unrelated chat. Successful ordinary/application/recovery runs use
**43/45/46** authored replies; plan refusal uses **6**. Seven new session checks
and desktop/320px browser checks cover partial reports, draft/queue safety and
failure paths. Syntax/unit checks pass **559/559**, command browser checks
**44/44**, and the full browser suite **210/210**. Native deep-research
early-completion/FIFO and report-Send-now app regressions pass (**20** replies
each).

Concurrent native smoke execution reproduced a Git startup race: one
`git worktree add` reads a sibling's `.git/worktrees/.../commondir` before that
sibling finishes creating it. The CLI surfaces `Failed to create worktree` as
an actual failed tool result. This is not silently converted into success:
the authored coordinator may issue a new Agent call for that still-unstarted
unit, bounded to three known pre-launch failures; unrelated errors still fail
the fixture. Four standalone Send-now reruns and three concurrent complete
application runs pass, as does deterministic invalid-type recovery. Git itself
is not patched, no native policies are changed, and Relay never automatically
replays these calls. Real agent reasoning/publication and account/company/live
gates remain separate. Keep item 20 open; no later queue feature is started.

### Claude private debug capture checkpoint

Installed **2.1.222** reproduced `/debug` advertising a nonexistent file:
Relay's scheduler diagnostics used an immutable category filter and redirected
native logs exclusively to stderr. The native debug skill still tried to read
its usual private session file. Successful prompt dispatch was not enough.

Private SDK owners now use unfiltered native stderr, with bounded parsing and
the same scheduling observations. Diagnostics are discarded by default, not
retained as pre-opt-in history, saved as chat messages or supplied to an agent automatically. Explicit
`/debug` creates a worker-owned writer for that native session's private log;
only subsequent actual native diagnostics are recorded. Common credential
patterns are redacted; individual lines are bounded and the file is limited to 2 MiB. Linked
profiles/directories/files, hardlinks, replaced targets and oversized existing
files fail closed. The writer also runs through the owning executor for remote
workers; its environment contains no account/gateway credentials.

The original native prompt and Read tool remain responsible for diagnosis.
Its SDK owner survives the reply so the user can reproduce the problem in the
same process, including when no application was previously running. Existing
HTTP app PID/data remain unchanged. Stop, idle sleep or native process exit
ends capture; a later ordinary resume does not silently opt in again. Explicit
`/debug` can append to the same native history's existing private log. Interrupted
startup cannot submit late input, leak a writer or kill a retained app; first
query cancellation preserves the native checkpoint for Send now. Capture
failures are visible without publishing raw diagnostic text or inventing a
successful result. Shared-host `/debug`, including empty/help inputs, is blocked
before startup, acceptance or queue writes pending the company/profile gate.

`scripts/smoke-real-claude-bundled.mjs --debug` verifies real native file creation,
Read and a following reproduction turn without replacing the SDK process
(**3** authored main replies). `--debug --application` preserves the actual HTTP
app/PID/data (**5** replies); `--debug --resume` verifies the same native history
and actual subsequent capture (**6** replies). Unrelated chats are unchanged.
All use fresh private profiles and loopback-only authored inference, not real
accounts, personal logs or a claim about model diagnostic quality.

Unit/session/controller checks cover scope, redaction, limits, writer lifecycle,
failure/cancellation and FIFO. The browser checks discovery, busy queueing and
draft retention after refusal. Syntax/unit **552/552** and full browser
**208/208** pass. A full unit run exposed an existing test-double
race: input delivery was mistaken for `command_lifecycle: started`; fixture
completions now wait for that event, including a deliberately delayed start.
Native scheduling regressions pass: ordinary resume/timed fire **11** replies,
dynamic waiting cancellation **7**; first-app Send now **8**, and retained local
`/update-config` plus Stop/resume **7**. Remaining commands, company/account gates
and live activation are still open; this checkpoint does not close item 20.

### Claude effective settings merge checkpoint

The project and local variants of `/update-config` reproduced the same stale
picker defect: the native Write succeeded, but a user-file-only readback missed
the changed settings. Settings prompts now query the owning SDK's actual
`get_settings` merge before and after execution. Relay does not reimplement
user/project/local/flag/policy priority or substitute its own policy values.
Only the validated effective model/default mode leave the inspector; raw source
settings, environment, hooks and credentials are never published or persisted.

The reply's native owner stays alive until readback finishes. A retained HTTP
application is not restarted, and failed, malformed, unsupported or cancelled
inspection cannot claim success or publish late values. Even a noninteractive
first settings command waits for successful inspection before advertising a
native session ID. Private-file path checks and native approvals still apply.

The extended `smoke-real-claude-bundled.mjs` uses installed **2.1.222** and
disposable loopback-only profiles, with authored model replies/picker fixtures:

- `--update-config --project` and `--update-config --local`: actual scoped
  Write, native merged model/mode readback, unchanged user file and subsequent
  native model/env effects (**5** main replies each).
- `--update-config --shadowed` and the same with `--project`: higher-priority
  local settings win over a lower-scope write, including the next native model
  and actual environment value (**5** each).
- `--update-config --resume` and `--update-config --local --deny`: saved native
  history, real unchanged settings on denial and subsequent turns (**5** each).
- `--update-config --application --project`, `--application --local`,
  `--application --local --resume` and `--application --deny`: real HTTP app,
  PID and data survive configuration/denial until explicit Stop (**7** each).

Six new unit/session cases cover effective snapshots, private-data filtering,
abort/late responses, one-shot/retained owners, failed first inspection and
failed post-write verification. The protocol fixture explicitly waits for the
native lifecycle-start receipt before emitting its result; an earlier fixture
race was not a native-product failure. Syntax/unit **540/540**, browser **67/67**
and native first-app Send now (**8** authored requests) pass. This closes the
private project/local and retained-owner checks carried from the previous
checkpoint, not item 20's remaining commands or the full feature queue.

### Claude bundled resources and settings skill checkpoint

Installed **2.1.222** reproduced `/update-config` writing Sonnet into its private
settings while Relay retained the old web selection. The unchanged native
prompt now participates in guarded before/after settings inspection and model/
mode reconciliation. Free-form prose, quoted examples and `--help` are not
parsed as confirmed assignments or a read-only native control. Shared-host
mutations are rejected before startup/queueing, including empty/help variants.
Unlike local `/config`, the agent-executed skill can still take reference files.
Native approval/denial, newer web choices, Stop and ownership guards remain in
force; the controller reads only model and mode, not raw hooks/env/credentials.

`node scripts/smoke-real-claude-bundled.mjs` uses real installed prompts,
resource extraction and native tools inside a private loopback-only network/PID
namespace. Model replies, chart data and picker inventory are authored fixtures,
not actual inference or a model-quality claim. It does not override feature
flags, use existing chats/accounts, upload repositories or touch live services.

- Default `/dataviz`: **7** main replies, native reads of the extracted palette
  and validator, actual light/dark validation, nonzero invalid-palette rejection
  and HTML/SVG file creation with exact fixture data.
- `--deny`: **4** replies; native validator denial leaves no chart file.
- `--resume`: **14** replies; same native history, new private resource paths,
  repeated validation/writes and an unchanged second chat.
- `--design-sync`: **3** replies; real resource read and read-only project-list
  attempt yield the native missing-authorization error. No project list or
  upload is fabricated, and no design consent is granted. This does not supply
  the still-needed company-scoped authenticated Design connection.
- `--update-config`, `--update-config --deny`, and
  `--update-config --resume`: **5** replies each. Actual native Write success or
  denial, saved model/default mode, preserved fixture env, next-turn native
  model and real Bash env values, persisted Relay state and Stop/resume pass.
  The harmless two-variable inspection has a narrowly preconfigured private
  allow rule; this is not another permission-classifier acceptance test.

Four unit/controller additions cover prompt classification, shared-host guards,
FIFO, newer selections and late-publication protection. Two responsive browser
cases cover literal discovery/submission, attachments, failed-save retry,
queueing, updated selectors and visible authorization guidance. Syntax/unit
**534/534** and browser **67/67** pass. At this checkpoint, project/local
configuration precedence and retained-owner reload remained open; the effective
settings checkpoint above closes those private integration checks. Remaining
commands and account/company/live activation gates are still open.

### Claude native research workflow checkpoint

Installed **2.1.222** reproduced `/deep-research` being killed immediately after
its launching reply: Relay closed the native process while its real Workflow
task was still running. Bound main-session `local_workflow` task events now
retain that private SDK owner and keep the chat busy. Foreign, child, quoted,
denied, malformed and unbound task events cannot retain it.

Computation completion is not report completion. Native task-notification
queries do not emit `command_lifecycle`; their actual result closes the report.
This also handles research that finishes before the launching reply, overlapping
completion notifications, non-streamed errors and cancellation before the first
summary token. The final report is persisted before FIFO input is released.
Send now uses the native `stop_task` control and verifies its terminal receipt,
then interrupts an in-flight summary when needed. Failure/timeout stays visible;
intentional summary cancellation is a notice, not a fabricated execution error.
Explicit Stop still shuts down the owner; native history resumes normally.

`node scripts/smoke-real-claude-research.mjs` runs the installed Workflow engine
against authored model/StructuredOutput replies in a fresh loopback-only
network/PID namespace. Three fixture search angles produce six references to two
sources; the native pipeline deduplicates them, extracts two fixture claims,
coordinates six verification votes, and synthesizes one confirmed finding while
retaining one refuted claim. Its actual result reaches the native final report.
These are invented fixture sources: no real web retrieval, paid inference or
model-quality claim is made.

- Default completion and history resume: **17** authored model replies.
- `--interrupt` and `--send-now`: **4** replies each, retained unrelated queue.
- `--report --send-now`: **17** replies, cancellation before any summary token.
- `--early --drain`: **18** replies; the early finish still waits for its report.
- `--drain --application`, `--early --drain --application` and
  `--report --send-now --application`: **20** replies each; actual HTTP PID/data
  remain unchanged until explicit Stop, and subsequent native history resumes.

Nine session/controller tests cover receipt binding, failures, completion races,
report ordering and cancellation. Syntax/unit **530/530** and browser **65/65**
pass; the two new responsive browser cases cover literal command submission,
running state, cancellation retry, links and draft/file preservation. Native
first-app Send now (**8** requests), dynamic-loop cancellation (**7** main
replies) and retained plugin/app (**15** main replies) regressions pass.
No live service, real account, personal profile or existing chat was changed.
Item 20 and the overall queue remain open.

Installed-source classification for the next entries: `/design-sync` uploads a
React design bundle to `claude.ai/design`; it and Design consent/revocation need
explicit account/company scope, not a real-account test by default. `/agents`
currently returns a removal notice. `/heapdump` is a hidden heap diagnostic;
`/workflow-launch-exec` is a hidden server-launch handoff, not an ordinary user
workflow. These classifications do not count as implemented web replacements.

### Claude installed plugin namespaces and SDK reload checkpoint

Installed **2.1.222** returned successful local-command transport with
`/reload-plugins isn't available in this environment.` Its SDK command catalog
omits that terminal callback. Relay now exposes the implemented action and
uses the actual `reload_plugins` control on the owning private session. Native
component counts and validated command/connector metadata update immediately;
plugin paths, source credentials and MCP configuration are not copied into
the response. Composing the remote menu no longer mutates its saved native
inventory with web/SDK entries.

A first control-only reload creates no journal: the initialized CLI accepts
the next real input without publishing a premature resume ID. Stop/retry does
not resume missing history. Send now waits for the bounded native receipt,
rejects unverified completion and ignores late publication. Invalid snapshots
and partial load errors cannot claim success. Argument/attachment/shared-host
checks run before accepting or queueing, and local reload does not perform a
paid-feature account lookup when Fast is enabled.

`node scripts/smoke-real-claude-plugins.mjs` installs two newly authored local
plugins using the actual CLI, one legacy command and one skill with the same
basename `stamp`, while the native owner is alive. SDK reload makes both
namespaces execute actual Write effects with exact multiline/Unicode arguments.
FIFO and same-journal Stop/resume pass. Native disable/enable plus reload
changes the menu; re-enabled commands execute on that same owner. Another
private chat has neither the plugins nor their messages.

- Default: **13** authored main replies and **1** title.
- `--plan`: **13** main replies and **1** title; native Write exceptions are
  explicitly declined and every target file remains absent.
- `--application`: **15** main replies and **2** titles; the same HTTP process
  and state survive installation/reload/queued work. Stop closes its endpoint;
  later plugin commands do not restart it.

Twelve unit/controller additions and two responsive browser cases cover
namespace/alias separation, the reload menu entry, exact queued arguments and
attachment IDs, native reply validation, private-field stripping, first-use
lifecycle, partial/failing controls, cancellation, expiry and preflight guards.
Syntax/unit **521/521**; browser **63/63**. Native first-app Send-now (**8**
requests), dynamic cancellation (**7** main replies) and retained MCP/app
(**9** main replies) regressions pass.

Native tests use disposable profiles/local marketplaces, dummy controller keys,
authored inference and loopback-only network/PID namespaces. No real account,
external plugin, personal configuration or live service was changed. The
installed control and actual effects provide acceptance; the official
[marketplace reference](https://code.claude.com/docs/en/plugin-marketplaces)
describes the packaging format. Other advertised native commands and existing
company/account/live gates keep item 20 open.

### Claude dynamic scheduling checkpoint

Installed Claude **2.1.222** reproduced another lifetime failure: a successful
`ScheduleWakeup` result was followed by Relay killing the native worker before
its first scheduler poll. Bound main-session structured results now retain the
process immediately, without waiting for an ID that this native tool does not
return. Filtered native diagnostics or `CronList` can associate a unique new ID;
existing fixed/restored jobs are excluded and ambiguous identities are never
guessed. Replacement tolerates independent stdout/stderr ordering. Native
fire, explicit cancellation, empty snapshots and Stop release pending state;
a denied or unavailable reschedule cannot erase an existing native job.

The real installed-CLI fixture (`scripts/smoke-real-claude-loop.mjs`) uses
`--dynamic`, with optional variants:

- Default: actual counter writes 1 then 2 on a native timed fire, explicit
  loop completion, idle sleep and history resume (**8** authored main replies).
- `--cancel-waiting`: cancel after the scheduler has observed its real ID;
  no second counter write, idle release and resume (**7** replies).
- `--send-now`: interrupt an actual scheduled inference call, send the selected
  cancellation and preserve the other queued input/counter (**8** replies).
- `--stop`: explicit worker termination; the resumed native `CronList` is empty
  and the initial counter is not replayed (**5** replies).
- `--unavailable`: a native zero/unavailable result does not retain a worker or
  invent a timer; no dynamic job appears on resume (**5** replies).
- `--replace-wakeup`: replace the first pending wakeup with a later one and
  observe only the expected next counter write (**9** replies).
- `--mixed --cancel-waiting`: cancelling a dynamic loop retains an unrelated
  ordinary cron job and idle protection until explicit native deletion
  (**12** replies).
- `--no-rearm`: complete a real tick without scheduling another. The same
  live SDK process reports no remaining jobs through native `CronList`, then
  releases idle sleep and resumes history without recreating jobs (**9** replies).

Dynamic availability is tested using a synthetic rollout cache in a newly
created disposable native profile; unavailable cases leave that cache absent.
This is not a real-account entitlement claim or a production override.
The installed SDK path does not arm the optional terminal keepalive fallback,
even when its rollout flag is present in the disposable profile. Relay does not
invent a replacement timer or claim terminal/SDK parity. Dynamic jobs are not
restored from history, unlike this version's ordinary fixed schedules.

Six session tests cover bound results, replacement ordering, ordinary/restored
job preservation, fire/snapshots/Stop, ambiguous IDs and failed/foreign/child/
quoted/unbound/zero/malformed/late events. Syntax/unit **509/509** and browser
**61/61** pass. Ordinary-resume (**11** main replies), final-expiry (**5**) and
first-app Send-now (**8** requests) native regressions pass. All native tests
use authored inference, private profiles and loopback-only network/PID
namespaces, not real model calls, personal accounts or live chat state.
Item 20 remains active for installed plugin namespaces and the existing
shared-host/company/account/live gates; queue order/count are unchanged.

### Claude simplification and fixed native scheduling checkpoint

Follow-up: an ordinary native resume previously restored its job, then Relay
killed that worker at the end of the reply because no `CronList` had run.
This is now reproduced and fixed with installed Claude **2.1.222**. The native
SDK has no scheduled-task snapshot/change control in this version, so the
private owned process emits only filtered scheduling/resume diagnostics to
stderr. A bounded reader consumes exact native restoration, scheduled, fire
and expiry records; it never stores debug logs/messages, parses a saved
conversation or generates a synthetic input/model call. Native tools remain
authoritative for creation/list/deletion. The observation only controls worker
lifetime; it cannot create jobs, fire prompts or grant tool permission.

New disposable installed-CLI cases:

- `--resume-plain`: Stop, ordinary conversation resume with no tools, actual
  timed counter write, cancellation and a further history resume (**11** main
  replies). Native restored jobs protect the same worker from idle shutdown.
- `--one-shot`: actual timed counter write and visible reply, followed by idle
  sleep without listing/deleting jobs or replaying the write (**5** replies).
- `--expired-fire`: age only the newly created disposable durable job. The real
  native watcher/scheduler performs its final fire, deletes the job and releases
  idle sleep (**5** replies). No runtime clock or expiry-policy override.
- `--expired-resume`, also with `--one-shot`: age the disposable native create
  record after Stop. Native restoration excludes expired recurring/overdue
  one-shot jobs; an ordinary response closes normally without replaying the
  counter (**4/4** replies).

Five new session tests cover startup/chunking, ID reconciliation, automatic
removal, empty readback/deletion before the first poll, duplicate/malformed/
quoted/oversized records and late events after cancellation. Syntax/unit:
**503/503**; browser **61/61**. Native scheduled Send-now (**9** main replies)
and first-app Send-now (**8** requests) regressions also pass.
These checks use authored loopback inference and private namespaces, not live
accounts, real model inference or production chat data. The diagnostic format
is an installed-version integration contract, not an invented SDK endpoint.
Dynamic scheduling is covered in the newer checkpoint above; installed plugin
namespaces remain the next item-20 work.

Two native scheduling defects reproduced with installed Claude **2.1.222**:
the scheduler exited with code 143 immediately after confirming a new job;
after retention was fixed, a real scheduled turn still appeared idle and could
not be interrupted with Send now. Both paths are now fixed.

Structured `CronCreate`/`CronList`/`CronDelete` results bound to a known
main-session call establish tool-driven changes. Failed, quoted, child,
foreign, missing and late results cannot retain the CLI or suppress sleep.
Confirmed schedules retain their existing SDK owner and pause idle shutdown;
verified deletion releases idle protection. Native command lifecycle events
mark automatic turns as working without inventing user messages. Send now
waits for that turn's cancellation receipt and retains the process, schedules
and other queued inputs. Explicit Stop still terminates the worker.

`node scripts/smoke-real-claude-loop.mjs` uses the real scheduler, tools and
elapsed clock, a private profile, a loopback-only network/PID namespace and
authored model replies. It creates a one-minute schedule, observes actual
counter writes 1 then 2, displays the background reply, lists/deletes the job
and resumes saved history: **10** main replies. `--send-now` holds the actual
timed inference call, interrupts it, sends only the selected cancellation,
checks the untouched counter/other queued input, then resumes: **9** replies.
`--stop` terminates the worker while a job exists, resumes its native history,
uses real `CronList` to observe that same job and explicitly deletes it:
**7** replies, no replay of the counter write.

Important: despite its tool result saying “session-only,” this installed
version restores the schedule from native history on resume. Stop is not a
claim that the job was deleted. This matches the current
[scheduled-task documentation](https://code.claude.com/docs/en/scheduled-tasks).
Retention uses observed native scheduling state, not a new controller
scheduler. Ordinary resume and one-shot completion/expiry are covered in the
follow-up above. The fixed-interval path alone does not establish dynamic-loop
acceptance; the separate dynamic checkpoint above records those effects and
installed-SDK limitations.

`node scripts/smoke-real-claude-workflows.mjs --simplify` checks native target
and cleanup instructions plus actual diff/read/edit/CLI effects, with identical
results before/after cleanup: **6** main replies including resume. `--plan`
refuses the native edit exception and checks the unchanged file (**5**);
`--empty` keeps already-clean code unchanged (**4**); `--interrupt` and
`--send-now` preserve first-command history and the other queue entry (**3**
each). `--application --plan` and `--application --send-now` preserve the same
real HTTP app/data until explicit Stop (**8/6** main replies, one title each).
These are fixed inference replies, not an evaluation of review quality or a
claim that four review agents were executed.

Seven session/controller additions and two responsive browser cases cover
state binding, idle protection, interruption, drafts and files. Syntax/unit:
**498/498**. Combined Claude-command/conversation browser suite: **61/61**.
Native first-run Send now and code-review fix regressions: **8/7** replies.
Fixture corrections were separate: Plan requires refusing its SDK exception;
new protocol tests wait for native `started`, not merely input-write time;
trace output is bounded and namespace timeouts use SIGKILL. No real inference,
live deployment, account mutation or live-chat edits. Item 20 remains active.

### Claude native approvals and questions

Private gateway profiles now launch the installed Claude with a live SDK
permission channel (`--permission-prompt-tool stdio`). Both ordinary turns and
retained application sessions route native `can_use_tool` requests to the
owning chat's approval card. This replaces the previous unconditional
print-mode denial for protected `.claude/skills` writes; it does not bypass
native permission rules, managed policy or account restrictions.

The implementation follows the native
[permission callback](https://code.claude.com/docs/en/agent-sdk/permissions) and
[user-input contract](https://code.claude.com/docs/en/agent-sdk/user-input):

- Approve once returns the original controller-held tool arguments. The
  browser sends only an opaque live request ID and a decision; it cannot
  replace the command, file contents or native permission suggestions.
- Deny sends a native denial. Session-wide grants are not offered or accepted;
  no permission rules are persisted. Shared host-profile callbacks remain
  disabled pending the company/profile isolation audit.
- Simultaneous requests appear in order. Canceled, foreign, resolved and
  already-submitting IDs cannot grant another action. Stop/Send now invalidate
  outstanding requests; late requests during interruption are denied. An
  ambiguous transport write is never automatically repeated.
- Native `AskUserQuestion` supports single or multiple choices, literal text
  and skipping. Answers map only to the exact native question text. Skipping
  denies the tool with an explicit instruction not to invent answers.
- Unsupported native dialogs and malformed questions fail closed. Native
  rich option previews, persistent approval choices and shared-host replies
  are not claimed as supported. Shell permission classification and native
  `ExitPlanMode` state reconciliation are verified separately below.

`node scripts/smoke-real-claude-run.mjs --approve-recipe --questions` uses the
actual installed **2.1.222** CLI, controller and gateway in disposable
loopback-only network/PID namespaces. Its real Write tool creates the exact
verification recipe **only after** the controller's explicit once-approval,
then reloads/reuses it. After Stop, an ordinary resumed turn asks two real
native questions and receives multiple selections plus multiline Unicode
text: **13** local model requests. No fixture-side recipe write occurs in this
variant. The default denial variant still verifies the file stays absent,
then separately installs a supplied fixture recipe for reuse: **12** requests.

`--stop-approval --skip-questions` cancels a pending native Write, rejects its
old ID, retains queued input and keeps the file absent through same-session
resume. The resumed native question is explicitly skipped, without fabricated
answers: **10** requests. Existing Send now acceptance remains **10** requests.
These are authored local model responses, not real inference or live accounts.

Seven request/controller tests cover argument binding, private redaction,
FIFO, cancellation, stale/cross-chat IDs, ambiguous writes and question payloads.
Two adapter tests cover ordinary-turn transport cleanup and Stop during SDK
initialization. Four desktop/320px browser additions cover literal content,
native-only decisions, transport retry, old-response/new-request ordering,
multiple selections, keyboard focus, skipping and unsent drafts/files. The
browser run reproduced and fixed approval cards overflowing on long paths;
their contents now wrap without truncating the action being approved. Manual
mode copy now accurately distinguishes private profiles from shared hosts.

Approval checkpoint: normal syntax/unit suite **458/458**; combined
Claude-command/conversation browser suite **53/53**. Native command, MCP, review-fix, goal and Fast
regressions pass. Generated run recipes are accepted below. Item 20 remains
active for other bundled workflows/plugin namespaces, retained-session gates and live
activation remain separate gates. No deployment, merge, real approval,
personal Chrome/profile or company credential changes.

### Claude native shell permission classification

`node scripts/smoke-real-claude-shell.mjs` exercises installed Claude **2.1.222**
through the actual Relay controller, private gateway and native Bash tool.
The only saved allow rule starts a disposable HTTP application. The tested
marker command is not preapproved: only the native tool can append its file.
Each variant checks the actual command result, file contents or absence,
unchanged HTTP app PID/data, original native session and explicit Stop/resume.

These are **authored loopback model/classifier responses**, not real inference
or an evaluation of the classifier's judgment. The fixture recognizes the
installed security-monitor contract, binds it to the exact disposable command
and tests both verdicts through the native parser and permission machinery.
It does not grant Relay-wide shell access, modify native policy, use a real
account or change live chat data. Network/PID namespaces contain only loopback;
the profile/workspace are temporary and removed at completion.

| Variant | Verified behavior | Main / classifier requests |
| --- | --- | --- |
| Default Manual; `--mode=accept_edits` | Explicit once-approval executes the original arguments despite a forged replacement; repeating the same command asks again and denial leaves the marker unchanged | 7 / 0 each |
| `--mode=dont_ask` | Native denial without a user prompt or marker write | 5 / 0 |
| Auto or Plan, `--classifier=allow` | Native first-stage allow executes exactly once, without a user prompt | 5 / 1 each |
| Auto or Plan, `--classifier=review` | First-stage refusal reaches the second stage; its allow executes exactly once | 5 / 2 each |
| Auto or Plan, `--classifier=block` | Both classifier stages refuse; no command execution or approval callback | 5 / 2 each |
| Auto or Plan, `--classifier=invalid` | Malformed verdicts exhaust the installed four retries per stage and fail closed | 5 / 10 each |
| Auto or Plan, `--classifier=error` | The classifier and native fallback model both return 403; no write or user prompt | 5 / 2 each |
| Manual, `--stop` or `--send-now` | Cancel the pending approval; reject its old ID; retain unrelated queued input; Send now finishes the selected input and an additional probe | 4 / 0 and 6 / 0 |
| Auto or Plan, `--classifier=allow --stop` | Stop while classification is pending; its late allow cannot execute | 4 / 1 each |
| Auto or Plan, `--classifier=allow --send-now` | Interrupt without replacing the app; drain the late allow and finish the selected input plus another native turn before checking no write/replay | 6 / 1 each |

Use `--mode=auto` or `--mode=plan` for classifier variants; Plan defaults to the
block fixture, Auto to allow. `--trace` reports request kind/model without any
credentials. Native title calls are counted separately. Every variant retains
the selected mode and checks the settings file gained no persistent allow rule.
The optional command-prefix extraction path is not exercised by these commands
and is not counted as acceptance of prefix suggestions or persistent grants.

The observed Plan classifier path matches the documented
[permission modes](https://code.claude.com/docs/en/permissions): Plan can use
classifier-approved commands when native Auto support is available. Therefore
the fixture must not assume every Bash call in Plan opens a manual prompt.
No native policy was changed to make these tests pass.

Fixture corrections, not product fixes: recognize the security-monitor request
separately from main/title queries, model its actual two-stage verdict contract,
allow its installed ten-response malformed-output retry budget, and wait for
the selected Send now input's actual completion rather than only submission. This
checkpoint adds acceptance coverage; it does not claim a new runtime fix or
close the separate reported Codex/local-IPC Auto-mode case (queue item 27).
Bundled workflows, installed plugin namespaces, shared-host/company/account
checks and live activation remain open under item 20.

All **19** native variants pass (**99** main and **38** classifier requests,
with titles counted separately). Syntax/unit suite: **487/487**; combined
Claude-command/conversation browser suite: **59/59**. The fixture and this
acceptance record are the only changes in this checkpoint.

### Claude generated run recipes and native background ownership

Reproduced with installed Claude **2.1.222**: `/run-skill-generator` successfully
created a real driver and skill, but invoking that new `/run-fixture` directly
ended its running HTTP app at the end of the reply (`ECONNREFUSED`). Relay kept
the owner CLI alive only for the literal `/run` and `/verify` commands.

A private SDK turn now becomes a retained application session when Claude
reports a native `task_started` for its live main-session Bash call. This also
works for ordinary requests to start the app. The event must match the current
session and tool ID, have type `local_bash`, and arrive before interruption.
Quoted metadata, child/foreign/unknown tasks, completed calls and missing IDs
cannot retain a process. No permission decision is inferred from this event.
Ordinary replies without such a task still close their temporary transport;
retained apps continue to use the existing explicit Stop and idle cleanup.

`node scripts/smoke-real-claude-recipes.mjs` uses actual native prompt/skill
expansion, Read/Write/Bash/Skill/TaskStop tools, a controller-owned gateway and
HTTP application in disposable loopback-only network/PID namespaces:

- Default: inspect the app manifest/source; launch it; write the driver only
  after once-approval; drive actual HTTP creation (201), validation (400) and
  retrieval; stop that test app; write the verified skill after a separate
  approval. No fixture-side driver/recipe creation occurs. Explicit Stop then
  reload/discovery precede a fresh direct skill invocation. `/run` loads the
  generated skill with the native Skill tool; `/verify` reads the saved recipe
  and executes its driver. The same PID/data survive all replies. Final Stop
  closes the app and resumes the original native context: **18** main requests.
- `--plain-run`: the same workflow starts its retained app from ordinary user
  text instead of a direct slash invocation: **18** main requests.
- `--deny`: refusal leaves both driver and recipe absent and stops the test
  app; saved-context resume does not replay writes: **7** main requests.
- `--stop`: cancel while the first protected write awaits approval, preserve
  unrelated queue input, reject the old approval ID, close the app and resume
  without creating either file: **5** main requests.
- `--send-now`: cancel that write, actually complete the selected follow-up
  while the original app/PID/data survive, preserve the other queue entry,
  reject stale approval, then Stop/resume without writes: **6** main requests.

These are authored loopback model replies, not real inference or an evaluation
of generated prose quality. Native titles are separate from the counts above.
Saved files, permissions, actual HTTP effects and session IDs are asserted.
The fixture waits for actual app readiness and identifies the last user input
without confusing Claude's appended system/tool catalog with the command.
Those fixture corrections are distinct from the reproduced lifetime fix.

Four new adapter/session tests cover promotion, exact input/settings/session
reuse, Stop revocation and invalid/stale/child/quoted events. Syntax/unit suite
**491/491**; combined Claude-command/conversation browser suite **59/59**.
Existing native regressions pass: first-run Send now (**8** replies), approved
recipe/questions (**13**), shell-classifier Send now (**6** main, **1** classifier
and **3** titles), and review-fix (**7** main replies).
This closes the private-profile generator/direct-run gate, not
`/simplify`, `/loop`, plugin namespaces, shared-host/company/account checks or
live activation. No real profiles/accounts, services or chat data are changed.

### Claude native Plan-mode transitions

Installed Claude **2.1.222** reproduced a stale web selector: its actual
`EnterPlanMode` tool entered Plan while Relay still showed Edits. Ignoring the
reverse transition could also put the next turn back into Plan after an
explicitly approved native `ExitPlanMode` restored the previous mode.

Relay now reconciles the main native session's structured
`system/status.permissionMode` events. Tool names, assistant prose, child
events, foreign session IDs and unknown mode values never change the selector.
This observes native state; it does not approve a tool, grant persistent
permissions or bypass native policy. Clicking Approve once does not
optimistically change the mode before the native CLI confirms its transition.

The observer covers foreground replies and retained-session background events.
Updates are scoped to the owning chat/profile and current turn generation;
Stop and later turns invalidate old observers. Duplicate status events do not
rewrite the chat. Native changes and `/config` readback share the same ordered
event queue so one native update is not mistaken for a newer web selection.
An actual newer web choice, including selecting Plan again, wins for the next
turn and produces one explanatory notice. Synchronization errors stop the
runtime through its existing fatal handler, without exposing private errors or
leaving an unhandled rejection. Saved mode survives Stop and controller reload.

`node scripts/smoke-real-claude-run.mjs` adds four disposable loopback variants:

- `--plan-workflow`: real EnterPlanMode, denied Write while planning, explicit
  ExitPlanMode approval, actual implementation-file creation and a subsequent
  edit using the restored mode: **14** local model requests.
- `--plan-reject`: denied plan exit creates no implementation file and leaves
  the following turn in Plan: **13** requests.
- `--plan-stop`: Stop while plan approval is pending invalidates the old
  request, writes no implementation and resumes the same native history in
  Plan: **9** requests.
- `--plan-web-choice`: reselecting Plan before approval preserves that newer
  choice for the following turn, even though the explicitly approved current
  plan executes: **14** requests.

All variants use the actual CLI/tools and retain the disposable HTTP app/data
until Stop. Model replies are authored locally; no real inference, personal
accounts or live chats are involved. These prove native Plan transitions and
file-permission effects, not the separate shell classifier contract.

Seven new unit/controller/adapter cases and two desktop/320px browser cases
cover the above guards, settings ordering, failure handling and unsent
draft/files. Plan checkpoint syntax/unit suite: **465/465**; combined Claude-command
and conversation browser suite: **55/55**. Installed native settings and
approval/question regressions also pass (**3** and **13** local replies).
Item 20 remains active; the remaining application-session gates below and
other bundled workflows/plugin namespaces are not marked complete. No merge,
deployment, live approval or shared-host/company credential changes.

### Claude effort in retained application sessions

The installed **2.1.222** CLI reproduced a real mismatch: after launching in
Auto, `/effort high` updated Relay but the subsequent native API request still
omitted High. Relay had set `CLAUDE_CODE_EFFORT_LEVEL=auto` in the process
environment, which continued to override later SDK effort changes.

SDK sessions now reset Auto with native `apply_flag_settings` and
`effortLevel:null` before the first input, instead of pinning the environment.
Later explicit choices and Auto use the same native control. Auto follows the
native model default, not the previous Low/High selection or a rewritten
profile default. Ordinary private SDK turns use this reset too. A failed or
interrupted first initialization/reset publishes no unusable resume ID; an
explicit retry starts a fresh native session without replaying the failed input.

An explicit worker effort environment remains untouched, following native
[effort precedence](https://code.claude.com/docs/en/model-config#adjust-effort-level).
A once-per-runtime notice identifies the override and points to `/effort status`
without dumping environment values. If that startup environment changes while
an application session is retained, Relay refuses input before changing native
controls and explains that explicit Stop/retry is required. The running app is
not silently killed. Ordinary effort-picker changes need no restart.

Two `smoke-real-claude-run.mjs` variants use actual native tools, gateway requests
and a retained HTTP app/data in disposable loopback/PID namespaces:

- `--effort-settings`: a saved Low profile starts in Auto; seven High/Low/Auto/
  Medium selections are checked against actual request effort, without model
  inference for the settings commands or replacement of the owning CLI. The
  saved profile remains Low, and Stop/resume retains the last choice: **19**
  local requests, including native title generation.
- `--effort-environment`: an explicit Medium worker override remains effective
  across the same web choices. Its notice appears once, native `/effort status`
  reports Medium without inference, and changing the startup value rejects
  input while the same HTTP app stays available. Explicit Stop/resume applies
  the new High environment in the same saved conversation: **19** requests.

Four new adapter cases cover controls, ordinary turns, unchanged environments,
startup failure/cancellation and fresh retry. Two desktop/320px browser cases
exercise actual picker interactions, visible override/error messages and
retained drafts/files without automatic Stop or submission. Syntax/unit suite:
**469/469**; combined Claude-command/conversation browser suite: **57/57**.
Native settings, approval/questions and Plan regressions pass (**3/13/14**
local replies), as do first-command Send now (**8**) and native Fast/settings
interop (**3**). Model responses are authored locally; no real inference or
personal accounts were used.

Fixture corrections are separate from the product fix: count only actual CLI
launches, distinguish title calls from task calls, and allow the full settings
matrix 120 seconds rather than canceling its final command at 60 seconds after
healthy six-second CLI replies. `--trace` now makes that overall timeout explicit;
the command/effect assertions are unchanged. Item 20 stays active; long-lived
capabilities and other retained-session interop are accepted below, and shell
classification above. Remaining bundled workflows are still open. No merge,
deployment or live data changes.

### Claude long-lived gateway access

Reproduced: a retained `/run` process remained alive after the one-hour
capability expired, but its next input failed before provider observation.
Private Claude runtimes now use a controller-renewed lease, with its existing
TTL and an unreferenced renewal timer at one third of that TTL. Validation and
renewal both check the original owner/company/profile/workspace, provider key,
authentication mode and upstream. A changed scope fails closed immediately on
the next gateway request; restoring the old scope cannot resurrect its token.
No renewal route or real provider credential is exposed to the worker.

Stop revokes before persistence/process shutdown waits, clears renewal and
observers, and does not allow a late adapter shutdown to revoke a replacement
token. Ordinary fixed-expiry capabilities and separate MCP/Chrome grants are
unchanged. A missed deadline (such as controller suspension beyond the TTL)
still expires: input/approval is rejected with an explicit Stop/retry message,
not a silent app restart or replay. Expiry during SDK configuration releases
the unsubmitted logical turn without killing its owning application process.

`node scripts/smoke-real-claude-run.mjs --capability-lifetime` uses installed
Claude, the actual Relay gateway and real HTTP application in disposable
loopback/PID namespaces. A ten-second TTL exercises **two real elapsed lease
lifetimes**, retaining one native CLI, session ID and HTTP app/data. A separate
fixed-expiry control token expires normally. Native follow-ups still reach the
provider; a changed dummy account and Stop return 401 without upstream traffic.
Explicit Stop/resume uses a new capability and the same saved context, with
**9** authored loopback model replies and no real inference or accounts.

Seven new broker/adapter/controller tests cover renewal, missed deadlines,
scope errors, revocation, provider/turn observers, native-control cancellation
and slow Stop. Two desktop/320px browser cases verify the visible error,
explicit Stop and retained unsent text/files without automatic submission.
The scope-change test covers nine account/profile/workspace/owner/company
variants. Syntax/unit suite: **476/476**; combined Claude-command/conversation
browser suite: **59/59**. Native regressions pass for first-run Send now (**8**
replies), first-review Stop/resume (**3**), and explicit recipe approvals plus
questions (**13**). MCP/review and retained-session Fast interop are accepted
below, and shell classification above. Other workflow gates remain open;
this is not blanket acceptance of every command or a deployment.

### Claude MCP and review inside a running application

The retained-session MCP fixture reproduced a real disconnect between native
status and effective tools in **2.1.222**: after `/mcp reconnect relay_http`,
`/mcp disable relay_http` reported disabled and persisted that preference, but
the next model request still included the HTTP tool. The native reconnect
handler copied tools into a second runtime cache that toggle-disable did not
clear. Fresh one-shot CLI tests could not expose that stale cache.

Reconnect now uses an ordered native disable/enable pair for the selected
server, then verifies native status. It does not restart Claude or the app,
edit native JSON itself, bypass managed policy or change saved Relay accounts.
Neither stage is retried automatically. If Stop wins between stages, no late
enable is sent; the native server may remain disabled until explicit retry.
Partial failures remain errors with the actual resulting inventory.

`node scripts/smoke-real-claude-mcps.mjs --application` starts an actual HTTP
app through native `/run` and verifies HTTP/stdio reconnect, single/all toggles,
next-query tool removal, and an explicit attempt to invoke a disabled tool
that must fail **without reaching the MCP server**. Re-enable and recovery
execute authenticated echo calls. Status/controls make no model calls. The
same CLI, session, app PID and in-memory data survive; a second chat remains
independent. Stop during actual MCP initialization cancels the connection,
retains queued input and saved context, and closes the app. Nine main model
replies plus native title calls; ordinary and `--errors` regressions retain
their three/zero model replies. No real accounts or inference are used.

`node scripts/smoke-real-claude-workflows.mjs --application` also verifies
native review in that retained-session context, using a real Git diff, Read,
ReportFindings, Edit and CLI execution where appropriate:

- Default/read-only and `--empty`: findings/no findings, unchanged source,
  same-process follow-up and explicit Stop/resume (**8** main replies each).
- `--fix`: actual source repair and observed `total: 5`, preserving the app
  through review and follow-up (**10** main replies).
- `--fix --plan`: actual native edit refusal and unchanged source, with the
  running app retained (**9** main replies).
- `--send-now`: interrupt the real review, retain the app/data and unselected
  queued input, then explicitly Stop and resume (**6** main replies).
- `--interrupt`: Stop interrupts the real review and closes the app, while
  preserving the native context and queued input (**5** main replies).

Four added unit/adapter tests cover ordered toggles, failed stages, cancellation
between writes and retained transport recovery. Syntax/unit suite **480/480**;
combined Claude-command/conversation browser suite **59/59**. The unit fixture's
local executor metadata was corrected so private-file checks actually use its
local files; native fixture failures now shut down and clean their disposable
resources. Those harness corrections are separate from the reproduced native
cache defect. Retained Fast interop is accepted below. Other command/workflow,
shared-host/company and activation gates remain open; item 20 and the original
feature order are unchanged.

### Claude Fast inside an already-running application

Two retained-session gaps are fixed. First, a denied `/fast on` previously
returned an error without disabling Fast in the CLI that still owned the app.
It now sends an acknowledged native Fast-off control and clears the preference
before reporting an account denial or failed availability lookup. An unconfirmed
native activation is also explicitly switched off. A failed control cannot
claim success; an interrupted lookup cannot send a late write. No app restart
or automatic command replay is involved.

Second, first opt-in no longer requires stopping a standard-speed application.
Installed **2.1.222** accepts the gateway compatibility environment through
`apply_flag_settings`, not only at startup. After a fresh authenticated account
check, Relay reads `get_settings`, preserves the flag layer's other environment
entries and applies that compatibility setting and Fast preference through the
native control. Invalid snapshots/errors fail before input; a failed write does
not mark the setting as applied. Only native structured activation confirms
success. The [gateway Fast contract](https://code.claude.com/docs/en/fast-mode#use-fast-mode-behind-proxies-and-llm-gateways)
still applies: this client compatibility setting does not authorize an account
or remove native model, worker, managed-policy or API-side restrictions.

`node scripts/smoke-real-claude-fast.mjs --application` verifies these paths
with the installed CLI, actual native Bash and a disposable HTTP app. The same
CLI, native session, app PID and in-memory data survive:

- Credit exhaustion, organization/extra-usage rejection, rate limits and
  overload; next-turn requests actually use the expected Fast/standard speed.
- Persisted/reloaded cooldowns, explicit off/on, model promotion and model
  switches; a control never becomes inference.
- Account denial and unavailable account service, explicit recovery and first
  opt-in after standard startup, including a refused first attempt.
- Explicit Stop closes the app; the saved native context and preference resume.

The run uses **51** main loopback requests plus native titles. It does not
advance the native clock or claim to have waited out the real ten-minute
cooldown; the existing `--limits` expiry fixture still advances only Relay's
clock after an explicit Stop. `--application --policy` uses a private mount
namespace and verifies the existing native managed per-session opt-in refusal:
unconfirmed activation is switched off, the app remains running and the next
request stays standard (**3** main requests plus titles). The policy file is
unchanged. Successful activation under that native managed-policy limitation
is still not claimed.

Seven new adapter/session tests cover immediate off, cancellation, failed
controls, invalid snapshots, preserved settings and first opt-in. Syntax/unit
suite **487/487**; combined Claude-command/conversation browser **59/59**.
Existing native Fast base, settings, managed-policy and limits regressions
pass (**7/3/2/21** main requests). All native acceptance uses disposable
profiles, dummy keys and a loopback-only network/PID namespace; no actual
accounts, inference, host policy changes, deployment or live service restart.
Item 20 remains active for the other documented command/workflow and account
isolation gates.

### Claude application sessions and native usage

The previous one-process-per-reply transport reproduced `ECONNREFUSED` after a
successful native `/run`: Claude's exit also ended its background HTTP server.
`/run` and `/verify` now retain the CLI and expose logical reply streams to the
existing adapter. Native command UUID/start events separate a queued user input
from an unrelated background answer. Settings changes use native controls;
they do not rewrite slash input or replace Claude's base system instructions.
Stop terminates the owning process tree and revokes the chat capability. Send
now interrupts the query without ending the application session. An interrupted
first application query reports an error checkpoint, unlike bundled review's
success checkpoint; its matching native session ID must survive interruption.
Startup and uncheckpointed failures still cannot leave a broken resume ID.

Native background answers are saved separately, never as fabricated user
messages, and never replace a foreground response ID or consume the queue.
The CLI reports cumulative model/cost totals across streaming replies; those
are converted into call deltas. A resumed one-shot CLI can also emit an empty
local result before its real reply. Distinct result samples prevent that empty
checkpoint from suppressing the actual usage. Fast off is applied immediately
to the retained CLI, including subsequent native background activity.

`node scripts/smoke-real-claude-run.mjs` runs installed Claude **2.1.222**, the
Relay gateway/controller and actual HTTP app/tools in private loopback/PID
namespaces, with authored model responses and no real inference or accounts:

- Default: real Read/Bash, HTTP create/list, changed validation returning 400,
  protected recipe-write refusal, separately supplied project recipe/reload,
  actual model change, Stop and same-native-context resume: **12** requests.
- `--send-now`: interrupt a later query, retain the actual app/data and other
  queued input, Stop and resume: **10** requests including native title calls.
- `--first-send-now`: interrupt the first run after actual HTTP interaction,
  retain its journal/application, Stop and resume: **8** requests.
- `--background-exit`: stop only the exact disposable app PID, save its native
  completion answer independently, then resume history: **6** requests.

All variants check persisted usage, real server availability/closure and native
context. Thirteen new unit/controller cases cover logical/process lifetime,
startup/cancellation/errors, literal UTF-8 inputs/settings, usage, background
isolation and immediate Fast off. Three responsive browser additions verify
discovery, literal queuing, independent background display and draft retention.
Normal unit suite: **449/449**; Claude command browser suite: **23/23**. Existing
native command, MCP and review Send now regression smokes also pass.

Remaining gates are explicit:

- The original protected `.claude/skills` write gate is now cleared for private
  profiles through the explicit native approval channel described above.
  The default smoke still exercises denial and separately supplied recipe
  reuse; `--approve-recipe` verifies actual native creation. Shared-host replies
  remain gated on company isolation; private `/run-skill-generator` execution
  and its generated direct run skill are accepted above.
- Application-session Plan entry/exit, explicit approval/denial, subsequent
  file permissions and Stop are now accepted in the four variants above.
  The separate shell-classifier fixture above now verifies native routing,
  allowed/denied effects, malformed/API failures and cancellation. Its authored
  verdicts are not a claim about real model judgment; native policy remains
  unchanged. Prefix suggestions and persistent shell grants are not covered.
- Appended system instructions cannot be replaced by these native controls.
  Such changes fail before input, with an explicit Stop/retry notice; running
  apps are not silently terminated. First Fast opt-in now uses native runtime
  settings after a fresh account check, as accepted above.
  Native effort changes and environment precedence are now accepted above.
  Long-lived capability renewal and account-change rejection are accepted
  above, as are retained-session MCP/review and Fast controls and effects.
  Missed capability deadlines and revocation remain enforced. Shared-host,
  custom-upstream and native managed-policy Fast limitations remain explicit.

Fixture corrections: wait for the actual server's readiness; distinguish native
title generation from the main query; Haiku does not accept an effort picker
value. These are not product fixes. The reproduced product fixes are server
lifetime, first-interruption checkpoint, dropped background answers and usage
accounting. The queue stays on item 20; no deployment, live-data changes, merge,
personal Chrome access or host/company credential writes.

### Claude bundled code review and interruption

Installed Claude **2.1.222** expands `/code-review` into its native review
instructions and tools. Its internal review query does not stream its tool
events through the parent print output; the native instructions explicitly
require findings in the final reply, which Relay saves and displays. Do not
invent structured findings or treat a catalog entry/stock model reply as proof
that a review read the diff or applied a fix.

The real CLI reproduced a broken first-command resume: terminating an active
review with SIGTERM left no journal for the already-persisted session ID.
Review turns now use the native
[streaming-input interruption contract](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode),
send an SDK interrupt and allow bounded journal flushing before termination.
The first ID stays provisional until the native result checkpoint. Graceful
Stop and Send now retain that checkpoint even though the turn was cancelled;
startup failures and forced termination without a checkpoint never retain a
nonexistent first ID or automatically replay `--fix`. Existing session IDs are
not cleared. Native mode/model/effort and permission enforcement are unchanged.

`node scripts/smoke-real-claude-workflows.mjs` uses the installed CLI and real
Relay adapter/gateway in a private network/PID namespace with only loopback.
An authored model fixture operates on a disposable, committed CLI with a real
addition-to-subtraction diff; it executes actual Git, Read and ReportFindings
tools, and checks the resulting saved response and same-session continuation.
No real inference, personal profile, GitHub mutation or external network:

- Default: read-only review, final finding and resumed native context; five
  loopback replies. `--empty`: empty native findings and no edits; five replies.
- `--fix`: actual native Edit, actual CLI invocation returning `total: 5`, saved
  fix summary and resume; seven replies. `--fix --plan`: native edit refusal,
  unchanged file and resume; six replies.
- `--interrupt` and `--send-now`: stop during the actual first review query,
  retain other queued input, resume the same native UUID with its review
  context, and leave the source unchanged; three requests each.

Four adapter tests cover literal input/settings, first checkpoint, SDK Stop,
spawn failure, refused/unresponsive control fallback, retained capabilities and
existing sessions. One controller test covers FIFO and error queue pausing;
three browser additions cover discovery, multiline flags, busy queueing, saved
findings and failed-send draft/file retention at desktop and 320px. Normal unit
suite: **436/436**; Claude command browser suite: **20/20**.

Exploratory fixture corrections were not product fixes: native API histories
may end in a system reminder rather than the latest tool result; `--fix` keeps
editing inside the review turn, not a fabricated second apply phase; empty
ReportFindings returns `No findings reported.`. Assertions still verify actual
tools/files and native context. This proves integration, not model review
quality. GitHub `--comment`, other bundled workflows (including scheduled-task
persistence), installed plugin namespaces and prior company/account/live gates
remain open. Keep item 20 active; no merge/deploy/live-data changes.

### Claude native MCP controls and persistence

Installed Claude **2.1.222** exposes `/mcp reconnect`, `enable` and `disable`,
but executing their slash handlers in print mode reproduced the native
terminal-callback-unavailable response. Discovery alone was not working control.
Relay now invokes installed stream-json `mcp_toggle` controls (an ordered
disable/enable pair for reconnect, as explained in the retained-session fix),
checks the resulting `mcp_status`, and uses a local native `/mcp` status command
to checkpoint the same session journal. These actions never become model tasks.
Bare `/mcp` still opens Relay's saved connection manager; `/mcp verbose` shows
the saved native server inventory. Single-server and `all` actions use the
ordinary message/FIFO path. Native help and invalid arguments remain native.

The [native MCP persistence contract](https://code.claude.com/docs/en/mcp#disable-a-server-without-removing-it)
places server preferences in the project entry of `.claude.json`. Native code,
not Relay JSON rewriting, owns those changes. Relay preflights the private
file without returning account/project metadata; linked, malformed or unsafe
files fail closed, and shared host-profile mutations stay gated on item 21.
Saved connection credentials and environment selections are not changed.
Attachments are rejected before acceptance/queueing, preserving the draft.

Control requests have correlated IDs, bounded timeouts and Stop cancellation.
Errors expose only bounded categories/status, not upstream URLs, headers or
credentials. Partial failures and unverified acknowledgements are errors, not
successful assistant replies; the queue pauses without consuming later inputs.
Connector-only refreshes retain installed commands. The first native session
ID remains provisional until a real journal checkpoint, including preflight,
spawn and startup-interruption failures, so retry cannot resume a missing file.

`node scripts/smoke-real-claude-mcps.mjs` uses the real installed CLI, Relay's
environment selection and MCP/provider gateways, with private profiles in a
network/PID namespace containing only loopback. It verifies HTTP and stdio
connections, actual reconnect initialization, single/all enable/disable,
command-first startup, Stop/resume, independent chats, native help/errors,
next-turn tool removal and reintroduction, and an actual authenticated fixture
echo invocation. Three authored loopback model replies; no real inference or
accounts. Worker arguments/environment contain neither fixture provider nor
MCP credentials. The failure variant (`--errors`) makes zero model requests:
rejected reconnect/enable, honest native partial-enable persistence, recovery,
Stop during an actual reconnect and first-connection interruption, preserving
queued input and valid same-session resume.

Initial fixtures needed their own MemoryRecords instance. After adding the
failure hook, the initialization counter was accidentally inside an optional
call and stopped incrementing in the base test. The unchanged effect assertion
caught it; the counter now increments unconditionally. Neither correction
weakens native reconnect/tool assertions. Nine unit/controller cases plus three
browser additions cover private files, protocol errors, FIFO and desktop/320px
manager/status/action paths. Related browser suite **28/28**; normal unit suite
**431/431**. The previous native goal smoke remains green with four loopback
requests. Backend activation, shared-host isolation, real account consent and
remaining item-20 commands are not claimed complete; no merge/deployment or
live chat/browser/account changes were made.

### Claude native goal execution and response boundaries

The installed Claude **2.1.222** catalog exposes `/goal`. Relay already preserves
its native command prefix; acceptance now exercises its actual Stop-hook
evaluator, not an invented controller loop or a prose-only acknowledgment.
The [native goal contract](https://code.claude.com/docs/en/goal) describes setting
a condition, querying state, clearing it, and restoring an active goal with the
same native session. Claude's native clear aliases remain literal; Codex-only
`pause`, `resume` and `edit` semantics are not imposed on Claude's condition text.
Ordinary explicit input continues the restored goal. Merely opening its chat or
querying `/goal` does not start another model turn.

The new `scripts/smoke-real-claude-goals.mjs` runs the real manager, CLI and
provider gateway in a private network/PID namespace with loopback only, authored
model replies and no personal profile/provider credentials:

- Default: four actual model requests prove immediate task execution, a native
  negative evaluation followed by continuation, then positive evaluation and
  clearing. The condition retains multiline Unicode, the second turn receives
  native evaluator feedback, and completion stays cleared after Stop. Queries
  and an overlong condition do not become inference.
- `--resume`: interrupt the real in-flight evaluator, retain the same session,
  inspect the still-active goal, continue explicitly and complete it. A separate
  chat has no inherited goal. Stop a second goal, clear it and exercise every
  installed clear alias without inference. Six actual requests; saved session
  identity is read back from disposable storage.
- `--errors`: malformed evaluator output leaves the goal active, now with a
  visible web notice instead of a dropped `ctrl+o` terminal notification.
  A private native `disableAllHooks` setting refuses goal activation without
  inference or policy mutation. Two actual requests. It is not reported as a
  completed goal or silently retried.

These tests exposed concatenated goal steps in Relay's response stream. The
adapter now keeps paragraph boundaries between distinct main-agent messages,
preserves all content blocks within each message, fills missing streamed text
from complete events, and avoids duplicating native events. Child-agent text and
thinking blocks cannot enter the parent's textual response. Both live deltas
and the saved answer use this same accumulator. Local-command result text still
renders, but native error results are not streamed as successful assistant text.

The first probe incorrectly identified the evaluator by a Haiku model name:
this installed setup actually used Sonnet. The fixture now recognizes the
native evaluator request contract without changing its model/effort. A second
regression caught that Claude emits an assistant event **per content block**;
ending a message at the first such event lost the next block. The actual native
fixture now contains multiple blocks and retains its exact text assertion.

Seven added unit/controller tests cover boundaries, native block/event replay,
complete-only and legacy output, child/thinking exclusion, notices and literal
FIFO commands. Three added browser cases cover 1280px/320px command selection,
queued multiline conditions, visible evaluation warnings and paragraph/draft
preservation; related browser regressions **25/25**. The native command/skill
smoke still passes with four loopback replies, and native Fast with seven
requests/twelve account checks. This proves command transport and native-loop
behavior, not model quality for an arbitrary requested application. No native
goal metadata is fabricated from prose, no real chats/accounts are changed and
no deployment is performed. Keep item 20 open for native MCP actions, bundled
workflows, installed plugin namespaces and the previously recorded profile,
gateway, policy and activation limitations.

### Claude private-gateway Fast checkpoint

`/fast`, `/fast on` and `/fast off` now have per-chat preferences and scoped
state, rather than failing at the native print-mode opt-in gate. Controls retain
FIFO ordering, reject attached files before acceptance, survive Stop/reload and
cannot overwrite newer picker choices, including same-value choices made during
asynchronous settings resolution. Owner/company/environment/profile changes
invalidate the opt-in; a changed credential requires explicit opt-in again.
Only a hash binds the saved preference to its credential, never the key itself.

The [native Fast contract](https://code.claude.com/docs/en/fast-mode) distinguishes
startup opt-in, account entitlement and model eligibility. Its bearer-only
gateway transport cannot authenticate the organization lookup. Relay therefore
performs the installed CLI's authenticated availability GET in the controller,
with a five-second bound, strict JSON/size validation, no redirect or positive
cache, and no key transfer to workers. Custom upstream keys are not sent to
Anthropic. Only a fresh positive decision enables the documented
`CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK=1` **gateway compatibility flag** in that
one worker launch. This relocates the availability check; it does not assume
authorization or ignore a denial. Native model/disable policy and API entitlement
remain in force. No org-cache file is fabricated. A denied explicit activation
fails visibly; a later failed check continues an ordinary task at standard speed
with a notice and resets the chat preference. Off needs no lookup or inference.

Installed **Claude 2.1.222** has an observed print-mode inconsistency: `/fast on`
from Sonnet reports a switch to Opus in prose but returns the prior model's
structured Fast state as off. Relay starts that explicit activation with the
native-contract Opus choice and preserves effort; native policy still validates
the choice. It requires the actual structured on/cooldown state, not just the
success prose. Later explicit model changes win; toggling from inactive Sonnet
enables Opus Fast again instead of mistakenly turning off the saved preference.

`node scripts/smoke-real-claude-fast.mjs` uses a loopback-only network/PID
namespace, dummy controller credentials and private profiles. The installed
catalog exposes Fast; actual model request bodies prove Fast versus standard
speed, unchanged native identity after Stop, model promotion and subsequent
model switching. Native disable and model-allowlist policies reject activation
without inference. Fresh allowed/denied controller responses are checked; the
fixture asserts that the worker environment never contains the controller key.
No public API, real account, personal profile or live chat is used.

Thirteen new unit/controller cases cover these paths plus malformed/oversized
responses, credential rotation, interruption, missing native state and selection
races. Three browser cases cover discovery, 1280px/320px idle/busy dispatch and
draft/attachment retry; related browser regression suite **22/22**. The first
full unit run found the old Claude-dispatch expectation (`null`); it now asserts
the exact new typed command, retaining the unrelated native dispatch assertion.
The native Sonnet inconsistency was reproduced before the launch-model fix; no
success assertion was relaxed. Final test totals are recorded in the queue.

The follow-up rejection/cooldown/configuration checkpoint below covers the
additional native cases. Shared host profiles still need item 21 isolation;
custom gateways need their own authenticated availability integration. Live
backend activation is not performed by these checkpoints. Keep item 20 open and
continue remaining installed commands; this is not a claim
that every command is complete.

### Claude Fast provider feedback and restart persistence

Actual Claude **2.1.222**, through the real Relay provider gateway, reproduced
two further defects: native cooldowns are process-local and disappear between
print turns; after a Fast API entitlement rejection, the gateway compatibility
flag can leave the native result reporting `on` even though it fell back to
standard speed. Relay now observes the authoritative API rejection rather than
mistaking that stale result for a successful Fast request.

The gateway forwards request/response bytes unchanged. A bounded streaming
inspector reads only the root `speed` field, ignoring prompt/tool content and
the Fast beta header (which also appears on standard-speed requests). Only
400 error inspection buffers a body, capped at 4 KiB. Capability-bound,
request-time observer snapshots deliver sanitized reason/deadline metadata,
never provider keys, raw errors, prompts or headers. Revoked/expired capabilities,
other chats/providers and late responses to a previous turn cannot deliver it.

Provider cooldowns retain their native retry deadline: native sub-20-second
retries are left alone; longer limits use the installed minimum ten minutes or
default thirty minutes. The desired Fast preference stays on while subsequent
turns run at standard speed; after expiry, a fresh account check precedes the
next Fast request. Organization/extra-usage disablement instead clears the
preference. A rejection received before Stop is saved even when that turn is
interrupted or a newer model is chosen, without replacing the newer choice or
crossing credential/owner/environment boundaries. A newer Fast-off stays off.

Credit exhaustion is distinct: as documented for current headless stream-json
in the [native Fast contract](https://code.claude.com/docs/en/fast-mode), the
installed CLI retains the opt-in and retries at standard speed for that turn.
Relay now displays its native credit notification once per turn rather than
silently dropping it or permanently disabling Fast.

Verification uses disposable profiles and network/PID namespaces with only
loopback, dummy keys and deterministic native model replies:

- Base `node scripts/smoke-real-claude-fast.mjs`: seven actual model requests and
  twelve account checks, preserving previous model/policy/resume assertions.
- `--limits`: twenty-one actual requests across credit exhaustion, API 400
  organization rejection, extra-usage disablement, rate-limit and overload
  cooldowns. Asserts saved/reloaded deadlines, native identity after Stop,
  independent chats, off/toggle behavior and expiry. Expiry advances only
  Relay's injected clock; it does not claim to have waited out the CLI's real
  ten-minute timer or change native clock/rate-limit semantics.
- `--settings`: three actual requests prove `/config model=sonnet`,
  `/settings model=opus`, saved opt-in, explicit off and Stop/resume work
  together. Native `fastMode` and `fastModePerSessionOptIn` are **not** valid
  `/config` keys in this installation; native rejection must preserve the
  preference and never become inference.
- `--policy`: an additionally private mount namespace supplies real native
  managed settings without editing host `/etc`. Installed print-mode
  `fastModePerSessionOptIn:true` returns stale ON prose with structured `off`;
  Relay refuses activation, and two subsequent requests stay standard across
  Stop. The policy is not bypassed or edited. This verifies safe enforcement,
  **not** successful Fast activation under that native managed-policy limit.
  Supporting activation there requires a native-capable session path; it remains
  an explicit limitation, not a fabricated success.

Eight additional unit/controller tests cover chunk/escape boundaries, nested
input, large prompts, bounded errors, capability isolation, interrupted turns,
newer models, native failure and changed scope. Normal unit suite **415/415**;
related browser regressions **22/22**. The isolated smoke runner also requires
its final assertion marker, not merely exit code zero. No personal credentials,
real inference, live chat/profile changes, deployment or live service restart.

### Claude automatic compaction and earlier Fast-mode findings

Installed Claude **2.1.222** already persists `/autocompact` values correctly;
acceptance now verifies its effects, not just the command acknowledgement.
The [native window contract](https://code.claude.com/docs/en/model-config#set-the-auto-compact-window)
describes saved windows, reset and environment precedence. Relay preserves this
native behavior and now applies its private-profile mutation and linked-file
checks to `/autocompact`, too. Previously this command could write a shared host
profile outside the company-scoped controls. Bare status remains read-only;
mutations are gated until item 21's host-profile isolation is complete. Attached
files are rejected before accepting/queueing input, so they cannot become native
arguments and the composer retains the draft/files. No custom token-size parser,
fake summarizer or forced compaction is introduced into production.

`node scripts/smoke-real-claude-commands.mjs --autocompact` uses the real manager,
adapter and installed CLI with deterministic loopback model responses. A saved
95k-token usage sample fits the 200k setting; after lowering the setting to 100k
and explicitly stopping, the same native session requests an automatic summary,
emits its actual automatic `compact_boundary`, and continues the task. `auto`
removes the saved threshold. Five loopback replies; no external inference or
large fabricated history in a real user chat.

The `--autocompact-disabled` variant verifies that setting a window does not
enable disabled auto-compaction, including actual no-summary continuation after
Stop. Invalid `99k` retains the previous setting; a worker's explicit
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` override is reported natively and prevents the
command from pretending to apply its argument. Two loopback replies. The first
environment-precedence fixture lacked an executor because this smoke normally
uses the adapter directly; it now supplies the ordinary local-executor contract
without rewriting native arguments or changing the model/effort baseline.

Three new unit/controller tests cover private/host routing, literal FIFO input,
disabled-state persistence, reset/invalid values, sibling isolation and linked
files. One 320px browser case covers discovery without sending, busy/idle
dispatch and draft/attachment retention. Final unit/controller suite **394/394**;
related browser cases **19/19**. The earlier configuration native smoke still
passes; no live service/account/profile or approval was changed.

At the preceding checkpoint, a disposable-profile probe in a loopback-only
network/PID namespace confirmed that `/fast`, `/fast off` and `/fast on` returned the native
Agent-SDK-unavailable result with Relay's ordinary launch. The documented
[non-interactive opt-in](https://code.claude.com/docs/en/fast-mode#toggle-fast-mode)
requires startup settings; adding `--settings '{"fastMode":true}'` to that
isolated probe clears the SDK gate but then reports organization-disabled with
the dummy account. No organization/network checks were bypassed, no personal
credentials were supplied, and the probe could not reach external services.
That evidence led to the private-gateway implementation and request-level
acceptance above. A native denial, an opt-in flag alone or a lower effort setting
is not Fast-mode completion; remaining cases stay explicitly open.

### Claude configuration effects and persistence

The installed Claude **2.1.222** accepts `/config key=value` and `/settings`
natively in print mode. The [native model precedence](https://code.claude.com/docs/en/model-config#setting-your-model)
explains the reproduced bug: startup arguments override saved configuration.
Relay previously retained its old model/mode and sent them again next turn,
despite the native command's successful acknowledgement. Private gateway
profiles now read back only `model` and `permissions.defaultMode` before/after
the command and reconcile verified changes into the owning chat. Explicit
same-value requests also reconcile an older native value with a newer, different
web choice. Invalid assignments do not accidentally restore unrelated native
defaults. Native partial successes, including a failed process after writing,
retain applied choices and visible failures rather than claiming atomic success.

Inspection uses the owning worker, a fixed private path, bounded reads/output,
link/hardlink and file-change checks, a minimal credential-free environment,
timeout and Stop cancellation. No raw settings, permission rules, hooks,
environment or credentials are returned. Shared host-profile mutation is refused
before accepting or queueing input; read-only help still works. The original
command reaches the native CLI unchanged, and attachments are rejected instead
of being appended to its argument string. Owner/profile/Stop guards prevent late
updates; per-control revisions retain newer web selections, even reselection
of the original value, with a visible conflict notice.

All five native permission modes round-trip; Manual and Deny prompts are
Claude-only controls and pass their actual CLI flags. Private-profile Manual
approval replies now use the native channel described above; shared host
profiles remain unsupported and are explicitly labelled. Switching either mode to
Codex defaults to Plan. Native model aliases include the Claude account default,
distinct from Relay's configured default. Unsupported old effort is cleared
when changing models. `/effort auto` explicitly resets native effort, rather
than reapplying Relay's High default; `/effort status` runs the native query.

`node scripts/smoke-real-claude-commands.mjs --settings` verifies Sonnet and
`thinking=false` in actual loopback requests, same-session Stop/resume, partially
accepted `/settings model=haiku madeUp=wrong`, native mode persistence, Auto
effort status and account-default selection. Three deterministic model replies;
no external inference, personal credentials or live chat/profile changes. The
initial acceptance failed because Relay remained on Opus after native Sonnet
selection. The later Haiku assertion exposed the installed CLI's native Sonnet
promotion in Plan mode; switching explicitly to Accept edits verifies the actual
Haiku execution request, without replacing the configured Opus/High baseline or
weakening its model assertion. Native bundled workflows and other remaining
commands still need their own effect-level acceptance.

Eleven new unit/controller cases cover parsing/readback, scope and filesystem
safety, aborts, partial failure, FIFO, Stop/owner races, concurrent/repeated web
selections, effort reset and host/attachment rejection. Four new browser cases
cover desktop/320px updates, busy queueing, retained drafts/files after rejection,
and actual mode/effort API changes without waking a worker. The existing mobile
slider regression correctly caught Auto being placed before Low; Auto now stays
outside the fixed-level slider instead of weakening the existing Low assertion.
Final normal unit/controller suite: **391/391**. Related browser regressions:
**27/27**. Both installed-Claude smoke variants and JavaScript syntax/whitespace
checks pass. Earlier broad history/network browser gates and live activation
remain open; no deployment, live approval or real-account change is included.

### Claude command execution and catalog refresh

The official [programmatic usage guide](https://code.claude.com/docs/en/headless#create-a-commit)
documents expansion of user-invoked skills/custom commands in print mode and
the limitations of terminal-only controls. The [command reference](https://code.claude.com/docs/en/commands)
documents leading command names, arguments, aliases and version-dependent
availability. Relay passes native Claude input at the beginning of the message;
its own handoff and formatting context remains in appended system instructions.

`node scripts/smoke-real-claude-commands.mjs` exercises installed Claude Code
**2.1.222** and the real Relay manager/adapter, using only disposable repositories
and private profiles. Starting a new conversation with `/reload-skills` does not
call a model or prevent subsequent conversation. Actual custom `.claude/commands`
and `.claude/skills` contents expand into the native request, preserving multiline
and Unicode arguments. `/settings --help` expands the installed `/config` alias;
reload, settings help and `/autocompact 200k` return native text without inference.
After Stop, continuation retains the same native session and prior history.
Four deterministic loopback model replies cover continuation/expansion; there
are no external inference requests, personal accounts, real plugins or live
workspaces. A scripted reply is not proof that a bundled workflow performs its
intended task; the remaining effect-level acceptance is listed above.

The smoke reproduced a real stale-catalog failure: after an on-disk skill was
added and native reload completed, Relay still returned the earlier cached menu.
Successful reload and changed native command metadata now invalidate only the
owning chat's catalog. A persisted `commandCatalogRevision` travels with chat
updates and versions both controller and browser caches, including return from
another chat or controller restart. The open slash menu re-runs its current
search; closed menus stay closed. Stale pending discovery/replayed snapshots
cannot restore old commands, and drafts/files are preserved. Unchanged native
reports do not cause another revision; failures/interruption do not publish a
successful reload refresh. No new model calls or worker restarts are introduced.

Four controller/unit and three browser cases cover these behaviors. The final
normal unit/controller suite passes **380/380** and related command browser
regressions pass **28/28**, including the three `/init` browser checks. Installed
CLI smoke, all JavaScript syntax and whitespace checks pass. One initial unit
fixture omitted its capability broker and was corrected; the native stale-menu
assertion and controller/browser assertions were retained. No timeout, command
semantics or assertion was relaxed. Earlier full-browser history/network gates
and live activation remain open; this is not full installed-command acceptance.

### Repository initialization

OpenAI Docs' [initialization command](https://learn.chatgpt.com/docs/developer-commands#generate-agentsmd-with-init)
defines `/init` as generating a repository instruction scaffold for review, not
silently replacing existing conventions. Relay requests inspection of actual
repository evidence, preserves existing `AGENTS.md` and unrelated edits, and
keeps multiline additional instructions and the original user command in the
same chat. The existing task dispatch needed no production change for this
checkpoint. Claude's native `/init` is not translated into Codex instructions.

Six controller/unit cases cover authenticated submission, original chat/text,
FIFO queueing and scoped attachments, Stop/restart and explicit queue resume,
read-only Plan, native failure reporting, and auth/origin/ownership rejection.
Three browser cases cover command selection without sending, idle and busy
submission, multiline text, preservation of newer drafts/files after a delayed
reply, and retry with the original command and files after an error.

`node scripts/smoke-real-init.mjs` uses the installed Codex **0.154.0** with
disposable repository/profile data and nine deterministic loopback responses.
Real native Code Mode reads repository evidence and applies an actual
`AGENTS.md` patch. Exact file bytes establish creation and preservation after
same-session resume; an attempted Plan-mode patch is denied and leaves the
document unchanged. README, package metadata and unrelated user-draft bytes
remain unchanged. No external inference, personal credentials, live approvals
or real repositories are used. The fixture exercises the CLI/tool integration,
not an actual model's ability to choose accurate prose; generated instructions
still require review as the official command describes.

The native fixture initially assumed legacy top-level tool advertisement and a
textual patch-success acknowledgement. Actual advertised Code Mode and generated
protocol schema corrected those fixture assumptions; exact filesystem assertions
were retained. The full normal unit/controller suite passes **376/376** and the
focused browser run passes **3/3**. These results do not close earlier full-browser
history/network failures or deployment gates. `/init` acceptance is covered;
remaining installed Claude-command effect acceptance is recorded above.

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
was deployed. `/init` repository-document acceptance is recorded above;
remaining installed Claude-command acceptance keeps item 20 open.

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
`/init` acceptance is recorded above; installed Claude-command checks still keep
item 20 open.

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
