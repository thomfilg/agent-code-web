# Agent Web POC

A small, dependency-free web control plane for running Codex and Claude Code
from a browser. It is intentionally a POC, but the core lifecycle is real:

- any number of persisted chats;
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
cd agent-web-poc
AGENT_ENABLE_MOCK=1 npm start
```

Open <http://127.0.0.1:8787>, create a Mock chat, and send a message.

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
