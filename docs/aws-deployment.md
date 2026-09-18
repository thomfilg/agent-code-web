# AWS MVP operations

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
git clone https://github.com/12-apps/ci.git /YOUR/OPERATOR/PATH/ci-aws
git -C /YOUR/OPERATOR/PATH/ci-aws switch --detach 848182b33461640e9ac0feb7315f747a67877c88
export CI_AWS_ENGINE=/YOUR/OPERATOR/PATH/ci-aws/scripts/deploy/aws.mjs
node scripts/aws-deploy.mjs plan
node scripts/aws-deploy.mjs provision
node scripts/aws-deploy.mjs status
```

`plan` is read-only. `provision` explicitly creates/updates billable resources;
do not run it for an ordinary image update. It checks the account, stack owner,
in-progress state and infrastructure template. The wrapper rejects a dirty or
different engine revision. It creates the deployment SSH key and pins the base
Ubuntu AMI under `~/.local/share/agent-relay-aws-mvp` (private directory); only
the public key enters CloudFormation. Keep the private key outside Git/backups
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

Actual public-browser check (2026-09-18 09:59 UTC): **Continue with Google**
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

Current application (2026-09-18 12:25 UTC): revision
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
Google callback registration and real provider consent remain open.

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
Cloud Google/provider consent, selected-product-account execution,
protected deployed SSE/live-browser acceptance and remote
application forwarding remain open. See the [feature queue](feature-queue.md)
for the latest evidence and explicit release gates.
