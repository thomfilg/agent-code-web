# Claude Ultracode: implementation plan, not a shipped feature

Status: investigated against the installed Claude Code 2.1.222 binary; not yet
implemented or validated with a real account/worker. This work is separate from
the reviewed model-catalog and command-initialization fixes.

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

## Proposed bounded implementation

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

Likely files: `src/models.mjs`, `src/agent-accounts.mjs`,
`src/claude-account-client.mjs` (reuse discovery), `src/store.mjs`,
`src/runtime-manager.mjs`, `src/adapters/claude.mjs`, `src/claude-session.mjs`,
`public/model-picker.js`, and focused new tests. Shared-file owners must be
coordinated after the current release checkpoint.

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
