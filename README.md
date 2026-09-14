# Agent Web POC

A small web control plane for running Codex and Claude Code
from a browser. It is intentionally a POC, but the core lifecycle is real:

- any number of persisted chats;
- pinned chats, company → primary repository groups, custom drag-and-drop groups,
  and sorting by creation date, update time, or workflow state;
- connected GitHub repository/branch selection, reusable named environments,
  masked variable editing, and encrypted PostgreSQL records;
- a compact composer with provider switching, model/effort controls, modes,
  attachments, and agent-generated conversation names;
- PR links, colored file diffs, CI counts, conflict detection, and opt-in GitHub
  auto-merge;
- one independent workspace and worker lifecycle per chat;
- streamed assistant and tool events over Server-Sent Events;
- Codex through the official `codex app-server` JSON-RPC protocol;
- Claude Code through `claude --print --output-format stream-json`;
- automatic process shutdown five minutes after a completed turn;
- transparent restart/resume when the next message arrives;
- optional login token for exposing the UI beyond localhost;
- a credential gateway that keeps long-lived provider keys out of worker
  environments;
- optional one-EC2-instance-per-chat workers that are stopped—not merely made
  idle—after the timeout.

```text
Browser ── cookie + SSE ──> control plane (chat store, master keys)
                                  │                 ▲
                         short capability          │ provider response
                                  ▼                 │
                         per-chat worker ──> credential gateway ──> provider
```

## Quick start

Node 22+, Git, and Codex and/or Claude Code must be installed on the
control-plane machine.

For a zero-cost UI/lifecycle demonstration:

```bash
cd agent-code-web
npm ci
AGENT_ENABLE_MOCK=1 npm start
```

Open <http://127.0.0.1:8787>, connect GitHub (the local `gh auth login`, an
access token, or a configured OAuth device flow), and select repositories.
Choose Mock for a zero-provider-cost UI test. An initial prompt is optional;
Codex/Claude name the chat when they receive its first prompt. The model/effort
controls in the composer apply to the next message and persist per chat.

To reuse your existing local Codex or Claude login:

```bash
CODEX_AUTH_MODE=host CLAUDE_AUTH_MODE=host npm start
```

`host` mode is convenient for a local-only POC, but the CLI and its tools share
the user's credential trust boundary. Do not call this secret isolation.

## Guarded provider-key mode

An environment variable cannot be both usable by a process and hidden from
that same process. For that reason this mode does **not** inject either master
provider key into the agent. It injects only a revocable capability.

Export the key only into the control-plane process:

```bash
export OPENAI_API_KEY='...'
export ANTHROPIC_API_KEY='...'
export CODEX_AUTH_MODE=gateway
export CLAUDE_AUTH_MODE=gateway
npm start
```

The server replaces each real key with a random, in-memory, chat-scoped
capability before starting a worker. Only OpenAI Responses API paths and
Anthropic Messages API paths are accepted; those requests are authenticated
with the capability and forwarded with the real key by the control plane.
Provider request bodies are never logged.

On Linux, `AGENT_PROCESS_ISOLATION=namespace` also gives every worker a private
PID and `/proc` namespace. This prevents a worker from inspecting the parent
server's environment. It does **not** provide a private filesystem or network
namespace; production workers should be containers or VMs with outbound access
restricted to the credential gateway.

The capability itself is intentionally visible to the CLI. It is short-lived,
scoped to one chat and one provider, revoked when the worker stops, and is not
the long-lived provider secret.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_WEB_HOST` | `127.0.0.1` | HTTP bind address |
| `AGENT_WEB_PORT` | `8787` | HTTP port (`0` is useful in tests) |
| `AGENT_WEB_AUTH_TOKEN` | empty | UI/API bearer secret; mandatory on non-loopback binds |
| `AGENT_COOKIE_SECURE` | `0` | mark the browser session cookie Secure when served over HTTPS |
| `AGENT_IDLE_TIMEOUT_MS` | `300000` | completed-turn-to-worker-stop delay |
| `AGENT_DATA_DIR` | `./data` | persisted chats, workspaces, and CLI state |
| `AGENT_WORKSPACE_SOURCE` | empty | optional local repo/path cloned into every new chat |
| `AGENT_ENABLE_MOCK` | `0` | expose the deterministic Mock agent |
| `AGENT_WORKER_BACKEND` | `local` | `local` process workers or per-chat `ec2` workers |
| `AGENT_PROCESS_ISOLATION` | `namespace` on Linux | `namespace` or `none` for local workers |
| `CODEX_AUTH_MODE` | `gateway` | `gateway` or `host` |
| `CLAUDE_AUTH_MODE` | `gateway` | `gateway` or `host` |

## Chat organization

Use ☆ to pin a chat and ＋ beside Conversations to create a custom group.
Drag any chat into a group, or use its ⋯ menu → Move to group on mobile or
with a keyboard. Deleting a group never deletes chats: they return to their
automatic company/repository groups. Pins retain their underlying assignment.
The first selected repository determines the GitHub owner (company) and repo;
use ↑ in the repository chips to change the primary before creating the chat.
Legacy URL-based chats are grouped from their GitHub URL; scratch chats go
under Personal / No repository.

Sort within each section by creation time, last update (both directions), or
state: working, asking question, idle, PR not passing, PR open, PR merged, archived.
States are automatic and read-only: a gray dot indicates work, yellow indicates
an answer/approval is needed, and GitHub-style PR icons are green for open,
purple for merged, or red for failing/cancelled checks. Idle uses a hollow gray
dot. The chat menu explains the detected state and links its PRs.

Native Codex input/approval requests update immediately. Both agents also emit
hidden end-of-response metadata when waiting for an ordinary conversational
answer; this depends on the agent following the metadata instruction (questions
are not guessed from punctuation). It survives worker autosleep/restarts and
clears when the next user message arrives. No extra model call is required.

After each turn, the controller discovers PRs from non-default workspace
branches and GitHub PR URLs in assistant/tool output, scoped to the chat's
selected repositories (or legacy GitHub source URL). PR state is verified through
GitHub's API, never trusted from an agent's claim. Every minute it refreshes saved
branches/PRs, including while workers sleep; this does not boot EC2, extend idle
timers, or change last-updated sorting when nothing changed. Branch discovery
supports same-repository branches; fork PRs can be discovered by an emitted PR
URL. Detached HEADs have no branch to discover. Existing chats gain branch
tracking on their next completed turn; saved PR links can be tracked immediately.
Checks include GitHub Check Runs and commit statuses; pending checks stay green
with a pending explanation, not red. Tokens need repository pull-request,
checks and commit-status read access. Failed refreshes retain last-known state
and show a warning. Active work/questions take priority over PR milestones; any
open failing PR makes an otherwise idle chat red, and all tracked PRs must be
merged for the merged state. Closed, unmerged PRs return to idle.

The PR bar above the composer links to GitHub and shows additions/deletions.
Click the change count for a side-by-side file viewer (an overlay on mobile),
with file search and line numbers. Its source picker switches between GitHub's
PR diff and the last workspace snapshot, including unpushed changes. Snapshots
are captured after a turn without changing the Git index; opening the viewer
never wakes an idle worker. Large/binary patches can be omitted or truncated;
the viewer explains those limits. Local inspection includes up to 30 untracked
files per repository and at most 1 MB of patch text.

Open CI for passed, skipped, in-progress, and failed counts, a GitHub checks
link, and merge-conflict warnings. These come from GitHub, not model guesses.
Select **Auto-merge when ready** and confirm to enable GitHub's native auto-merge
for that specific verified PR. The repository must allow auto-merge and your
GitHub credential must have permission to enable it. GitHub enforces its branch
rules; this app never changes protection rules, bypasses checks, directly
merges, or force-pushes. The current PR head is verified before enabling.
Unchecking disables auto-merge. Refresh failures show the last verified state
with a warning. Auto-fixing CI/comments is not implemented and is disabled.

Archive/unarchive is a separate explicit action, not a state classification.
Archiving stops an idle worker and prevents new messages until unarchived; stop
a working turn first. Pins, groups, collapsed
sections, sorting, and settings survive reloads/restarts and sync across tabs.

## PostgreSQL and encrypted settings

By default a real embedded PostgreSQL instance starts on loopback port 55438.
The default control directory is `~/.local/share/agent-code-web`, outside chat
workspaces. It contains the database and an owner-only encryption-key/password
file. All application records (including GitHub credentials, environments,
preferences and conversations) use AES-256-GCM encryption with record-bound
authentication. Back up **both** the database and encryption key; losing the
key makes encrypted records unrecoverable. Old `chat.json` records are imported
on first start; original files remain as migration backups. Git workspaces and
CLI session files are not encrypted by this record layer.

For managed PostgreSQL, set `DATABASE_URL`, `AGENT_DATABASE_MODE=postgres`, and
`AGENT_ENCRYPTION_KEY` to a base64-encoded random 32-byte key kept in your secret
manager. Certificate-verified TLS is required for remote databases. Also enable
storage encryption/backups on your database host (for example encrypted RDS).
Embedded PostgreSQL requires a non-root user. `AGENT_DATABASE_MODE=memory` is
for tests only and deliberately does not persist anything.

Additional settings: `AGENT_CONTROL_DIR`, `AGENT_DATABASE_PORT`,
`AGENT_DATABASE_TLS` (may be disabled for localhost only),
`AGENT_GITHUB_LOCAL_CONNECT` (defaults on for loopback), and
`GITHUB_OAUTH_CLIENT_ID` (a GitHub OAuth app with device flow enabled).
GitHub expiry is saved when reported or supplied; unknown expiry is displayed
as such. A revoked token is invalidated on the next GitHub API request.

## Execution environments

Environments → Add environment creates a named profile for this server's
worker backend. Select software and edit key/visibility/value rows. Protected
values are masked until explicitly revealed and **never injected into agents**;
agent-readable entries are deliberately readable by the CLI and its tools.
Both are encrypted in PostgreSQL. A global toggle and per-variable toggles
control injection. Variable and package changes take effect on the next worker
start; stop an idle worker first to apply them immediately.

An optional Bash setup script runs after software provisioning and before the
agent starts, on each worker start. Only enabled **agent-readable** variables
are available to it; protected values are also excluded from setup scripts.
Do not embed secrets in a script or write them to an agent-readable file.
Script failure stops startup and is shown in the chat. Archive a profile to
hide it from new-chat selection without disrupting existing chats. The network
field is informational: custom network restrictions require infrastructure
enforcement and cannot be configured through this POC's UI.

Node 22, pnpm, Yarn and TypeScript install under private versioned per-chat
prefixes; Python creates a private virtualenv from the base Python 3 runtime;
jq installs a private binary. The host/image needs Node/npm, Git, curl, and
Python 3 with `venv` when selected. These are preinstalled by the worker image.
Changing a profile revision uses a new prefix. Workspaces and installed tools
remain on disk while workers sleep.

Docker Engine, Compose and Buildx are an optional **dedicated EC2 worker**
capability. The updated AMI installs them, and a readiness check enables the
daemon before a Docker-enabled chat starts. The control-plane Docker socket
is never shared, and local Docker is intentionally unsupported. Docker access
is root-equivalent **inside that chat's VM**; do not put master credentials,
other chats, or sensitive IAM roles there. Turning the checkbox off is not a
security revocation of access previously granted to the VM; replace/delete the
worker to revoke that access. Images, containers and volumes stop with the VM;
their EBS storage still costs money. No AWS resources are created by tests.

Local host-login mode remains a trusted POC: agents share the host filesystem
and can potentially reach local services. Encryption at rest and omitted env
variables alone do not isolate secrets from a same-user process. Use separate
worker VMs plus authenticated control-plane APIs for that boundary.

## Model selection

Codex options and per-model reasoning levels come from the installed CLI's
[`model/list`](https://developers.openai.com/codex/app-server/) response, not a
hard-coded GPT list. Claude uses supported CLI aliases (Fable when available,
Opus, Sonnet, Haiku) and levels advertised by `claude --help`. Haiku has no
effort picker. Claude account/provider policy may limit models or cap effort;
Fable may bill usage credits in non-interactive mode. See
[Claude model configuration](https://code.claude.com/docs/en/model-config).
Changing settings does not interrupt an active turn; they apply to the next
message. New selections default to **Sol/high** for Codex and **Opus/high** for
Claude. Override with `CODEX_MODEL`, `CODEX_EFFORT`, `CLAUDE_MODEL`, and
`CLAUDE_EFFORT`; saved explicit per-chat selections are retained. Unsupported
model selections fail visibly rather than silently switching models.

The composer agent selector switches an idle chat between Codex and Claude.
Stop active work first. Its chat ID, files, repositories, title, pins, groups,
and visible transcript stay intact. Switching starts a fresh provider-native
session on the next message, with up to 80,000 characters of recent conversation
and tool output passed as a handoff; it does not transfer provider-internal
context or reuse an incompatible session ID. Switching back also starts a
fresh session. The target provider's default model/effort are selected.

## Composer and session controls

- **Mode:** Claude uses native Auto, Accept edits, and Plan permissions. Codex
  uses documented collaboration modes and a read-only sandbox for Plan;
  Auto/Accept edits retain on-request approvals, not an approval bypass.
- **Effort:** a compact label opens a discrete slider and accessible selector
  for the chosen model's available levels.
- **Files/photos:** upload up to 10 files, 5 MB each and 20 MB total per message.
  Upload records are encrypted; files sent to an agent are deliberately readable
  in that chat's worker home. Codex receives supported images as local-image
  input; Claude can inspect uploaded files through its file-reading tools.
- **Slash commands:** type `/` to discover installed skills, plugin aliases and
  native commands; arrows navigate and Enter inserts. See Conversation controls
  below for the distinction between web actions and terminal-only commands.
- **Context/usage:** shows only CLI-reported token, cost, and account-limit data.
  Missing values are explicitly unavailable; Claude's cumulative token counters
  are not presented as current context usage. Manual compaction is available
  for an awake, idle Codex session; Claude manages compaction internally.
- **Connectors:** shows MCP servers reported by the CLI. The sidebar's MCP
  connections editor saves reusable connections for environments; OAuth login
  remains a CLI concern.
- **Repository menu:** open GitHub, copy branch names, or append repositories to
  an idle picker-based chat. The original primary repo/group stays unchanged;
  added repositories clone on the next message.
- **Chat menu:** organize/rename, show reported tools, open/copy workspace paths,
  copy a private chat link or transcript, edit its environment, archive, stop,
  or delete. Detached processes outside the CLI are not tracked as background
  tasks. Private links retain the server's existing authentication requirement.

## Verification

`npm run check` runs syntax, API, runtime, encrypted PostgreSQL restart, settings,
model and security tests. For browser tests: `npx playwright install chromium`,
then `npm run test:browser`. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to reuse an
installed Chromium. Browser fixtures use fake GitHub data and mock models.
`node scripts/smoke-titles.mjs` optionally runs one small, billable turn in each
locally authenticated CLI to check generated titles; it uses temporary chats.
`node scripts/smoke-workflow.mjs` verifies real CLI question handling and reads
this repository's PR state without changing it. Automated auto-merge tests use
fake GitHub responses and never enable auto-merge on a real PR.

## Actual EC2 autosleep

Local mode proves the UI and agent lifecycle, but stopping a process does not
reduce the bill of an otherwise running EC2 host. `AGENT_WORKER_BACKEND=ec2`
instead allocates one encrypted-EBS instance per chat, stops that instance after
the idle deadline, starts it on the next message, and terminates it when the chat
is deleted. See [`deploy/aws/README.md`](deploy/aws/README.md) for the no-secrets
worker AMI, IAM, network, and startup configuration.

The server does not parse `.env` files. This is deliberate: a secret file under
a worker-readable directory defeats the credential boundary.

## Workspace behavior

Each chat gets `data/chats/<chat-id>/workspace`. When a source is supplied, the
control plane clones it before starting the agent. Local Git repositories are
cloned without hardlinks; remote HTTPS/SSH repositories are cloned with
interactive prompting disabled. Clone credentials therefore remain a
control-plane concern and are not placed in the agent environment.

In EC2 mode that committed clone is uploaded once to the chat's encrypted EBS
workspace. Later stops and starts retain the remote workspace without recopying
it. When a repository is added, only its new directory is uploaded; existing
remote repositories and their uncommitted changes are not overwritten.

The POC persists the Codex thread id or Claude session id alongside browser
messages. Stopping a worker does not delete either its workspace or CLI session
state.

## Conversation controls

- User messages are right-aligned bubbles. Agent Markdown renders headings,
  tables, lists, links and fenced code, with code-copy buttons. HTML blocks have
  an opt-in preview in an opaque-origin iframe: generated scripts, forms,
  navigation and network resources are disabled; styles and malformed markup
  cannot escape into the chat UI.
- Each user turn has one **Tools used: N** row. Open it to inspect actual tool
  names, inputs, output, running state, failures and permission denials in a
  side panel. Missing results are not reported as successful execution.
- Type while an agent works and press Enter or **Queue**. The square **Stop**
  button interrupts the worker and pauses pending messages. Remove pending
  items or choose **Resume queue**. Queues persist through controller restarts
  and stay paused until explicitly resumed.
- `/` opens command/skill completion; type to filter, use Up/Down to select,
  and Enter or Tab to insert without sending. Claude reports installed commands,
  plugin aliases and native commands through its initialize response. Codex
  skills come from `skills/list`, and invoke the native structured skill input.
  Codex terminal-only commands are labelled as such; listing one does not imply
  the web client implements it. Web controls include `/usage`, `/model`,
  `/effort`, `/plan`, `/diff`, `/mcp`, `/skills`, `/stop`, `/rename` and `/archive`.
  Cloud discovery uses the last worker-reported catalog without waking a worker.
- Usage has a compact context/limits popover and a detailed session breakdown.
  Current context is distinct from cumulative tokens. Claude context includes
  the last main request's cache reads and writes; Codex cached input is already
  included in its input total. CLI cost is an API-price estimate, not a bill.
  Missing quota percentages and per-MCP attribution remain explicitly unreported.
  Historical records may have partial detail until new turns are collected.

## MCP connections

Use **MCP connections** in the sidebar to save a Streamable HTTP endpoint or
stdio command, then select it under **Environments → MCP connections**. Changes
apply on the next worker start. Both Codex and Claude receive per-worker MCP
configuration without modifying shared CLI config files.

HTTP authentication headers are encrypted in controller records and omitted
from settings responses and worker configuration. A revocable per-chat capability
proxies only the selected endpoint. Redirects are blocked, and credentials are
not forwarded to other hosts. Plain HTTP is supported only on loopback; remote
endpoints require HTTPS. OAuth login and legacy SSE transport are not implemented
in this connection editor. Connected MCPs are trusted services: they can return
sensitive data and their tools can perform actions.

Stdio commands run on the worker with its permissions and installed runtimes.
Do not include secrets in their arguments; protected stdio environment injection
is intentionally unsupported. Use HTTP for protected credentials. Local workers
still share the controller's OS account and filesystem, so encrypted storage
alone is not a strong boundary against a malicious local agent. Use dedicated
cloud workers when that boundary matters.

## POC boundaries

- This is a single-user control plane protected by one browser token, not a
  multi-tenant service.
- Local-process mode is for development. Use the separate EC2 worker boundary
  when the agent must not share the control-plane filesystem or OS account.
- Repository credentials are intentionally not copied into workers. Private
  push/pull from an active agent needs a separate short-lived Git credential
  broker.
- Codex and Claude are separate adapters behind the same runtime hooks
  (`start`, `send`, streamed events, `respond`, and `stop`). Another CLI agent
  can be added by implementing that small adapter contract.

## What “shutdown” means

The web control plane always stays reachable so it can receive the next
message. Local mode terminates only the per-chat CLI process and therefore does
not reduce the EC2 bill of its host. EC2 mode stops the separate chat worker
instance, which ends its compute billing while retaining the encrypted EBS
volume. Storage billing continues until the chat is deleted and the worker is
terminated.

## Verification

```bash
npm test
```

The integration suite starts the HTTP server with the Mock agent, creates two
chats, verifies independent streams and workspaces, waits through a shortened
idle window, and verifies worker stop/restart. Separate tests exercise the
Codex and Claude wire adapters, browser authentication, the credential gateway,
Linux PID isolation, and the EC2 start/stop/terminate command contract. Run
`npm run smoke:codex` for a no-model-call handshake against the installed real
Codex App Server.
