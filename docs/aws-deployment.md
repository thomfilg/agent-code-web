# AWS MVP operations

Latest authorized publication (2026-09-19 21:07 UTC): source `d7814e5`, immutable
image `sha256:d906684922d53a53a507708dfdd94795fbe112f01e99652bcb48844833b0ba21`.
The full integrated Node suite passed **1,595/1,595** before build. Because one
reported Claude chat was permanently busy in the old controller, the normal
busy-drain gate correctly refused an automatic interruption. The user then
explicitly ordered the deployment. A reviewed one-shot maintenance wrapper
used the same pinned rollout engine, exact stack/controller/data-volume and
host lock; it pulled and validated the new image and secret before stopping the
exact old container. The old controller exited by SIGTERM (143), not OOM or the
120-second SIGKILL fallback. The standard engine then retained it as rollback,
started the new immutable image and passed readiness. SSM command
`202e6773-6b93-428d-9e17-658f7fab90d7` completed Success/0.

Read-only encrypted-record fingerprints before and after publication matched
all three chats' message arrays, queued-message arrays and native session IDs.
The affected chat retained 78 messages and its one queued message. No chat,
account, browser profile, worker instance or data volume was deleted. The raw
persisted status remains the pre-restart value, while normal `ChatStore`
restoration presents every disconnected chat as stopped and pauses a nonempty
queue; no queued prompt is replayed automatically. The affected EC2 worker
remained running and can be reattached rather than recreated. Post-publication
checks matched the running image, four source/public hashes and three public
assets; readiness returned 200, anonymous chats 401, and all 13 fixed Git/MCP
denial probes passed without provider calls. This receipt does not claim that
the historical wire event can be reconstructed: its journal omitted the
notification flags needed to prove the exact past sequence. The synthetic
regression reproduces the observed stuck state and the source defect consistent
with it; see [ambient workflow notifications](claude-ambient-workflow-notifications.md).

Automatic-deployment requirement (2026-09-18): automatic publication must
preserve already-running worker instances and their work. The current shutdown
path does not satisfy that requirement, so the existing workflow remains
manual-only and off by default. Today's manually operated update may interrupt
workers under the user's explicit setup authorization; that is not permission
for future disruptive automation. See [the required continuity gate](adr/2026-09-18-automatic-rollouts-preserve-workers.md).

Latest application publication (2026-09-18, verified 18:40 UTC): runtime
`b89269a` adds prompt-free environment wake and immediate deletion feedback.
Rollout SSM `e8941890-07f8-4aa9-b96a-b74929d4398d` completed Success/0; an
independent check matched the running immutable image, all five changed public
assets, readiness and 13 denial probes. No workers existed before/after this
manual rollout. [Exact receipt and limits](validation-2026-09-18-runtime-controls.md#aws-publication--independently-verified-at-1840-utc).
The newly chosen two-minute hibernation/manual-only full stop policy is not
activated by this release; it needs compatible-image and process-resume proof.

Previous application publication (2026-09-18 17:41 UTC): build source `28654d6`
(runtime `79d66cc`) adds Shared Chrome streaming/input improvements, remote
reload shortcuts and explicit plain-text clipboard. Rollout SSM
`609c230c-af33-4e41-bcce-6426341f59ae` completed Success/0. At 17:43 UTC,
independent checks confirmed the actual running immutable image, public
readiness, all three changed public assets and 13 fixed GitHub denial probes.
The authorized manual restart stopped the one running worker; no data, worker
instance or volume was deleted. This does not satisfy the future automatic
continuity gate. See [the image, source and verification receipt](validation-2026-09-18-browser-interaction.md#aws-publication--independently-verified-at-1743-utc).

Current product clarification (2026-09-18): the GitHub company-selection step
described in historical receipts below is superseded by
[provider-authorized repository access](adr/2026-09-18-github-provider-permissions.md).
The refinement is included in verified runtime revision `e7689a7`, published
at 16:05 UTC together with the chat auto-follow and native Claude catalog fixes.
Existing saved connections work without migration or new consent. Other user/agent/
environment/MCP and selected-worker-repository boundaries remain enforced.
See [the exact rollout and validation receipt](validation-2026-09-18-chat-ui.md).

At 14:45 UTC the user reported successful deployed chat creation and supplied a
Personal Codex/Luna response screenshot under `12-apps/future-pay`. This is
user-reported real execution evidence, not a fixture or operator-submitted
prompt. Claude execution, restart/resume, Linear and preview remain separate
acceptance gates.

Deployment target authorized on 2026-09-18:

| Setting | Value |
| --- | --- |
| Operator profile | `code-web` |
| Account / region | `456808212788` / `us-east-2` |
| Application stack | `agent-relay-mvp` |
| Public origin | `https://d20atclccf8cku.cloudfront.net` |
| Deployment secrets | Doppler `code-web/stg_aws_mvp` → one AWS Secrets Manager secret |
| Shared rollout engine | `12-apps/ci` commit `848182b33461640e9ac0feb7315f747a67877c88` |

This is a private, single-AZ, single-controller MVP, not a highly available
service. Updates have a short maintenance gap. A new VPC/NAT/private controller
and private per-chat workers are separate from unrelated account resources.
No domain purchase is needed. See [ADR 0002](adr/0002-aws-mvp-isolation.md) for
costs, authority, security boundaries and limitations.

## Operator setup and infrastructure

Use an authenticated CLI session; never put AWS root/access credentials in an
image, workflow secret, worker or application environment. The initially
authorized root CLI session is bootstrap-only. Production uses instance roles;
the opt-in CI consumer uses a repository/environment-scoped OIDC role.

```bash
aws sts get-caller-identity --profile code-web
node scripts/aws-deploy.mjs plan
node scripts/aws-deploy.mjs provision
node scripts/aws-deploy.mjs status
```

`plan` is read-only. `provision` explicitly creates/updates billable resources;
do not run it for an ordinary image update. It checks the account, stack owner,
in-progress state and infrastructure template. The wrapper rejects a dirty or
different engine revision. It creates the deployment SSH key and pins the base
Ubuntu AMI under `~/.local/share/agent-relay-aws-mvp` (private directory); only
the public key enters CloudFormation. The wrapper uses the reviewed engine
saved under `scripts/deploy` and verifies both runtime file hashes before every
operation. `CI_AWS_ENGINE` is only an optional override for the same clean,
pinned upstream revision. Keep the private key outside Git/backups
shared with other users. An update preserves the original pinned base AMI.

Wait for `CREATE_COMPLETE` / `UPDATE_COMPLETE`. A submitted operation is not a
successful deployment. Inspect the stack's events on failure; do not repeatedly
submit the same operation. Deletion/teardown is not part of these commands.
Data EBS, application secret, ECR and artifact bucket have retention policies.

## Build an immutable application image

Commit tested runtime changes first. No Docker daemon is needed on the operator
machine: the scoped CodeBuild project builds the Docker image remotely.

```bash
node scripts/aws-build.mjs start
node scripts/aws-build.mjs status 'PROJECT:BUILD_UUID'
```

Keep the returned build ID. The script uploads only an allowlisted `git archive`
of the exact commit, excluding local credentials, untracked files and saved
Relay data. CodeBuild uses that upload's immutable S3 version, pinned Node base
image and pinned native CLIs. Its role can read source, push only the application
ECR repository and write build logs; it cannot read application secrets.
Success returns an ECR `@sha256:` digest. Never deploy `latest` or an image tag.
An immutable existing tag may reject rebuilding the same commit; use its verified
existing digest, or commit the intended change before another build.

## Bake and accept private workers

Use the six exact outputs of this stack with the
[worker baker](../deploy/aws/README.md). The operator runs it explicitly; it
uses one temporary SSM-only private builder and automatically terminates that
exact builder after checking ownership. The final image has a deployment public
SSH key, not a private key, provider token, AWS profile or SSM identity.

Final workers must have **no IAM role, disabled EC2 metadata and no public IP**.
The image availability result alone is not acceptance: a fresh instance must
pass the fixed credential/identity audit and a stop/start persistence check.
Only then use it for real chat admission. An image or snapshot is retained after
the builder stops; no broad automatic resource deletion is performed.

## Deployment secrets and Google callback

The cloud uses separate state and encryption/session keys. It does not copy
local chats, provider accounts or the local `code-web/dev` configuration wholesale.

```bash
# One-time, explicitly copy only Google client settings and owner email;
# generate independent AWS encryption/session keys in the separate config.
node scripts/aws-secrets.mjs initialize --initialize-from-dev
node scripts/aws-secrets.mjs check
node scripts/aws-secrets.mjs publish --worker-ami ami-VERIFIED_WORKER
```

Set additional invited users in `AGENT_ALLOWED_EMAILS` in
`code-web/stg_aws_mvp`, then republish and deploy to apply. The owner is always
explicit (`AGENT_OWNER_EMAIL`); the first arbitrary Google login never inherits
the administrator's state. Publication verifies stack/image/key ownership and
matches the private transport key to the actual deployment public key. Secrets
are staged only in private tmpfs files, cleaned afterward, and never printed.
The running controller reads its one AWS secret with an instance role, not a
Doppler service token. The cloud has no static AWS keys or profile files.

To replace **only** the worker image after a new image has passed fresh-worker
acceptance, the operator can reuse the already published AWS environment:

```bash
node scripts/aws-secrets.mjs update-worker --worker-ami ami-VERIFIED_WORKER
```

This operation does not download Doppler or refresh credentials. It verifies the
same stack/image/key ownership, requires every existing setting and credential
to remain byte-identical except `AGENT_EC2_AMI_ID`, and conditionally promotes a
new secret version only if the inspected current version has not changed.
Malformed private snapshots are never printed. If it reports a concurrent or
unconfirmed publication, inspect the current version before retrying. Changing
credentials, invited users or any other setting still requires normal Doppler
publication. Redeploy the controller to apply the new image setting; an AMI's
`available` status alone does not establish its acceptance.

Register these values in the Google OAuth application's console before real
cloud sign-in (keep localhost entries if local use is still needed):

- Authorized JavaScript origin: `https://d20atclccf8cku.cloudfront.net`
- Authorized redirect URI: `https://d20atclccf8cku.cloudfront.net/api/auth/callback/google`

That console change and each user's Codex/Claude/GitHub/Linear consent are
external acceptance gates. No controller/admin login is imported into another
user's account. Codex/GitHub provide device URLs/codes; Claude provides its
native authorization URL and asks for the complete returned code. Linear uses
browser OAuth and a read-only workspace verification before claiming success.

Latest user acceptance (2026-09-18 13:54 UTC): the user confirmed that cloud
Google login and connecting both Claude and Codex work. This is **user-reported
product acceptance**, not an agent-observed authenticated browser run. The
subsequent account screenshot shows both providers connected and scoped to
`12-apps` and `thomfilg`. No model turn or chat resume was reported.

The user then reported a blocked new-chat flow: with no primary repository
selected, the account dropdown is empty and misleadingly suggests reconnecting.
The first repository determines company scope; company-bound accounts correctly
cannot be offered to an unassigned chat. The correction is repository-first
guidance and a compact account-settings control, not broader credential access.
GitHub company setup/repository access, Linear consent, successful deployed chat
creation, selected-account execution/
resume and authenticated deployed preview/transport acceptance remain open.

At 14:01 UTC a scoped deployed read-only diagnostic confirmed the repository
list's immediate blocker: exactly one saved GitHub connection is connected but
has `companies: []`; none has an allowed company. The query verified the legacy
owner against the configured Google owner before reading only that owner's
GitHub records, in a PostgreSQL read-only transaction. SSM
`389227f0-9c54-4b1f-b6fd-2c898d4ff542` completed Success / exit 0. No token,
session or email was printed; no provider request, consent or record mutation
was performed. This is saved-connection evidence, not fresh GitHub authorization
or repository-access verification. Company access requires the user's explicit
selection; the frontend must make that unfinished setup visible.

Earlier OAuth checkpoint (2026-09-18 13:19 UTC): the user confirmed adding both
cloud values above while retaining localhost. The official-MCP public probe
then reached `accounts.google.com` without detecting `redirect_uri_mismatch`
or Error 400. It did not observe a visible email field at its sampling point,
and **did not establish a completed login or successful callback**. All three
entry widths passed again, anonymous chats returned 401, and browser/client/
transport closure plus private transient cleanup were confirmed. No credentials
or consent were entered. This probe did not establish the successful login
subsequently reported by the user above.

Historical public-browser check (2026-09-18 09:59 UTC): **Continue with Google**
reached `accounts.google.com`, which rejected the cloud callback with
`redirect_uri_mismatch` (Error 400). Register the exact URI above in the Google
client; no Relay restart can substitute for that console configuration. No
credentials or consent were entered by this check.

The repeatable [public login probe](deployed-login-probe.md) now verifies the
three entry widths through official Playwright MCP. Its optional Google
initiation check reproduced the same mismatch at 10:10 UTC, with confirmed
process cleanup and without entering credentials:

```bash
taskset -c 0,1 nice -n 10 node scripts/smoke-deployed-login.mjs --run --check-google-redirect
```

Inspect its explicit provider/error flags: command completion does not mean
that Google consent or login succeeded.

## Deploy, observe and roll back

```bash
node scripts/aws-deploy.mjs deploy --image 'ACCOUNT.dkr.ecr.us-east-2.amazonaws.com/REPOSITORY@sha256:DIGEST'
node scripts/aws-deploy.mjs status --command-id COMMAND_UUID
node scripts/aws-deploy.mjs rollback
```

The first command submits an SSM operation and observes it. If the local
observation times out or disconnects, inspect the returned command ID instead
of blindly starting another rollout. Secrets, Docker logs and environment dumps
are deliberately absent from public command output.

The shared engine verifies the exact controller and encrypted volume, a
root-owned bootstrap marker, filesystem identity and container ownership. A
host-wide lock and mount-overlap checks prevent concurrent controllers. It
pulls the digest before draining. Busy chats/login attempts/browser connections
refuse the update. New HTTP/WebSocket admission is blocked during the accepted
drain, then the old controller is stopped before the new one starts.

Readiness checks the encrypted database and required writable directories,
not just a listening HTTP port. Failed startup attempts restore the retained
old container and its original configuration. Explicit rollback exchanges the
current and previous versions without deleting data. There is only one retained
previous container; preserve its compatible encryption key and state.

Public checks after a healthy command:

```bash
curl --fail https://d20atclccf8cku.cloudfront.net/readyz
curl --silent --output /dev/null --write-out '%{http_code}\n' https://d20atclccf8cku.cloudfront.net/api/chats
```

Expected: readiness `{"ok":true}`, anonymous chats `401`. These checks do not
establish OAuth, model turns, SSE/WebSocket or worker resume acceptance. Record
those independently. Do not expose arbitrary worker applications under the
controller's authenticated origin: that would let untrusted app code act as
the Relay user. Direct remote application origins remain an explicit separate
transport acceptance item, not something a local `.localhost` alias provides.

## Durability and acceptance status

Historical application (2026-09-18 14:11 UTC): revision
`f271d7ec2c0b871dcba7f39e63cfd7f29a4a645c`, immutable digest
`sha256:aa59e99face500213d3f04b554b0567d4c2c7f7670376fcc47b10ef28ecfcfc8`.
CodeBuild `ImageBuild-t8BSbSkDsHYX:b59d2266-3ae9-4587-a7e2-e162be7c91e3`
used exact S3 source version `TB0dvT3INsfkz3TXFyyC67SNvWUfpwbD` and succeeded.
The single safe-drain rollout `5a621149-308f-4f38-b00e-50751c6c7822` was
independently confirmed Success / exit 0. At 14:11:31 UTC public `/readyz`
returned 200 / `{ok:true}`; `/`, `/workspace-settings.js` and
`/github-accounts.js` each returned 200 without Set-Cookie and matched the exact
committed source bytes. No second rollout, forced drain, provider consent or
company-scope change was performed. The previous compatible preview-aware
image remains the earlier `b8b04ecc…` release below.

This frontend correction moves repository selection before the company-bound
account picker, replaces the large connection button with Agent's settings
icon, and makes missing GitHub company access actionable. It distinguishes
repository-loading failure from empty lists/searches and prevents stale refresh
responses replacing newer results. One incomplete GitHub setup can reopen with
known-company suggestions, but neither companies nor an ambiguous account are
automatically selected. Backend access rules are unchanged.

The patch passed 35/35 targeted backend tests, 18/18 account browser tests and
3/3 GitHub browser tests with one browser worker and CPU 0–1 affinity. The
official-MCP disposable fixture used actual local app APIs and UI to save
GitHub company access, retrieve repositories, select both providers, explicitly
configure the environment's company and create an empty Codex chat; no model
prompt or real provider consent was sent. Widths 320/390/1600 fit, with visual
inspection at 390. The 1122-test full regression below belongs to the preceding
release, not a new full-suite run on this frontend patch. User-reported Google/
Claude/Codex onboarding is recorded above; actual deployed chat execution,
GitHub repository access, Linear and authenticated preview remain open gates.

Previous application (2026-09-18 13:06 UTC): revision
`6bf952434ad2c9310ab032bc1fb2cc14c5a83aa8`, immutable digest
`sha256:b8b04eccd0a1a5841656868871e7666e553ebef12b760caef8aa74175d261d78`.
CodeBuild `ImageBuild-t8BSbSkDsHYX:56dda959-1ef2-4049-b2fb-db38158ead84`
used exact S3 source version `n6MmfqeCyGaUMibuQPrI6lbqTVzNzhtg` and succeeded.
Rollout `887b20aa-5d35-4bf5-b5b8-037af34b26fd` completed healthy and was
independently confirmed Success / exit 0. After the public checks below, a
second same-digest rollout `d3334a55-4313-4d52-a4ac-38ad67f59de0` completed
healthy to retain the same preview-aware configuration in the previous slot.
It was independently confirmed Success / exit 0. Read-only host audit
`c0bef718-1439-4ff2-82d6-d9d7bfdc81b0` also completed Success / exit 0:
both exact containers use this digest/configuration, only the current container
is running, its restart count is zero, and the controller/data mount/accepted
worker AMI are unchanged. No acceptance container, active controller SSM session
or running acceptance command remained in the complete scoped inventories.
Anonymous public readiness was 200 with `{ok:true}` and no Set-Cookie at
13:06:42 and 13:12:33 UTC (5m50s apart).

The removed preview hostname returned 421 without Set-Cookie for `/` and
`/api/auth/session` against the actual controller's loopback listener with that
Host header. This confirms deployed Host dispatch only, not CloudFront
forwarding or a positive authenticated preview request.

The deployed version includes strict preview-host isolation even when
provisioning is disabled, and [bounded worker preparation](adr/2026-09-18-preview-cold-worker-preparation.md)
before browser bootstrap. Cold acquisition returns 202 progress instead of
holding the first app response past CloudFront's read timeout. Stale preparation
IDs cannot restart an operation cancelled by Stop. This does not assert that
the user's application service is listening after a VM restart.

The final full regression passed **1122/1122**, with zero failures, cancellations
or skips, in 258.3 seconds. Native GitHub and official-MCP guest UI opt-ins were
enabled, sequentially on CPUs 0–1 at nice 10. A separate sequential run of all
seven Python operator test files passed **52/52**, including the exact pinned
shared rollout-engine bridge, worker image/bootstrap diagnostics, backup,
rollback and preview launcher; these mocks perform no real AWS/Docker calls.
The disposable preview UI browser suite passed 10/10. The official-MCP
integrated fixture passed with deliberately gated
acquisition, visible preparation, no pre-ready bootstrap/application request,
then HTTP/WebSocket/incremental SSE, revocation and observed cleanup. Root
inspected the 320-pixel preparation screenshot. These are fixture tests, not a
real EC2 cold-start or provider-consent result.

At 13:03 UTC all 13 fixed public Git/MCP denials passed again, together with
readiness 200, anonymous SSE 401 and WSS 101/bidirectional frames/expected
authentication rejection. At 13:04 UTC official MCP confirmed the login entry
at 1600/390/320 pixels without horizontal overflow. Google initiation still
returned **redirect_uri_mismatch / Error 400**; no credentials or consent were
entered. Browser/client/transport closure and private transient cleanup were
confirmed. At 13:19 UTC, after the user confirmed registering the cloud callback,
the repeat probe no longer detected either Google error. The user subsequently
confirmed Google login and Claude/Codex connection; GitHub/Linear consent,
successful chat creation and authenticated deployed app/transport/
selected-account execution remain open; see the latest user acceptance above.

Local runtime `f0e57ca` has the same application sources. Its controlled restart
used cold private checkpoint `checkpoint-eDMBUp`; the credential file remained
byte-identical and all 12 encrypted records were readable afterward. Verification
performed no record writes and did not compare every encrypted row byte-for-byte.
The two rejected worker AMIs and their exclusive snapshots were removed after
exact ownership/reference checks; the accepted image, its snapshot, the cold
backup and controller data were preserved. See the
[irreversible test-artifact cleanup receipt](aws-worker-artifact-cleanup-2026-09-18.md).

Historical activation (2026-09-18 12:25 UTC): revision
`14050df15ec0cc1465fed4b7f929097ad010bb21`, immutable digest
`sha256:9dbb6306863a60de96cf91118165b6164d053de72dbe04777fc5dfd296db6d9a`.
CodeBuild `ImageBuild-t8BSbSkDsHYX:65d3f2a8-045f-487e-b407-7816a9ed56d0`
used exact S3 source version `yEHpuZnlxYf5AefuNOl8lauwyGtF2KIq`.
SSM rollout `a251be12-8297-44a9-91b9-76bbf3f76039` completed healthy;
independent observation confirmed Success / exit 0.

The reviewed `EnableAppPreviews=true` change set added only
`PreviewHostingPolicy`; controller `i-08c991c22089589a5` and data volume
`vol-0be8793d52d34ed1c` were unchanged. The preview-only configuration update
used conditional secret-version promotion and verified every credential and
unrelated setting byte-identical. No Doppler credential refresh occurred.
Remote preview UI, strict Host routing, trusted browser bootstrap, durable
host lifecycle and HTTP/WS proxy are now enabled, not dormant. No product
preview host or fabricated production user was created by this rollout.

The integrated regression passed **1083/1083**, no failures/skips, in 271.1s,
with native GitHub and official-MCP guest UI enabled, sequentially on CPUs 0–1.
The later metadata-only operator tests passed **18/18**. A root rerun of the
complete local preview UI/API/bootstrap/HTTP/WS/SSE/revocation fixture also
passed after all runtime security fixes, including observed process cleanup.
This remains synthetic local OIDC/host/worker-boundary evidence, not real
Google consent or deployed app traffic. See [the fixture](preview-ui-acceptance.md).

At 12:22 UTC the deployed public checks passed all 13 fixed Git/MCP denials,
readiness 200, anonymous SSE 401, WSS 101 with bidirectional frames and expected
authentication rejection, and official-MCP login entry at 1600/390/320 pixels
without horizontal overflow. These checks do not authenticate a user.
Actual isolated CloudFront preview-host provisioning/deletion passed at
12:47 UTC through SSM `5af3fbe1-d454-4fca-875d-1bd83c7a3481`. The exact controller
role created one temporary distribution, verified readiness, reloaded its
durable record in a fresh provider, revoked it and confirmed deletion. The
temporary operator container was observed stopped and removed; its private
journal was retained. Independent complete distribution inventory confirmed the
temporary ID absent and the Relay distribution present. This is provider-state
reinitialization, not a controller reboot or authenticated application traffic.
See the [scoped receipt](preview-host-acceptance.md#actual-isolated-controller-role-receipt--2026-09-18).
At this historical checkpoint Google callback registration and real provider
consent remained open; the latest user acceptance above supersedes that status.

The post-test deployment-tagged EC2/volume inventory contained only the intended
running controller and its unchanged encrypted data volume; no tagged temporary
instance or acceptance volume remained. The controller, NAT, storage, retained
images and backup artifacts remain billable. This is scoped cleanup, not an
infrastructure teardown.

Before any preview host creation, the same verified digest/configuration was
deployed a second time: SSM `d33ae45e-c52b-4d54-abbb-38203c8c4034` completed
healthy (independently Success / exit 0). This retains a **preview-aware**
previous container. Do not roll back to pre-router code while preview
distributions remain enabled: revoking grants alone does not add strict Host
routing to an old binary. Preserve this compatible rollback boundary.

Historical application checkpoint (2026-09-18 09:51 UTC): revision
`3a0b7b3c17956393a7c9f6e36dc1a5bc80a05edb`, digest
`sha256:53cb37a8c558548bb256d90f1e840cc0a5aa9b80512f6fa13ef02022e401bad8`.
CodeBuild `ImageBuild-t8BSbSkDsHYX:44d1e375-b925-4486-83fd-320772a16a33`
used source version `tgNLJ1YJT7RnPo9WGChbzhx6HBGY5Of5`; deploy SSM
`563c63a5-8029-4f29-b76d-862374aaa6c5` completed healthy; independent status
confirmed Success/exit 0. The scoped Git/PR gateway, generic early-response HTTP
lifecycle fix and legacy source-only compatibility are deployed. The integrated
regression at this revision passed 1016 tests without skips,
including native configuration, official-MCP guest UI and denial-probe
suites. Actual CloudFront checks then passed all 13 fixed Git/MCP
denials with exact public bodies/no-store, readiness 200, anonymous SSE 401,
and WSS 101 with bidirectional frames followed by unauthenticated close 1008.
Pair the behavior-only denial receipt with this immutable deployment receipt;
it alone does not identify code or establish authenticated GitHub access.
See [deployed GitHub denials](deployed-github-denials.md) for the safe repeatable
operator command. No provider operation, account import or model call was made.

The reviewed preview grant/TCP/HTTP/SSE/WebSocket modules in that older image
were dormant. Their component tests did not establish working external app URLs:
isolated origin provisioning, bootstrap, lifecycle admission and the actual
deployed HTTP/WS app round trip were absent at that checkpoint. No preview IAM
or public route was activated by that rollout. Its `b19b736` rollback baseline
has since been replaced by the preview-aware baseline above.

The database, encrypted account records, message/attachment data and controller
SSH trust live on the retained encrypted data volume. Workers are disposable
and do not own the conversation database. Retention is **not** a backup:
consistent backup/restore and failed-release rollback must each be exercised
and documented before delivery is complete. Do not format, replace or restore
over the live data volume to test those cases; use a separate disposable restore.

Historical evidence (2026-09-18): authorized infrastructure, immutable build and
HTTPS rollout of `f0692eb` passed; `/readyz` is 200 and anonymous `/api/chats` is
401. Cold backup/restore passed on encrypted EBS (retained snapshot
`snap-08d0e108e9596b5df`); the distinct restored copy was verified and removed,
and the original controller recovered. Controlled failed-rollout recovery also
passed: candidate exit 1/readiness failure restored the exact original
container, configuration and mounts. The operator did not update secrets or
delete application data; it did not compare database fingerprints across restart.
Evidence: acceptance `91246861-681f-485c-b85f-4b9051b071a4`, SSM
`88faada5-24b1-493e-bb78-22cd1df09fde`. The normal single previous-container slot
was consumed by this test; its healthy baseline image remained unchanged.

The 08:18 UTC worker checkpoint passed with `ami-06f979453243f2fc1`:
fresh/resumed audits and exact test-instance/volume cleanup completed before its
`verified-v1` marker was written and confirmed. Verification ID
`ad2783e5-b450-4642-91d9-04273e8c8bc2`. The two earlier images remain unaccepted;
the finalizer omission exposed by their authorized-key audit was corrected.
The controller IAM policy-only update completed without resource replacements.
Runtime admission checks were first deployed in `6de71bb`, immutable digest
`sha256:16a165a5b7011473034737d13a9489acabcb69e1975252898abaca6aef03a6b4`;
SSM `e5b40bf3-d94f-456f-a5b7-1212d4634cce` completed healthy. The image-only
configuration update preserved all other settings and credentials, and the
previous healthy application was redeployed with that accepted-image setting
before the runtime update to preserve a usable rollback baseline.

The earlier integrated regression at `e22fd45` passed 859 tests without skips,
including native/SSH/operator fixtures and the opt-in official-MCP guest UI
test in the same sequential run. Ten finalizer Python checks also passed.
A fresh onboarding browser run passed 28 isolated fixtures: 16
Codex/Claude, 4 Google, 4 GitHub/company scopes and 4 Linear. These are not real
provider consent. Actual isolated Claude execution/resume also passed on the
accepted AWS worker image: run `bc21e4dc-52aa-4234-b2f8-87c1f2ab61fd`, worker
`i-0676589cf2c450529`. Two authorized Haiku turns retained context/account identity;
the host source stayed unchanged, no refresh token was copied, the private test
profile/session were cleaned, and the VM and encrypted volume were removed.
Reported cost upper bound was USD 0.014650. This is not product-account onboarding.
Public workspace upload also passed through the unchanged product
`Ec2Executor.prepare` on a separate accepted AWS worker: run
`1d6404c4-a76d-4293-a56e-1ae94f6ff712`, VM `i-02c330d1779ba2526`.
Remote HEAD matched, Git config had no credentials, and a second prepare retained
the remote sentinel. Fixture/SSM and exact VM/encrypted-volume cleanup passed.
This isolated local-controller test used no credentials/models; it does not
establish private selected-GitHub or deployed-controller admission.
Guest Chrome subsequently passed all six DPR-2 presets, same-tab sharp pixels,
mouse/keyboard, live canvas update, viewer presence, renderer sandbox and Stop:
run `1d452529-ac01-42a6-86cc-bf3322b2b069`, VM `i-0c48a75efb1ede65b`.
The earlier fixture's five-second initial UI wait was replaced by an explicit
45-second bound and safe diagnostics; all sandbox/process checks remain strict.
Fixture/SSM and VM/encrypted-volume cleanup passed, with no provider credentials,
model turns or transcript messages. This is a real AWS guest controlled through
an isolated local Relay, not deployed authenticated CloudFront acceptance.
The user has since confirmed cloud Google login and Claude/Codex connection;
GitHub/Linear consent, selected-product-account execution, protected deployed
SSE/live-browser acceptance and remote application forwarding remain open.
See the [feature queue](feature-queue.md)
for the latest evidence and explicit release gates.
