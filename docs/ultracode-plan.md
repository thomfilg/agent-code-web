# Claude Ultracode: native contract and bounded implementation

Status: implemented in the `feat/claude-ultracode` component branch with isolated
protocol/UI fixtures; not deployed or validated with a real selected account/worker.
Native contract investigation used the installed Claude Code 2.1.222 binary.

## Observed native contract

Ultracode is a session boolean combining xhigh effort and standing dynamic
workflow orchestration. It is not another numeric effort level and selecting
xhigh must not opt a user into Ultracode.

The installed native settings schema accepts `ultracode: boolean` through
`--settings` and `apply_flag_settings`. Native `apply_flag_settings` with
`ultracode: true` sets both the orchestration state and effective requested
effort to xhigh; false clears the orchestration state. Native interactive
toggles deliberately do not persist this setting into a shared profile.

Two real SDK observations can be used without a model turn:

- `initialize.commands` includes an `effort` command whose dynamic
  `argumentHint` includes the exact `ultracode` option only when native workflows
  are enabled, the current model supports xhigh, and organization policy permits
  that effort. This proves availability only for that initialization/model.
- `get_settings` includes `applied.model`, `applied.effort`, and
  `applied.ultracode`. The last is computed from the native orchestration flag,
  actual workflow availability, and effective xhigh effort. It is stronger than
  merely reading `effective.ultracode` from merged input settings, and accounts
  for environment/policy overrides.

Unknown/absent metadata is not support. In particular, xhigh in `list_models`
alone does not establish that workflows are enabled. Do not set feature-gate,
organization-policy, or environment overrides to manufacture support.

## Bounded implementation

1. Preserve bounded `argumentHint` and its observed model in the existing
   selected-account metadata discovery; no additional CLI just to open a menu.
   Use native applied-state shape to identify the supported control contract,
   rather than assuming every worker matches a controller version string.
2. Add an explicit per-chat boolean, default false. The model/effort endpoint
   accepts it only for Claude and a compatible selected account/model. Do not
   save it in user-wide preferences, an upstream profile, or another chat.
   Provider changes and incompatible model/effort choices explicitly disable
   it; neither xhigh nor a catalog refresh enables it automatically.
3. Show a distinct choice labeled “Ultracode · xhigh + workflows” alongside
   effort choices, with an explanation of the composed mode and unavailable
   reason. The saved value remains boolean plus xhigh, never an invented effort
   enum. Preserve ordinary xhigh as a separate choice. Unknown capabilities
   remain visibly unverified/unavailable, not silently treated as enabled.
4. On the actual selected worker, pass only this chat's session flag. Apply
   `{effortLevel: "xhigh", ultracode: true}` through the existing SDK for a
   retained session, then require `get_settings.applied.ultracode === true`
   before any user input. Missing/false readback produces a fixed actionable
   error, no fallback prompt and no falsely confirmed mode. Explicit disable
   sends false; normal effort/Auto semantics remain intact.
5. Bind any applied-state receipt to the existing chat/model settings revision,
   account, native session and lifecycle generation. A queued/stale save or late
   readback must not restore an old choice after a switch or Stop. Resume reads
   the latest persisted explicit choice and validates it again. Fork/import
   policy must be explicit: default new conversations to false unless the user
   deliberately copies that chat setting.

Implementation notes:

- Discovery reuses the existing selected-account CLI process. The public catalog
  receives only a capability boolean and fixed reason; raw settings and account
  details are not published. Only the actually observed default/concrete model
  is verified: support is not guessed for other aliases.
- The picker stores a per-chat boolean alongside real `xhigh`, not a new native
  effort enum. Ordinary xhigh remains separate. New-chat preference saves omit
  the boolean even when the current draft explicitly selects Ultracode; new
  chats, imported sessions and forks default false. Provider/model changes clear
  it. A saved but unavailable selection stays visible and cannot silently run.
- Actual SDK startup applies and reads back the native composed mode before
  sending input, with selection/account/revision/lifecycle checks around awaits.
  The same checks run inside queued settings persistence, not just before it.
- Ordinary SDK turns explicitly clear and read back Ultracode whenever native
  metadata advertises the boolean, including lower effort and fresh/resumed
  processes. Ordinary xhigh or a previously enabled mode requires this receipt.
  Older CLIs without the field may continue ordinary non-xhigh only when no
  prior/requested mode is enabled; their optional discovery query is bounded.
- Side-chat turns explicitly choose false; no sidebar/project preference enables
  workflow orchestration. No organization-policy, feature-gate or environment
  override is used to manufacture Ultracode availability.
- Native `/code-review` and mutating `/mcp` commands use different control
  transports. Their combination with explicit Ultracode is currently unsupported
  and rejected before launch, without changing the saved mode or silently
  downgrading it. Select ordinary effort to use these commands. Ordinary command
  behavior is retained; completing these combinations is remaining work.

Fixture verification covers discovery, missing/denied/malformed readback,
workflow and effective-effort mismatch, startup/retained/resume behavior,
settings races, new-chat isolation, and picker pending/unavailable states.
Final component receipt: 212/212 focused Node tests and 3/3 browser tests passed
serially on CPU 0,1 with no browser retries. The focused files include the new
Ultracode suite plus Claude session, account discovery, settings, MCP, review,
catalog, model picker, model/worker settings, and workspace-settings regressions.
These fixtures do not establish that a deployed worker or real account is
entitled to Ultracode. That remaining acceptance requires a separately authorized
selected-account/worker test, including the actual native workflow observation.

## Required evidence before claiming completion

- Default false, explicit opt-in, distinct ordinary xhigh, and selected-chat
  persistence only; no cross-owner/account/company admission changes.
- Model/provider switch, disable, Stop/resume and in-flight revision races.
- Supported native readback succeeds; older/malformed/missing response,
  disabled workflows, environment override and policy/model denial all refuse
  before user input. No synthetic model prompt is used as a probe.
- Actual session startup and retained-session flag updates, including explicit
  false and readback, preserve unrelated native settings and never leak account
  credentials.
- UI selected/pending/unavailable states and independent review; any real native
  acceptance is separately authorized and reported, not inferred from fixtures.
