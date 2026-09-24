# Bind worker GitHub access to the selected conversation runtime

The controller issues one revocable GitHub worker capability after environment
setup and before native agent startup. It is bound to the current owner,
primary company, saved repository identities/branches and selected named
connections. Git smart HTTP and the two PR MCP tools share that capability.
Upstream GitHub credentials remain inside the owner's controller service; no
host `gh` login, provider PAT or browser cookie is imported into a worker.

Stop, archive, deletion, startup failure, fatal exit and controller shutdown
revoke access. Named connection edits/disconnects revoke and abort in-flight
operations before persistence; an admission during a pending save waits for
the owner's mutation queue. Resume acquires a fresh capability. Browser-only
worker acquisition issues none. Setup scripts run before grant issuance.

Only the worker's ephemeral environment receives `GIT_CONFIG_*`; repository
remotes remain canonical HTTPS GitHub URLs. Both native adapters replace the
PR MCP bearer with an environment-variable reference before constructing CLI
arguments. This is agent-readable authority inside its dedicated VM, not a
secret hidden from that agent. Stop/revocation, exact server-side repository
scope and owner isolation enforce the boundary.

Codex normally inherits its core environment. For a worker with capability
configuration it instead gets an exact-name allowlist from the already
sanitized `buildWorkerEnvironment` object. This preserves `GIT_CONFIG_KEY_n`
(otherwise removed by Codex's default `*KEY*` filter) without copying values
into `shell_environment_policy.set` command-line flags. Provider credentials,
provider session tokens and the duplicate MCP-only bearer variable are not
included in shell inheritance. No controller environment inheritance is added.
Existing workers without such capabilities keep their previous policy.

Both adapters include capability values in their existing stateful main/side
agent output redaction, structured event masking and private diagnostic
boundaries, including gateway mode as well as named account mode. This prevents
accidental echo into stored messages/events; it does not prevent an authorized
agent from using its scoped capability.

The same environment-reference and redaction boundary covers controller-issued
browser and selected HTTP MCP capabilities after all runtime MCP configuration
is aggregated. Collection requires this controller's origin, a fixed gateway
path and the minted capability format; it does not collect upstream provider
credentials. A stale fatal callback from a previous stopped adapter cannot
revoke or terminate a newly resumed runtime.

Legacy source-only records from the original schema have no `repositories`
field. Restore defaults only that absent field to `[]`: startup, native-history
import and resume obtain no GitHub capability even if an account is connected.
An explicit null, malformed selection or incomplete repository identity is not
silently migrated or matched to an account; it remains denied with a fixed 403
message. Old selections missing a connection ID require explicitly reselecting
the repository and intended account in a new chat; merely reconnecting is not a
repair, and the current UI cannot edit an existing selection. The fork/import
and Linear integration fixtures now use complete saved selections and scoped
synthetic connection records, exercising admission rather than bypassing it.

Validation includes offline lifecycle, owner namespace, delayed-save, startup
cancellation, HTTP authentication, both-provider argv and split-stream tests.
The opt-in command below runs real installed CLIs in disposable private homes,
against a loopback-only MCP fixture, without any model turn or real account:

```
AGENT_TEST_NATIVE_GITHUB=1 taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 test/native-github-environment.test.mjs
```

It checks actual MCP header resolution, actual Codex `command/exec` environment,
native `/proc` argv, unchanged `.git/config`, absence of the capability in known
native settings files, and zero model/provider requests. It is not evidence of
a real selected-user private-repository push or PR from an EC2 runtime; those
remain separate live product acceptance gates.

References checked: [Codex shell environment policy](https://developers.openai.com/codex/config-advanced#shell-environment-policy),
[Codex MCP HTTP authentication](https://developers.openai.com/codex/mcp#streamable-http-servers),
[Claude MCP environment expansion](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json).
