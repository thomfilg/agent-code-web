# Agent Web POC

A small web control plane for running Codex and Claude Code
from a browser. It is intentionally a POC, but the core lifecycle is real:

- any number of persisted chats;
- pinned chats, company → primary repository groups, custom drag-and-drop groups,
  and sorting by creation date, update time, or workflow state;
- connected GitHub repository/branch selection, reusable named environments,
  masked variable editing, and encrypted PostgreSQL records;
- per-chat model and effort selectors, with agent-generated conversation names;
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
state: working, asking question, idle, PR open, PR merged, archived. State
transitions from runtime events are automatic; explicit approval/input requests
mark a chat as asking a question. PR states are **manually tracked** through the
chat menu, not synchronized with GitHub PRs. They survive autosleep. Archiving
stops an idle worker and prevents new messages until unarchived; stop a working
turn first. Manual state changes don't launch a worker. Pins, groups, collapsed
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
message. Resetting defaults explicitly clears prior per-session overrides.

## Verification

`npm run check` runs syntax, API, runtime, encrypted PostgreSQL restart, settings,
model and security tests. For browser tests: `npx playwright install chromium`,
then `npm run test:browser`. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to reuse an
installed Chromium. Browser fixtures use fake GitHub data and mock models.
`node scripts/smoke-titles.mjs` optionally runs one small, billable turn in each
locally authenticated CLI to check generated titles; it uses temporary chats.

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
it.

The POC persists the Codex thread id or Claude session id alongside browser
messages. Stopping a worker does not delete either its workspace or CLI session
state.

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
