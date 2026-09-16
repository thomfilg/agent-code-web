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
- interactive shared Chrome over an authenticated WebSocket, in a third column;
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
| `AGENT_IDLE_TIMEOUT_MS` | `300000` | inactivity-to-worker-stop delay, paused while a chat tab or browser viewer is active |
| `AGENT_DATA_DIR` | `./data` | persisted chats, workspaces, and CLI state |
| `AGENT_WORKSPACE_SOURCE` | empty | optional local repo/path cloned into every new chat |
| `AGENT_ENABLE_MOCK` | `0` | expose the deterministic Mock agent |
| `AGENT_WORKER_BACKEND` | `local` | `local` process workers or per-chat `ec2` workers |
| `AGENT_PROCESS_ISOLATION` | `namespace` on Linux | `namespace` or `none` for local workers |
| `AGENT_CHROME_BIN` | `google-chrome` | Chrome executable in the worker; never a personal profile path |
| `CODEX_AUTH_MODE` | `gateway` | `gateway` or `host` |
| `CLAUDE_AUTH_MODE` | `gateway` | `gateway` or `host` |

## Shared Chrome

Open **Browser** in a chat’s top-right toolbar. The desktop view is a third
column; narrow screens use an overlay. You and the agent see and interact with
the same page. The address bar accepts `http://localhost:3000` or another dev
server port: localhost belongs to the chat’s worker, including EC2 workers.
The site’s WebSockets/HMR run in Chrome normally. This is an interactive live
view, not a reverse proxy that puts untrusted website HTML on Relay’s origin.

**Open directly** and **Copy URL** open the app in your own browser. With Relay
and local workers on your computer, `http://localhost:3000/path` becomes
`http://chat_<id>.localhost:3000/path`. The port, path, query and fragment are
preserved, and the new tab has no opener. These are local aliases with distinct
browser origins, **not network isolation or authentication**. Local workers
still share host ports. Remote-worker localhost links are not advertised as
working direct links: they require port forwarding, so use Shared Chrome there.

The viewport picker offers xxs (320×640), xs (390×844), sm (640×960),
md (834×1112), lg (1280×800), xlg (1920×1080), and custom dimensions.
Resizing restarts capture on the same page without navigation. Live PNG frames
retain 2× pixel density for the presets; very large custom views use 1× to bound
bitmap memory. The canvas does not upscale a phone viewport to fill a desktop
panel. Capture, navigation, input and resize operations are serialized, and
only one frame is decoded at a time. Desktop column dividers can be dragged
or resized with arrow keys; widths are saved in this browser.

Both agents receive the built-in `relay_browser` MCP server when their worker
starts. It provides navigation, accessibility snapshots, screenshots, clicks,
typing, tabs, viewport sizing and page JavaScript evaluation. The browser starts
on demand, without an extra model request. Ask the agent to run a dev server and
open it with `browser_navigate`; use the Browser column to test it yourself.
Click the page to type, or paste text. Escape returns focus to the address bar.

Each chat starts with a fresh, separate Chrome profile. It does **not** import
your personal Chrome cookies or passwords. Closing the panel disconnects only
the viewer; Chrome sleeps after inactivity. An open viewer keeps the browser
and an otherwise-idle agent worker awake. **Stop Chrome** discards the separate
profile; **Stop worker** also revokes the browser tool capability. Inspecting
browser status does not wake a worker. Tab content and typed input are not
automatically added to the transcript; explicit agent tool results can be.

A visible chat tab pauses its worker's sleep countdown, even without an open
Chrome panel. Leaving the tab starts a fresh idle period. Presence leases
expire after a disconnect and never wake a stopped worker, invoke an agent, or
send browsing activity into the conversation. Hidden browser panels stop their
live stream until the tab becomes visible again.

Paste clipboard images/files in the composer to attach them. Click an image
attachment to preview it in the document column (an overlay on narrow screens),
with fit/actual-size controls and a separate remove action. Saved attachments
remain previewable after the worker stops and are authorized against their chat.
Long conversations mount at most 60 conversation rows at a time; the message
navigator and earlier/newer controls can bring older rows back into view without
deleting saved history. The complete transcript is still loaded in client state.

Chrome uses its native sandbox and private debugging pipe descriptors. No CDP,
VNC or worker web port is exposed publicly. WebSocket upgrades require the UI
login and a same-origin browser request; the MCP endpoint accepts only a
short-lived, chat-scoped agent capability. Local workers still share the host
filesystem/network trust boundary described above; this is not multi-tenant
isolation.

**Chrome installation:** the environment catalog includes Google Chrome. It
uses an installed system Chrome/Chromium, or downloads Chrome for Testing into
the worker’s private runtime directory through the pinned official Puppeteer
browser installer. Node/npm, unzip and Chrome system libraries are required.
The Ubuntu 24.04 amd64 AMI recipe installs Chrome and its libraries. Existing
AMIs need rebuilding; selecting Chrome cannot add system packages with sudo.
No sandbox-disable fallback is used. A custom binary can be selected with
`AGENT_CHROME_BIN`. Installation runs in the worker, not in your personal Chrome.

### Optional signed-in personal Chrome

The top-right **Signed-in Chrome** switch is **off by default**. Normal browser
tools always use the separate guest profile until you explicitly authorize a
saved personal connection for that chat. Pairing alone never grants access.

1. Open **Browser connections** in the sidebar. Create or sign into your private
   Relay account. This is a separate username/password, **not** your Google login.
2. Download and extract the extension ZIP from that dialog. In your personal
   Chrome, open `chrome://extensions`, enable Developer mode, select **Load
   unpacked**, and choose the extracted `agent-relay-chrome` folder. Installation
   is manual; Relay cannot silently install an extension in your personal profile.
3. Name the connection and generate a five-minute, single-use pairing code.
   Open the extension and enter Relay's origin (for example,
   `http://127.0.0.1:8787`) and that code. Use HTTPS for non-loopback deployments.
4. Sign into websites normally in that Chrome profile. The logins stay in Chrome;
   Relay never exports its cookies, passwords, or profile files into a worker.
5. In a chat, turn on **Signed-in Chrome**, choose your saved connection, and
   confirm the permission. An existing shared chat becomes private to your
   account first; its transcript/workspace stay intact and its queue stays paused.
   Stop a running agent before claiming a shared chat. Chats created while signed
   into a private account are private from creation.

Sharing creates one separate automation tab in that profile; existing personal
tabs are never listed or controlled. The Browser column and `relay_browser` MCP
tools both operate on this tab. Chrome displays its native debugger warning and
the extension badge shows **ON**. The agent can read and act on websites using
your logins, so enable it only for trusted work. Sign-in popups should be used in
your normal tabs before sharing; automation popups are closed to keep access
confined to one tab.

Turning the switch off invalidates pending tool results, disconnects personal
viewers, and closes the automation tab. It returns tools to guest Chrome without
signing you out of websites. The extension's **Stop agent access**, closing its
automation tab, disconnecting, signing out of Relay, stopping the worker, or
permission expiry also revokes access. Changes already made on a website cannot
be undone by revocation. Sharing expires after `AGENT_CAPABILITY_TTL_MS` (one hour
by default), or sooner if the private account session expires.

Each user sees only their own saved connections and private chats through the
API, sidebar, transcript stream and browser viewer. Passwords use salted scrypt;
account sessions and connection hashes live in Relay's encrypted control-plane
database, outside workers. The extension saves its connection token in local
extension storage, not Chrome Sync. Saved pairing and website logins survive
restarts, but active agent permission **never** survives a controller or Chrome
reconnection. You must enable it again.

**Localhost differs by mode:** guest Chrome reaches the worker's development
server, including when the worker is remote. Personal Chrome runs on **your
computer**, so its localhost is not an EC2 worker. Use guest mode for remote
worker previews, or a development URL already reachable from your computer.
Personal automation also blocks Relay's own hostname (on every port) to protect
the account controlling its permissions; use guest mode for that hostname.

Private browser accounts enforce application authorization, not hostile-tenant
isolation of local CLI processes. Local workers still share the controller's
OS/filesystem trust boundary. Host administrators and untrusted local agent code
must not be treated as separate tenants; use dedicated worker infrastructure for
that boundary. The AMI Chrome recipe is included, but cloud deployment requires
building/deploying your worker image separately.

Verification: `npm run check` includes a real extension test in a fresh Chrome
profile (requires `npx playwright install chromium`). It exercises account and
pairing UI, explicit consent, live MCP/viewer access, off/revoke, and persisted
pairing/login after Chrome and Relay restart without making model calls.
`npm run test:browser` covers interactive guest Chrome on desktop/mobile;
`npm run smoke:mcps` verifies both real CLIs discover the browser tools without
running a model turn.

## Chat organization

Use ☆ to pin a chat and ＋ beside Conversations to create a custom group.
Drag any chat into a group, or use its ⋯ menu → Move to group on mobile or
with a keyboard. Deleting a group never deletes chats: they return to their
automatic company/repository groups. Pins retain their underlying assignment.
The first selected repository determines the GitHub owner (company) and repo;
use ↑ in the repository chips to change the primary before creating the chat.
Legacy URL-based chats are grouped from their GitHub URL; scratch chats go
under Personal / No repository.

Chats use a single compact row: status icon, title, pin, and organize menu.
Status details and timestamps remain available on hover and in Organize chat.
Choose **Organize chat → Delete chat** to permanently remove that chat, messages,
attachments, and workspace after confirmation. A running worker is stopped first.
Archive remains available when you want to keep the chat instead. Deleting a
different chat does not disturb the active conversation or its draft.

`POST /api/chats/:id/copy` (optional JSON `title`) makes a stopped transcript copy
for rendering or a fresh conversation. It preserves message and tool history,
but does not copy workspace files, attachment contents, runtime sessions,
environment connections, queued prompts, usage counters, or PR automation.

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

### Company availability and credential separation

GitHub connections, environments and MCP connections each have an **Available
companies** selector. Check several owners (for example `12-apps` and `thomfilg`)
without granting access to `g2i` or `umg`. Add missing owner names in the form.
The chat's first repository determines its company; moving its sidebar group or
adding secondary repositories never changes that authorization scope.

Save separate GitHub and MCP connections for different accounts. Repository
selections retain their GitHub connection ID. A credential must allow both the
repository's owner and the chat's primary company before Relay can clone it or
read/update its PRs. Ambiguous GitHub matches require an explicit connection;
Relay never silently tries another company's token. Clone authentication is
transient and restricted to the exact repository URL.

An empty company list grants no company access. **Unassigned chats** explicitly
allows scratch workspaces, not every company. Legacy global credentials remain
saved and encrypted but require an explicit company selection before reuse;
old singular MCP organization scopes migrate to the same single company.
Removing a company or MCP selection revokes existing HTTP MCP grants and streams
immediately; adding connections and changing worker software/setup/public
variables takes effect on the next worker start. Already copied files and public
variables cannot be retroactively removed from a running process.

These checks separate configuration and credential use within Relay; they are
not a filesystem sandbox between repositories in one workspace or separate
control-plane administrator accounts. The existing explicit host-auth/local
worker limitations still apply. If new forms are loaded from an older running
backend, saves fail closed until the backend supports company scopes.

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
  below for command behavior and the remaining native-command coverage checklist.
- **Side chat (Codex):** `/side [question]`, `/btw [question]`, or **Side chat**
  opens a native temporary fork in the resizable third column (overlay on phones).
  It inherits the main context and shares its workspace and selected permissions,
  but has independent replies, questions, and stop controls. Main work continues.
  Attachments included with an inline side question go only to that side thread.
  Hiding/reopening the panel retains it; **End side chat** or stopping the worker
  discards its temporary conversation, not any shared workspace edits. Reading or
  refreshing its state never wakes a worker. Nested side chats and opening a side
  chat during native review are not supported by Codex.
- **Fork (Codex):** `/fork [optional title]` creates an independent conversation
  and workspace while the original can keep running. Sent attachments, native
  context and company/environment/model settings are retained; unsent queues,
  approvals and signed-in Chrome grants are not copied. An inherited goal waits
  for the first non-Plan message; Stop or pause cancels that deferred activation.
  Retrying a failed request preserves the draft and cannot create duplicate forks.
  Native history stays in private controller storage. Workspace copying is
  bounded and requires self-contained files/Git repositories; external links,
  linked worktrees, concurrent writes and oversized copies fail explicitly rather
  than silently dropping content. No fake message is sent to fork an empty chat.
- **Agent threads (Codex):** `/agent` or `/subagents` opens a picker of this
  chat's native child agents. View paginated messages, answer child questions,
  send follow-ups or stop a selected child without replacing the main chat.
  Active replies receive native steering; idle agents receive a new native turn.
  Parent ancestry is verified, so a shared native profile or session ID cannot
  expose another chat's threads. Viewed messages have bounded, encrypted
  controller snapshots that remain readable while the worker sleeps. **Connect
  to agents** refreshes native state; reading a saved snapshot does not wake it.
  Running children and pending child requests keep the worker awake.
- **Workspace context:** use **+ → Workspace files & selections**, `/mention
  [path]` or `@path` to choose real files/folders in this chat's worker. The
  read-only viewer supports text selections; **Use open files as context** or
  Codex `/ide [optional task]` attaches the open files and active selection.
  Nothing reaches the agent until you send or queue a message. Captured context
  survives in queued/sent attachments, outside the disposable worker; changed
  files must be reopened before capture. Files over 512 KiB are path-only
  references. This is Relay's viewer, not a connection to an external editor.
  Connecting may wake the worker but never starts an agent turn.
- **Native apps (Codex):** `/apps` searches the current native thread's apps.
  Selecting an available app inserts its `$app-name` token and a saved reference
  into the draft; it does not send input, install anything or change credentials.
  Sending/queueing uses native structured app mentions. Access and callable policy
  are checked again at dispatch, and references cannot cross chat, native-session,
  owner or company boundaries. Historical references copied into a fork are not
  permission grants: select the app again there. The picker uses the existing
  Codex account and does **not** solve inherited host-profile credential isolation;
  that audit remains queue item 21. It does not load remote app icons or installation
  links. `node scripts/smoke-real-apps.mjs` checks installed protocol compatibility
  with a private unauthenticated profile and zero model calls; authenticated app
  invocation still requires account-specific acceptance.
- **Native plugins (Codex):** `/plugins` opens searchable marketplace tabs and
  plugin details. Private chat profiles can install, enable, disable and remove
  plugins after confirmation while the chat and its agents are idle. Shared
  host profiles are inspection-only: native company/account isolation remains
  item 21, not permission to edit global host settings. Native managed-policy and
  consent restrictions are preserved. Actions use the supported CLI, reload
  native configuration and refresh installed skills without restarting Chrome or
  sending an agent message. Interrupted changes must be reconciled by Refresh
  before the agent continues. `node scripts/smoke-real-plugins.mjs` exercises the
  real CLI against a private local marketplace with no host account or inference;
  remote authenticated marketplace acceptance remains unverified.
- **Native hooks (Codex):** `/hooks` filters lifecycle hooks by event or text and
  shows their source, command or MCP handler, trust and enabled state. In private
  chat profiles, review the source before explicitly trusting its exact native
  definition hash; enable/disable are separate confirmed actions while idle.
  Managed hooks cannot be changed. Shared host profiles hide executable details
  and remain read-only pending company/profile isolation (item 21). Native MCP
  metadata omits argument templates, so inspect the source file before trusting
  those hooks. Refresh reloads an idle private worker's cached definitions;
  changed definitions need trust again. Opening the browser may wake the worker,
  but does not send agent input or grant trust. Existing trusted lifecycle hooks
  still follow native policy. `node scripts/smoke-real-hooks.mjs` verifies real
  command and MCP hook execution, trust changes, disabling, persistence and
  command/argument source reload with a private profile and loopback fixtures,
  not a host account.
- **Experimental features (Codex):** `/experimental` lists the current native
  session's beta flags, including their descriptions, configured state and
  defaults. Private chat profiles can enable or disable a flag after confirmation
  while the chat and its agents are idle. Managed requirements and higher-priority
  project/session/profile settings stay locked; shared host profiles are read-only
  pending item 21. Changes are persisted and verified through the native config
  API. Some need an agent restart to take full effect; the picker explains this
  but does not restart a worker or Chrome, or send an agent message. Network proxy
  does not grant sandbox network access, and native sleep prevention is separate
  from Relay's idle-container timer. `node scripts/smoke-real-features.mjs` checks
  the real CLI, restart persistence and trusted project overrides in a private
  temporary profile without inference or host-account changes.
- **Native memories (Codex):** `/memories` controls local memory enablement,
  use and generation in this chat's private native profile. Use changes affect
  later native sessions; generation choices also update the current chat's
  contribution preference. Existing conversation context is not erased. Native
  startup consolidation can use quota even when new chat contributions are off;
  Local memories is the separate feature switch. Reset requires confirmation
  and deletes only that private profile's memory files and summaries, keeping
  conversations and settings. Memories can be recreated while the feature or a
  background pass remains active. Shared host profiles are read-only pending
  company isolation (21), and managed overrides cannot be changed. No control
  sends a user message or automatically restarts the worker or Chrome.
  `node scripts/smoke-real-memories.mjs` verifies actual native summary injection,
  current-thread contribution state, persistence, startup consolidation and
  reset isolation using private profiles and loopback-only model responses.
- **Native import (Codex):** `/import` reviews supported Claude Code or Cursor
  setup and recent conversations from this worker's workspace/private profile.
  Select whole setup groups or individual conversations, then confirm. Results
  distinguish imported, failed and unreported items; interrupted operations are
  reconciled without automatically repeating them. Shared host profiles remain
  read-only pending company isolation (21). **Open chat** separately confirms an
  independent, stopped Relay chat with a copy of the current workspace and its
  native history. It sends no message, preserves source files and unsent drafts,
  and does not copy personal accounts or profile-level settings. Continue the new
  chat explicitly when ready. Unsupported source content may become native text
  markers (the installed Claude importer does this for images); warnings retain
  that limitation. External image URLs and outside-workspace files are not fetched.
  `node scripts/smoke-real-import.mjs` and
  `node scripts/smoke-real-import-chat.mjs` verify the real CLI, recovery,
  independent history, source deletion and native resume in private fixtures.
- **Retry a denied action (Codex):** `/approve` shows this native session's
  retained automatic-review denials without waking its worker. Review the
  action and confirm to queue one retry; busy chats retain FIFO order and a
  paused queue stays paused. Codex records the native approval, then receives
  an explicit request to retry that exact action under the current policy.
  Permissions are not broadened, pending approval prompts are not accepted,
  and automatic review may still deny the retry. The draft and its attachments
  stay untouched. Encrypted review records are bound to the owner, project and
  native session. Interrupted/uncertain approvals or possibly-started retries
  are not repeated automatically. Denials predating capture cannot be recovered
  from ordinary chat history. `node scripts/smoke-real-approve.mjs` verifies the
  actual CLI using isolated profiles, deterministic loopback main/reviewer
  responses and a harmless print command; it uses no real account or model.
- **Native feedback (Codex):** `/feedback` opens a report dialog without sending
  anything. Explicitly check the worker's policy, write and review the report,
  then confirm **Send feedback to OpenAI**. Logs are off by default; native
  session/version and diagnostic/authentication metadata are still included.
  Opted-in diagnostics may contain conversation/code, native logs and file paths;
  they are collected at send time, not previewed or redacted by Relay. Shared
  host logs are blocked pending company isolation (21); private diagnostic
  storage must stay within the profile's configured roots. Current, managed and
  startup policy are checked. Changing startup configuration requires an
  explicit worker restart; the control never restarts it automatically.
  Draft text and files are not sent to the agent or attached to the report.
  Reviewed reports expire after five minutes and are bound to this owner,
  project, native session and worker. Uncertain uploads are never automatically
  repeated; refresh saved status before creating another report. The native
  session reference is not an independent external receipt.
  `node scripts/smoke-real-feedback.mjs` tests actual Codex with private profiles
  and a local TLS receiver in a network-isolated Linux namespace; no report or
  diagnostic data reaches OpenAI during the check.
- **Keyboard shortcuts:** `/keymap` or **Chat actions → Keyboard shortcuts**
  opens Relay's web keymap. Edit global or main-composer bindings, use several
  alternatives, leave a field empty to unbind a Relay action, or restore defaults;
  only **Save shortcuts** applies changes. Composer bindings override global
  bindings, while slash/file pickers retain their own navigation keys. The
  editor detects duplicate bindings and protects standard browser/text-editing
  shortcuts. Normal textarea editing remains available when an action is unbound.
  Signed-in Relay accounts have separate saved preferences; without a private
  account, the editor explicitly identifies the shared installation preferences.
  Reload conflicts retain the unsaved shortcut draft. This is a web equivalent:
  it does not edit a remote terminal's `tui.keymap` or native `config.toml`, wake
  a worker, submit a prompt, answer an approval or change permissions. Side-chat,
  child-agent and Shared Chrome keyboard input are not remapped by these controls.
- **Native sign-out (Codex):** `/logout` opens saved status without waking the
  worker. **Inspect native account** explicitly connects this chat, without an
  agent message or token refresh. A separate confirmation clears only reviewed
  private native credentials using Codex's own logout operation and pauses queued
  messages. It does not revoke API keys, sign out of Relay/Chrome, disconnect
  GitHub/MCPs, delete history/workspace/drafts, or remove Relay gateway access.
  Sign-out requires idle main/side/native agents. Reviews expire after five
  minutes; credential, profile, policy and worker changes invalidate consent.
  Lost replies and interrupted operations stay uncertain, never automatically
  retried. Shared host profiles and OS keyring/automatic storage remain locked
  pending company/profile isolation. Gateway providers may hide in-memory native
  accounts; those are locked when removal cannot be verified. Config changes do
  not silently restart workers. `node scripts/smoke-real-logout.mjs` exercises the
  real CLI with disposable dummy accounts and loopback-only network isolation;
  no live account, OS keyring or external authentication service is touched.
- **Context/usage:** shows only CLI-reported token, cost, and account-limit data.
  Missing values are explicitly unavailable; Claude's cumulative token counters
  are not presented as current context usage. **Compact session** sends
  `/compact` without changing the composer draft. It remains available while
  working, queues behind the current turn, and wakes a stopped session when
  dispatched. Codex uses native `thread/compact/start`; Claude receives its
  native `/compact` command. A paused queue stays paused until resumed.
- **Connectors:** shows MCP servers reported by the CLI. The sidebar's MCP
  connections editor supports presets, custom servers, browser OAuth and tool
  discovery. Select saved connections separately for each environment.
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

- The composer uses grouped, higher-contrast controls and a responsive toolbar.
  The `/` picker shows command descriptions, source types, and keyboard hints;
  arrows select, Enter/Tab insert without sending, and Escape dismisses it.
  Loading, empty, and error states never select a stale command.
- User messages are right-aligned bubbles. Agent Markdown renders headings,
  tables, lists, links and fenced code, with code-copy buttons. **Open preview**
  opens HTML, Markdown, SVG, or plain text in the third desktop column, sharing
  space with Workspace changes and tool activity (one panel at a time). Narrow
  screens use an overlay with a close button. Transcript view uses this panel
  too. Previews support expand/restore, source copy, and Escape; live chat updates
  do not replace an open document. HTML has readable default typography, spacing,
  and striped, bordered tables; its own CSS can override these defaults.
  Rich previews use an opaque-origin iframe: generated scripts, forms,
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
  `/goal` uses persisted native goals; `edit`, `pause`, `resume` and `clear` work
  without substituting ordinary prompts for goal controls. `/review` starts the
  native reviewer, optionally with `--base <branch>`, `--commit <SHA>`, or custom
  instructions. `/init` asks the agent to create or improve repository instructions.
  `/model <id>`, `/effort <level>` and `/permissions <auto|edits|read-only>` queue
  validated settings behind running work. `/fast` and `/personality` are offered
  only when the selected model advertises support. Web actions also cover usage,
  diff, MCPs, attachments, copying, transcript display and chat organization.
  `/stop`, `/quit` and `/exit` stop Relay's agent and pause the queue; they are not
  limited to native background terminals. Destructive chat deletion asks for
  confirmation. [The command coverage checklist](docs/command-support.md) records
  the still-unimplemented commands; listing or hiding a command is not a fix.
  Cloud discovery uses the last worker-reported catalog without waking a worker.
- Usage has a compact context/limits popover and a detailed session breakdown.
  Current context is distinct from cumulative tokens. Claude context includes
  the last main request's cache reads and writes; Codex cached input is already
  included in its input total. CLI cost is an API-price estimate, not a bill.
  Missing quota percentages and per-MCP attribution remain explicitly unreported.
  Historical records may have partial detail until new turns are collected.
- Context/usage snapshots and inspected account-limit metadata are saved in the
  controller database, outside worker storage. Stopped workers show the last
  recorded values and timestamp without waking. This is a usage snapshot, not a
  live count while offline. Native conversation transcripts use the existing
  workspace/session persistence; this feature does not invent missing counters.
- In the composer, Up from empty text (or the first character) recalls previous
  user messages. Down at the end moves forward and eventually restores the draft.
  Normal multiline cursor movement, text selection, and slash-menu arrows retain
  their behavior. Drafts/history navigation are isolated per chat.
- Hover or focus the right-side message rail to see your messages; tap on touch
  screens. Select a preview to jump to that message. Escape closes the list.

## Live updates and transport

Chat and sidebar updates use Server-Sent Events (`EventSource`) with automatic
reconnection. Shared Chrome frames and input use an authenticated WebSocket.
Message submissions and configuration changes use ordinary HTTP requests.
Provider PR/check status is polled separately by the controller.

Agent questions appear as clickable choices above the composer, with a free-text
answer and a Skip action. Alt+Up focuses the question card. Live status updates
preserve unfinished answers; choosing an option does not submit until Send answers.

## MCP connections

Use **MCP connections** in the sidebar. Choose Linear, Atlassian (Jira/Confluence/
Bitbucket), GitHub, Sentry, Figma, Notion or Context7, or choose **Custom MCP** for
any compatible Streamable HTTP endpoint or stdio command. Presets only fill the
form; they do not grant account access. Save, connect/test, then select the saved
connection under **Environments → MCP connections**. Changes
apply on the next worker start. Both Codex and Claude receive per-worker MCP
configuration without modifying shared CLI config files.

Use **Available companies** for one or several primary-repository owners. You
can save `linear` for `12-apps` and `thomfilg`, and another `linear` for `g2i`,
then complete OAuth separately; tokens, connection health and disconnect actions
are independent. Equal names require non-overlapping company lists. Select both
in an environment if it serves those companies. Worker startup grants only the
selected MCPs allowed for that chat's **first** repository owner. Scratch chats
receive only explicitly selected **Unassigned chats** connections. Neither a
blank company list nor a legacy global connection grants all-company access.

### Browser OAuth (including custom servers)

For example, choose **Custom MCP**, enter `https://paladira.com/api/mcp`, select
**OAuth**, and save. Click **Connect with OAuth**, sign in and approve the requested
access in the opened browser window. Successful consent triggers a connection
test and tool discovery. Choose it in an environment to enable it for that
environment's next Codex or Claude worker. MCP initialization alone is not proof
of authentication: some servers allow it before sign-in.

OAuth uses the official MCP SDK's discovery, dynamic client registration, PKCE
S256 and refresh-token flow. Tokens and client secrets are encrypted at rest and
never returned to the frontend or worker. Expiring tokens refresh on the controller.
Callback state is single-use, browser-cookie-bound, issuer-checked and expires
after ten minutes. Restarting the controller during sign-in requires trying again.
Changing a connection or disconnecting invalidates its existing worker grants.
Disconnect removes local OAuth tokens; revoke the app in the provider's account
settings too if you want to remove the provider-side grant.

For remote deployments, set `AGENT_WEB_PUBLIC_URL=https://your-relay-host` and
`AGENT_COOKIE_SECURE=1`. The callback is `/oauth/mcp/callback` on that origin.
Loopback callbacks work without extra configuration. Providers without dynamic
registration require an OAuth client ID (and sometimes a secret) in **Advanced
OAuth settings**; register the exact callback shown there. A provider's app/domain
allowlists may require administrator approval. GitHub's preset uses a PAT header;
it does not reuse an unrelated CLI OAuth client. Context7's preset allows anonymous
access; higher limits may require an authentication header.

**Test connection** performs MCP initialization and lists tools; it never calls
tools. It distinguishes connected, sign-in required, failed and untested states.
Stdio connections are checked by the actual worker, not executed on the controller.

HTTP authentication headers are encrypted in controller records and omitted
from settings responses and worker configuration. A revocable per-chat capability
proxies only the selected endpoint. Redirects are blocked, and credentials are
not forwarded to other hosts. Plain HTTP is supported only on loopback; remote
endpoints require HTTPS. Legacy SSE transport is not supported by this editor;
use the provider's Streamable HTTP endpoint. Connected MCPs are trusted services: they can return
sensitive data and their tools can perform actions.

Stdio commands run on the worker with its permissions and installed runtimes.
Do not include secrets in their arguments; protected stdio environment injection
is intentionally unsupported. Use HTTP for protected credentials. Local workers
still share the controller's OS account and filesystem, so encrypted storage
alone is not a strong boundary against a malicious local agent. Use dedicated
cloud workers when that boundary matters.

`npm run smoke:mcps` checks selected HTTP and stdio MCPs using the installed real
Codex and Claude CLIs, isolated temporary configuration, and a local fixture. It
does not make model calls, use account credentials, or modify shared CLI config.

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
