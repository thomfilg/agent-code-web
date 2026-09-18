# Feature queue — original request order

Deployment clarification (2026-09-18): today's manual setup/update may stop
workers if necessary, explicitly authorized by the user. **When deployments
become automatic, they must not bring down running instances.** Keep automatic
rollout disabled until worker/task-preserving controller handoff and rollback
are implemented and verified; do not carry today's interruption exception into
automation. See [the continuity requirement](adr/2026-09-18-automatic-rollouts-preserve-workers.md).

Latest chat follow-up (2026-09-18): incoming agent messages were not followed by
the viewport. The defect was reproduced and a frontend fix now passes 14/14
unit/window cases and 5/5 browser follow/navigation cases, preserving intentional
manual scrollback and a stable Jump to latest during streaming and virtualized
history. Publication remains separate: a running AWS worker may contain native
background work, so no live restart has been performed for this patch yet.
This refines item 26, not permission to inject messages in the user's real chat.
The earlier controls report was clarified as intermittent:
normally the controls respond, but in that instance none did. It remains open;
the expected stopping-state restrictions alone do not establish its cause.

Follow-up source acceptance (2026-09-18): checkpoints `317c82d` and `27a3e12`
are pushed. The full Node suite passed 1,166/1,166 before the final frontend
command-cache callback; that delta passed 14/14 focused cases. Claude model and
command browser checks passed 49 distinct cases (47 on the initial run plus
two startup-only failures passing after explicit fixture readiness). The
incoming-message follow fix has focused acceptance as described above.
See [the scoped evidence and remaining limits](validation-2026-09-18-chat-ui.md).
This is not a deployment receipt or real-account Fable confirmation.

Source checkpoint (2026-09-18, 15:24 UTC; rollout still pending): GitHub's extra
company gate is removed, existing connections need no migration, and the
default duplicate footer is hidden with observed branches in the PR strip.
Official Playwright MCP reproduced and helped fix a startup race in New chat;
the final disposable flow now lists GitHub repositories without a company form,
keeps explicit agent/environment access, selects both providers and creates one
empty Codex chat. Zero real consents/model prompts were generated. Evidence:
1,132/1,132 full Node tests before subsequent targeted startup/Claude changes;
17/17 startup/footer units; 46 browser cases across GitHub, account onboarding,
scope preservation, footer/preview and early New chat; mobile/desktop inspected.
Claude command initialization and selected-account metadata reuse passed a
separate 125/125 focused suite and independent source review. Fable cold-start
discovery is still being finalized; Ultracode is a separate next commit.

Active objective: implement **all MVP** features requested in this conversation,
one at a time, in original order unless an explicit priority update below says
otherwise. New reports append without interrupting the current item and stay
outside the MVP unless the user explicitly includes them or clarifies an
existing MVP requirement. Repeated
reports remain evidence that an earlier fix needs verification, not permission
to skip it. Queued work proceeds under the existing implementation authorization;
adding an item does not require another request to resume in-scope work.
Execution update (2026-09-18): the user authorized six hours of parallel agent
work, tested commits/pushes/PRs per feature, and compatible product decisions
recorded as ADRs. Interactive consent tests can await the user's return while
other MVP implementation proceeds. The user explicitly permitted copying local
GitHub/Claude credentials into isolated test profiles, not adding host-account
imports to the product. Non-MVP implementation still waits for a manually
verified complete MVP. This supersedes the earlier sequential-execution
constraint below; see [ADR 0001](adr/0001-parallel-mvp-validation.md).
The documentation-only MVP checkpoint was merged in PR #3. Implementation has
resumed under the persistent MVP goal: finish one feature, test it (request
user-only consent where necessary), commit/push, then take the next feature.

This queue supersedes the narrower gap list in `remaining-goal.md`. Existing
source changes are retained, but are not treated as deployed merely because
tests pass. Deployment and external-account verification remain explicit gates.

Latest GitHub clarification (2026-09-18): connecting a GitHub account makes all
repositories that GitHub permits available to its owning Relay user, without
another company form. Remove the GitHub-only allowlist; existing records work
without migration or reconnect. User ownership, explicit connections, provider
denials and selected-repository/branch worker grants remain enforced. Agent,
environment and MCP scopes are unchanged. This supersedes GitHub company-step
requirements and the historical 14:11 receipt below; see the
[decision](adr/2026-09-18-github-provider-permissions.md). Validation is in
progress; this refinement is not yet claimed deployed.

Composer refinement (2026-09-18, item 14): remove the redundant default footer
containing model/effort, context and branch. Keep model controls and the context
ring; show the branch in the PR/repository strip, including before a PR exists.
Deliberately configured custom status lines remain available.

Claude model-list correction (2026-09-18): the user's installed native model
menu includes Fable and a version-disabled Fable 5.1; Relay omits both and shows
two Default choices. Align discovery/rendering with actual CLI/account options,
remove duplicate default entries, and retain disabled-option reasons rather
than inventing support. This refines the existing model/agent picker; validation
is pending and no model prompt is authorized by this report.

Ultracode clarification (2026-09-18): the user requests the missing Ultracode
option. Inspection of the installed Claude 2.1.222 identifies a separate native
`ultracode` setting combining xhigh effort with workflow orchestration, not an
extra member of `supportedEffortLevels`. Implement the actual mode and its
capability checks; relabeling xhigh alone would not satisfy this request.

Claude runtime reports (2026-09-18): the command picker returns no matches for
`/goal`; investigate the installed native command catalog and its advertised
web capabilities rather than claiming all commands are absent from one query.
The user also reports disabled composer controls after background Docker/pnpm
tasks. Reproduce the actual transition and distinguish expected temporary
switch/stop restrictions from a stuck state. Both remain open refinements of
items 14/20; no success is inferred from the screenshot or unrelated tests.

User-reported AWS acceptance (2026-09-18, 14:45 UTC): the user confirmed
“funcionou” with a deployed screenshot of a Personal Codex/Luna chat under
`12-apps/future-pay`, a user message and the agent response. This establishes
user-reported deployed chat creation and Codex response in addition to earlier
Google/Codex/Claude login confirmation. It does not establish Claude execution,
worker restart/resume, Linear consent or authenticated preview acceptance.

Delivery instruction (2026-09-16): when the current feature work is verified,
create or update its PR and push the reviewed work so it is saved remotely.
Preserve unrelated changes; do not treat this as permission to merge, deploy,
restart live services or alter live user data/accounts. This delivery step does
not reorder the feature queue.

Restart authorization (2026-09-17): the user explicitly said not to ask again
and, subsequently, to restart Relay whenever needed. Preserve existing data,
check for active work before a controlled restart, and use the configured
Doppler project. This authorizes necessary Relay restarts, not OAuth consent,
automatic real model prompts or an AWS deployment.

Priority clarification (2026-09-17): finish and test already-started work before
starting an unimplemented feature. Work on one complete feature at a time,
commit and push its verified changes, then move to the next. Keep the original
scope and order; a checkpoint saves progress but does not close an unfinished
feature or turn an external verification gate into a passing result.

Delivery correction (2026-09-17, earlier user priority): finish the **18 previously
reported verified/answered items first**: 01–14 and 16–19. Pause item 20's doctor
work and preserve its unfinished test changes. Then return to the remaining
original queue; new requests still append at the end. The old count conflated
implementation tests with usable delivery: item 09 is a technical answer, and
the other **17 were reopened for delivery acceptance**, not newly discovered
defects. After the saved-data acceptance of item 01 below, the historical total was
**45 items: 1 delivered, 1 answered and 43 not fully delivered** (16 priority
re-audits, the previous 24 open items, two authentication requests and the AWS
deployment request below). The new MVP gate is a release requirement, not a
claim that these open items have been completed. There are now **46 recorded
requests** including account deletion; current delivery acceptance is tracked
per row. The latest activation/evidence below supersedes historical status
claims without turning fixture coverage into real-account acceptance.

For each reopened item, verify its full acceptance condition on current code,
then verify the applicable deployed UI/backend/native integration. Preserve real
messages, drafts, credentials and browser state; use disposable fixtures for
destructive/error cases. A fixture pass is not a live-delivery pass. Record
remaining user-only OAuth/account consent explicitly rather than counting it as
done. Commit/push each completed item's changes before moving to the next.
Current activation checkpoint (2026-09-17): Google login is running at the
canonical origin `http://localhost:8787`, using the existing encrypted
PostgreSQL database on 55438 and repository-scoped Doppler `code-web/dev`.
The user completed real Google sign-in after configuring the owner email.
An offline backup preceded activation; the five existing connection,
environment, preference and encryption-check records were unchanged. That
database already contained zero chats before this activation. The earlier
510-message acceptance remains historical evidence, not the current chat count;
this activation did not delete those messages. No worker or real model turn
was started. The subsequent authorized Codex activation below now serves the
named-account onboarding UI. The user has since connected the named Personal
Codex account; a consented real turn and chat/account resume still need checking.
Claude was still unimplemented at that historical checkpoint. Neither Google sign-in nor a saved
GitHub/MCP connection establishes successful provider onboarding.
Do not silently adopt host credentials or count native integration gates as
passed. Tests run one suite at a time with inherited two-CPU affinity and
nice 10. This correction supersedes historical completion/count statements;
their test evidence remains useful but is not deployment proof. Authentication
is the current prerequisite; item 20's unfinished doctor work stays paused.

## MVP release gate — 2026-09-17

Latest publication (2026-09-18 14:11 UTC): the repository/account onboarding fix
`f271d7e` is live on AWS at immutable digest
`aa59e99face500213d3f04b554b0567d4c2c7f7670376fcc47b10ef28ecfcfc8`.
The single safe-drain rollout completed Success / exit 0; independent public
readiness and exact source-byte checks of all three changed frontend assets
passed. Account/company permissions were not changed. The UI-fix tests and
remaining product-acceptance gates are detailed below.

Previous checkpoint (2026-09-18 13:06 UTC): AWS served immutable revision
`6bf9524` / digest `b8b04eccd0a1a5841656868871e7666e553ebef12b760caef8aa74175d261d78`.
The rollout and a second same-digest compatible rollback baseline completed
healthy, both independently Success / exit 0. The final exact host audit
confirmed current/previous image/configuration, zero container restarts and no
remaining acceptance container/session/command; public readiness stayed healthy
across observations almost six minutes apart. Local runtime `f0e57ca` uses the same application sources, with 12
readable encrypted records and a byte-identical credential file after cold
checkpoint `checkpoint-eDMBUp`. No user account was authorized or chat created
in either live deployment for these checks.

Final integrated regression: **1122/1122**, zero failures/cancellations/skips,
with both native-GitHub and official-MCP guest-UI opt-ins, two-CPU sequential
execution. The separate seven-file Python infrastructure-operator regression
passed 52/52 with mocked AWS/Docker boundaries. Cold preview opening now returns
bounded 202 progress, waits for the
worker before bootstrap, and cannot auto-restart via stale polling after Stop.
The full official-MCP UI/API/bootstrap/HTTP/WS/SSE/revocation fixture passed
with deliberately blocked acquisition, plus the independent review and 10 UI
browser checks. The real isolated CloudFront lifecycle and exact cleanup also
passed; none of those fixtures establish authenticated deployed app traffic.

The published Google entry/anonymous denials and real WSS transport checks
passed again. Actual Google initiation at 13:04 UTC still returned
`redirect_uri_mismatch`. The user subsequently confirmed registering the cloud
origin/callback while retaining localhost; a fresh official-MCP check at
13:19 UTC reached Google without detecting that error or Error 400. It did not
observe a visible email field at its sampling point and did not complete login;
all browser/client/transport and private transient cleanup was confirmed.
At 13:54 UTC the user confirmed cloud Google login and connecting both Claude
and Codex. Record these as **user-reported product acceptance**, not automated
authenticated browser or model-turn evidence. A subsequent screenshot confirms
both connected accounts are scoped to `12-apps` and `thomfilg`.

The user then reported a blocked new-chat account picker with no repository
selected. Root cause: company-scoped accounts are filtered against the currently
unassigned chat, while the UI incorrectly suggests reconnecting and puts
repository selection after its dependent fields. A repository-first flow with
accurate guidance and the requested settings icon beside Agent is implemented
below; company access is not widened. GitHub company setup/repository access,
Linear consent, successful deployed chat creation, selected-account execution/resume and authenticated deployed
transport/app acceptance remain open. The MVP is **not complete**. Test totals do not close
the historical priority re-audits or change the number of recorded requests.

The additional empty-repository report was confirmed against the deployed
owner's saved metadata at 14:01 UTC: one connected GitHub connection, zero
allowed companies. An owner-bound PostgreSQL read-only diagnostic made no
provider requests or record changes. The existing backend intentionally returns
no repositories before explicit company permission; the correction below adds
a clear company-access setup action in place of the misleading generic
search-empty message. No company is selected or authorized automatically.

The UI correction is committed and pushed as `f271d7e`: repository selection
precedes the company-dependent account picker; the requested settings icon
beside Agent opens account management without the large connection button.
The repository picker distinguishes missing GitHub company access, loading
failure, no available repositories and search misses, with explicit setup/retry
actions and stale-response protection. Reopening one incomplete GitHub setup
shows known company suggestions from agent accounts but checks none for the
user; several incomplete accounts require an explicit choice. Create remains
disabled until repository, eligible agent account and environment are selected.

Verification of this patch: **35/35 targeted backend tests**, **18/18 account
browser tests** and **3/3 GitHub browser tests**, sequential on CPUs 0–1 at nice
10. The official-MCP disposable fixture exercised the real local APIs and UI
through explicit GitHub company permission, repository retrieval, both provider
account selectors, explicit environment company access and one empty Codex chat.
It sent zero model prompts and used zero real provider consents. Widths 320,
390 and 1600 fit; root visually inspected the 390-pixel screenshot. Independent
source review passed. The prior 1122-test full regression is the earlier release
baseline, not a newly executed full suite on this frontend patch. Publication
receipts belong in the [deployment status](aws-deployment.md).
See [current deployment receipts](aws-deployment.md) and
[preview operation limits](app-preview-operations.md).

Earlier verification checkpoint (2026-09-18 12:40 UTC): the full integrated suite on
`62bd880` passed **1097/1097**, with zero failures, cancellations or skips in
255.4 seconds. Native GitHub and official-MCP guest UI were enabled; execution
was sequential on CPUs 0–1 at nice 10. The subsequent bootstrap-cleanup and
pinned host-launcher checks passed **8 Node tests** and **8 Python tests**
separately; 414 committed JavaScript modules passed syntax checks. These are
test counts, not a count of delivered feature requests.

The local controller was restarted from `da848d4` after an idle-work check and
cold private checkpoint `checkpoint-a8XZOv`. Its credential file matches that
checkpoint byte-for-byte and all 12 encrypted records remain readable. No
record was written by the verification, no production user/chat was fabricated,
and no provider consent or model prompt occurred. AWS still runs the immutable
revision in the activation receipt below until a later rollout is recorded.

The real isolated controller-role CloudFront lifecycle passed at 12:47 UTC:
one address created, ready state verified and revalidated from its durable
record, access revoked, distribution deleted and exact operator container
removed. Root independently confirmed a complete inventory with the temporary
distribution absent. This closes only the provider/IAM lifecycle primitive,
not Google consent, a controller reboot or authenticated app HTTP/WS/SSE.
See [the receipt and its limits](preview-host-acceptance.md).

Continuation checkpoint (2026-09-18 12:25 UTC): the user renewed autonomous
work for two hours, ending at 13:39:52 UTC (10:39:52 São Paulo). The isolated
remote-app preview now has committed controller routing, persistent
owner/chat/port CloudFront assignments, trusted-Relay browser bootstrap,
explicit Open app UI and runtime/logout revocation. These changes are pushed
on the integration branch, with component PRs 30–34. Runtime `14050df` is now
deployed on AWS; local runtime `5487358` has identical application sources.
The reviewed infrastructure change set added only the opt-in controller preview
IAM policy; it replaced no controller or data volume. The narrow configuration
update preserved all credentials and unrelated settings. A second same-digest
rollout retained a preview-aware rollback container. The old dormant-preview
description below is historical, not the current activation state. Actual AWS
preview lifecycle and authenticated app-traffic acceptance remain open.

New evidence: 29 focused controller/auth/config/runtime checks and an independent
35-test review passed. Actual local HTTP/WS integration verifies cookie and host
isolation, no browser-to-agent messages, immediate logout/Stop revocation,
foreign-origin denial before worker acquisition, and deploy-drain protection
during an incomplete bootstrap request. A separate official Playwright MCP
browser run proved that an active hostile app service worker cannot intercept
the trusted Relay-origin bootstrap; blocked third-party cookies fail closed.
The full local UI-to-server browser acceptance passed through real HTTP/WS/SSE
and revocation, with observed child cleanup and no prompts; root repeated it
after all runtime fixes. Integrated regression passed 1083/1083 without skips
or failures, plus 18 metadata-operator checks. These fixture checks do not replace
Google/provider consent in the deployed product. The AWS Google callback still
needs the user's console configuration. Public AWS login entry/denial/transport
checks passed again after rollout; see [deployment receipts](aws-deployment.md).

The authorized local restart preserved twelve readable encrypted records and
the credential file byte-for-byte against its cold private checkpoint
`checkpoint-4fMMFh`. There were zero chats and pending agent sign-ins before
restart. No account was authorized or message sent; this is not a claim that
every encrypted row was byte-compared against the archive.

Historical local activation (2026-09-18 09:50 UTC): the integrated Codex/Claude,
GitHub/Linear, scoped worker Git/PR gateway and account-deletion version is active
on `http://localhost:8787` (revision `1f79d26`, same runtime as AWS `3a0b7b3`
plus three integration tests). A cold private checkpoint preceded
the restart; all 12 encrypted records remain readable and the credential file
matches the pre-restart archive byte-for-byte. This restart did not compare
every encrypted row's bytes against that archive.
Personal and umg are disconnected; fresh consent and the authorized real-turn/
resume gate are still open. The older connected-Personal checkpoint above is
historical. Startup reused already-loaded Doppler `code-web/dev` settings in
memory, not a fresh download or a new token. The old private login bus closed;
future fresh Doppler CLI operations may require sign-in again. No account was
authorized or chat created by the restart. Official Playwright MCP verified the
live local login page at 1600/390/320 pixels and anonymous chat access denial.
AWS provisioning is now explicitly authorized for profile `code-web`, account
`456808212788`, region `us-east-2`. Stack `agent-relay-mvp` reached
`CREATE_COMPLETE`; the private controller booted with its encrypted data volume
and CloudFront assigned `https://d20atclccf8cku.cloudfront.net`. CodeBuild built
the pinned application image successfully. Actual HTTPS rollout now responds
with database-backed `/readyz` 200 and denies anonymous `/api/chats` with 401.
Official Playwright MCP verified the Google entry screen at 1600, 390 and 320
pixels without horizontal overflow. Google cloud consent remains pending the
new callback registration; no production account or chat was fabricated.

AWS checkpoint (2026-09-18 09:51 UTC):

- Current deployed application: revision `3a0b7b3c17956393a7c9f6e36dc1a5bc80a05edb`,
  immutable digest `sha256:53cb37a8c558548bb256d90f1e840cc0a5aa9b80512f6fa13ef02022e401bad8`.
  CodeBuild `44d1e375-b925-4486-83fd-320772a16a33` used exact source object
  version `tgNLJ1YJT7RnPo9WGChbzhx6HBGY5Of5`; deploy SSM
  `563c63a5-8029-4f29-b76d-862374aaa6c5` completed healthy (independently
  confirmed Success/exit 0). Thirteen fixed
  negative Git/MCP requests passed through CloudFront, including anonymous,
  unissued-capability, browser-origin, unsupported path/method/query checks.
  Their exact public error bodies and no-store headers were checked, not just
  HTTP status. This behavior-only receipt is paired with that immutable rollout;
  it does not prove authenticated GitHub access. Readiness 200, anonymous SSE
  401, and real WSS 101/bidirectional frames/expected rejection 1008 passed again.
  No account imports, external provider writes, model prompts or test users.
- Integrated regression at the exact published revision passed **1016/1016**,
  no skips/failures (223.0 seconds). Both opt-ins were enabled: native GitHub
  environment/configuration probes and official-MCP guest UI. Single test
  process at a time, CPUs 0–1 and nice 10.
- The final full run including three grant-to-proxy integration fixtures, two
  canonical OAuth-origin fixtures and nine public-login operator fixtures passed
  **1030/1030**, no failures/skips (230.5 seconds), with the same opt-ins and
  CPU limits. These later changes add tests/operator verification, not deployed
  application behavior. The reviewed login operator also ran through official
  MCP against AWS at 10:10 UTC: all three public entry widths passed, Google
  returned the callback mismatch, and actual MCP child closure plus private
  transient-file removal were confirmed. No credentials or consent were entered.
- The generic HTTP lifecycle fix now covers early responses outside the Git
  gateway too. A completed response closes only its own unfinished input after
  flushing; complete keepalive, gated authenticated saves and live SSE remain
  intact. The raw half-open regression observes the actual server socket close
  even when the client deliberately never sends FIN. Malformed request URLs
  return a fixed 400 instead of escaping the asynchronous request handler.
- Reviewed preview grants, TCP transport and HTTP/SSE/WS proxy foundations are
  present but **dormant**. Scoped revocation, byte/time/fanout limits and exact
  child cleanup have offline coverage; three later true grant-to-proxy fixtures
  passed independently (SSE sibling isolation, WS expiry and no-spawn denial).
  No preview router/bootstrap, permanent hostname registry, provisioner or UI
  activates them. Gate 45 remains open, including service-worker/bootstrap
  isolation and real deployed app HTTP/WS acceptance.
- Official Playwright MCP rechecked the actual newly deployed Google entry
  screen and anonymous chat denial at 1600/390/320 pixels on both cloud and
  local origins, without horizontal overflow; root inspected the cloud mobile
  screenshot. The initial post-click diagnostic failed because its MCP sandbox
  lacked the global URL constructor, not because Relay failed. The corrected
  check at 09:59 UTC reached `accounts.google.com` and observed Google's actual
  `redirect_uri_mismatch` / Error 400: the new cloud callback is not accepted by
  the OAuth client. No identity, password or provider consent was supplied.
  The repeated 09:59 UTC read-only cleanup audit found only the intended controller
  running for this deployment, no active acceptance SSM sessions on it, and no
  remaining native-acceptance-tagged volumes. The controller, NAT and retained
  storage remain billable; this is not a claim that AWS resources were torn down.

- Cold backup/restore passed on the actual encrypted EBS volume. Snapshot
  `snap-08d0e108e9596b5df` is retained; a distinct restored volume matched both
  encrypted records and zero attachments, was unmounted and removed, and the
  original controller recovered. This small empty-account dataset is not a
  claim of large-volume recovery testing. Run `775be65e-3184-4822-b9f1-7e919d96d076`.
- The earlier reviewed application update through revision `f0692eb` passed in AWS
  (immutable digest `sha256:d00cf873d34af1676f52b954fc06218f265326c9c172003f51f957a16feb9bb1`). Integration
  tests passed 783/783, plus 21 isolated-native/SSH tests.
- Controlled failed-rollout recovery passed on the actual controller. The
  candidate inherited the exact current filesystem, deliberately exited 1 and
  failed readiness. The shared engine restored the exact original container,
  configuration and mounts, verified the persistent EBS volume, and removed
  the failed candidate. The operator did not update secrets or delete application
  data; this test did not compare database fingerprints across restart. Run
  `91246861-681f-485c-b85f-4b9051b071a4`, SSM
  `88faada5-24b1-493e-bb78-22cd1df09fde`; independent public checks again returned
  readiness 200 and anonymous chats 401. The older previous-container slot was
  consumed under the normal single-slot rollout policy.
- Worker AMI `ami-0511b35c0d21d5ee0` failed fresh credential/metadata acceptance.
  The next bake, `ami-01358e3a58d2e7d20`, passed all identity, native-version,
  SSM-removal, network/metadata and heartbeat checks, but still failed the
  credential audit: `unexpectedAuthorizedKeys=1`, all other categories zero.
  Exact location/content was not exposed. The finalizer's missing cleanup of
  the agent SSH directory was corrected; neither old image is accepted.
  Latest probe SSM `0b25c656-3777-471b-9c8a-28ead4b954e9`; disposable worker
  `i-063b80e4d84599b35` and its encrypted volume were confirmed removed.
- Worker admission now requires the exact private/pinned image to bear a
  `verified-v1` acceptance marker, written only after fresh boot, stop/start
  and confirmed disposable-instance/volume cleanup. The 64 focused tests pass.
  CloudFormation change set `worker-ami-acceptance-20260918` reached
  `UPDATE_COMPLETE`, modifying only the controller's IAM policy (no replacements)
  to deny launches of unaccepted images. Controller runtime admission is now
  deployed in revision `6de71bb`, digest
  `sha256:16a165a5b7011473034737d13a9489acabcb69e1975252898abaca6aef03a6b4`,
  deploy SSM `e5b40bf3-d94f-456f-a5b7-1212d4634cce`, readiness 200/chats 401.
- Replacement AMI `ami-06f979453243f2fc1` passed actual fresh-boot and stop/start
  acceptance, including credential absence, disabled metadata/no role, private
  network, native versions, distinct/stable machine and SSH identity, heartbeat
  and persisted sentinel. Verification `ad2783e5-b450-4642-91d9-04273e8c8bc2`;
  fresh SSM `bb67ba23-4175-4a1c-aada-39b5e4e38430`, resumed SSM
  `afd39ae5-d4c7-4196-b77d-1fed32f6697b`. Exact verification VM and encrypted
  volume were removed before marking the image accepted. Builder
  `i-088ce2690e3b8923e` is terminated with zero remaining bake-tagged volumes.
  The image-only configuration publication preserved every credential/other
  setting; a rollout of the prior healthy app established the accepted-image
  rollback baseline before the new runtime rollout.
- Actual isolated native Claude acceptance passed on the accepted AWS image:
  two Haiku turns returned OK and retained the first turn's context, with the
  same account identity. Run `bc21e4dc-52aa-4234-b2f8-87c1f2ab61fd`, worker
  `i-0676589cf2c450529`. Only the explicitly authorized host access token was
  copied into the disposable test profile (no refresh token or product account
  import). Source credentials were unchanged; the remote profile and SSM session
  were cleaned up, and the exact VM plus its encrypted volume were confirmed
  removed. Reported cost upper bound: USD 0.014650. This proves the native AWS
  turn/resume path, not fresh product browser consent or selected-product-account
  onboarding. Guest Chrome and public workspace transfer are separate checks below.
- Actual public workspace transfer passed on a separate accepted AWS worker:
  run `1d6404c4-a76d-4293-a56e-1ae94f6ff712`, VM `i-02c330d1779ba2526`.
  The unchanged product `Ec2Executor.prepare` cloned/uploaded the fixed public
  repository, matched the remote Git HEAD, kept `.git/config` credential-free,
  and preserved a remote sentinel on the second prepare. Fixture and SSM cleanup
  passed; VM and one encrypted volume were confirmed removed. This used an
  isolated local controller and no provider credentials/model turns. It does
  not test deployed-controller admission, private GitHub selection or stop/start.
- Actual AWS guest Chrome now passed after the fixture's initial Live wait was
  made explicitly bounded at 45 seconds instead of MCP's five-second default,
  with safe diagnostics and strict process-exit confirmation. Run
  `1d452529-ac01-42a6-86cc-bf3322b2b069`, VM `i-0c48a75efb1ede65b`: all six
  presets (320/390/640/834/1280/1920 widths) at DPR 2, exact sharp pixels, same
  tab/document, mouse/keyboard, SSE-driven canvas update, viewer presence,
  renderer namespace/seccomp and Chrome Stop passed. No sandbox check was
  weakened. Fixture and SSM were cleaned; VM plus encrypted volume removal was
  observed. Zero provider credential reads, model turns or transcript messages.
  Root visually inspected the md/xlg screenshots. This used the real AWS guest
  with an isolated local controller, not authenticated deployed CloudFront UI.
  The prior failed attempt's exact VM/disk were also confirmed removed.
- Scoped GitHub worker smart HTTP and PR MCP are integrated, with independent
  review, native no-model environment/argv checks, and actual GitHub push plus
  PR edit/create acceptance using authorized isolated local credentials. PR22
  itself was created through the new MCP tool (one attempt, no retry). No product
  account was imported. The full regression exposed legacy source-only chat and
  malformed test-selection compatibility cases; source-only history now restores
  an empty repository selection without inferring any account. Explicit malformed
  selections still fail closed. Old selected-repository records without saved
  connection IDs require explicit reselection in a new chat, not a silent fallback.
  An independent review also found incomplete HTTP bodies could hold shutdown;
  one bounded, revocable request lease and exact socket closure now cover them.
  The corrected runtime passed 948/948 sequential tests, including both native
  configuration-only probes and the official-MCP guest UI fixture; the four new
  deployed-denial probe tests passed separately. The immutable publication and
  deployed negative behavior checks are recorded in the current checkpoint above.
- The cloud Google callback, confirmed registered by the user at the latest
  13:19 UTC checkpoint, is
  `https://d20atclccf8cku.cloudfront.net/api/auth/callback/google`.
  Fresh product consent for Codex/Claude/GitHub/Linear, selected-account execution,
  and deployed authenticated transports remain explicit open gates.
- Deployed WSS transport passed a real 101 upgrade and bidirectional frames,
  followed by the expected unauthenticated rejection/close 1008 on the existing
  extension endpoint. No pairing, database user, Chrome or model was started.
  Protected SSE correctly returns 401 anonymously; SSE 200/heartbeat and an
  authenticated live-browser session still require a legitimate Google session.
- Official Playwright MCP also exercised disposable account fixtures: missing
  agent onboarding, separately scoped Personal/Company login links, deleting
  pending Company consent, and completing Claude's returned-code flow. Screen
  widths 320/390/1600 fit. This is UX evidence, not real provider authorization.
- The fresh integrated browser regression passed **28/28** isolated fixtures:
  Codex/Claude accounts 16, Google 4, GitHub/company scopes 4 and Linear 4.
  Suites ran sequentially with one browser worker, CPUs 0–1 and nice 10.
- The subsequent full backend regression at `3a3adb3` passed **833/833**, with
  no skips or failures, one test process at a time on CPUs 0–1/nice 10. It
  includes local integration/operator fixtures, not real AWS or model calls.
- The earlier integrated run at `e22fd45` passed **859/859**, no skips or failures,
  with the opt-in official-MCP guest UI test enabled in that same sequential
  run (175.9 seconds, CPUs 0–1/nice 10). Separate finalizer Python checks passed
  10/10, including real shell fixtures. The new AMI bake uses that revision;
  these passing local checks are separate from the AWS boot acceptance above.

Parallel implementation checkpoint (2026-09-18):

- Claude: native manual-code ceremony, per-user named accounts, account-bound
  models/runtime and access-only worker renewal implemented. Independent review
  found and fixed cancellation-during-save and refresh-rotation durability races.
  Agent suite: 649 backend, 14 browser; final focused 41 regressions. Two expressly
  authorized isolated real Haiku turns returned OK, with native session resume;
  host credentials remained unchanged. Product browser consent remains open.
- GitHub: private native `gh auth login`, URL/code, explicit company scope and
  selected connection for repository/clone/PR/check operations implemented;
  PAT/host-import onboarding removed. Agent checks: 42 backend, 13 browser.
  Authorized isolated host-account read/clone/PR tests passed; a fresh user
  consent through the product remains open. Reconnect/stale-401 race fixed.
- Linear: OAuth/DCR/PKCE, attempt-bound UI success, cancellation rollback and
  read-only workspace verification implemented (37 backend, 4 browser).
  Live provider metadata was inspected, but real OAuth and selected-environment
  authenticated reads still require user consent. Fixture reads are not that gate.
- AWS: controller template/image/readiness/drain, private deployment-scoped
  worker baker, separate Doppler `code-web/stg_aws_mvp` secrets and immutable
  build/deploy scripts implemented. Actual HTTPS rollout and cold backup/restore
  and controlled failed-rollout recovery pass as recorded above. Fresh/resumed
  worker image acceptance passed; deployed authenticated integration checks
  remain open.
- Account deletion: reviewed backend/UI implementation removes a selected
  account without deleting its conversations. Integrated focused checks: 18
  deletion/API tests and 20 account/Google browser tests passed. Current local
  and AWS application versions include it; real accounts/data were not deleted
  for acceptance. The MCP fixture deletion is recorded separately above.
- Shared AWS CI: reviewed engine is pinned to `12-apps/ci` commit `848182b` in
  draft PR #98; its remote checks passed. Relay's opt-in, manual consumer is in
  PR #8 and integrated into PR #4. It remains disabled; no CI IAM role or GitHub
  environment has been activated.
- All integrated auth changes are saved in PR #4; feature PRs #5/#6/#7 retain
  their separate review/evidence. Existing unfinished doctor edits are untouched.

The user explicitly requires working **Codex, Claude, GitHub and Linear
authentication**, plus **a script to deploy Relay on AWS**, before the MVP is
usable. These requirements take priority over starting unrelated features;
the remaining queue and its unfinished acceptance checks are retained.
Google authenticates the Relay user only: it does not authenticate any of the
four integrations. A saved configuration, displayed login button, successful
mock or unauthenticated MCP handshake does not satisfy this gate.

| Required integration | End-to-end acceptance | Queue items / current gap |
| --- | --- | --- |
| Codex | Detect missing authentication; show a working Connect action and the supported native browser authorization URL/code. Complete sign-in from the user's browser, select a named account for the chat, run a consented real turn and resume that account after restart. Surface expired/revoked access and reconnect without falling back to the host CLI | 43/44: implementation and local/AWS activation passed; 16 account-browser fixtures pass jointly with Claude. Personal/umg are disconnected; fresh product consent and selected-account real turn/resume remain open |
| Claude | The same complete onboarding and reconnect path, using Claude's supported native authentication flow. The selected named personal/company account must actually be used for a consented real turn and restored after restart | 43/44: implementation, local/AWS activation, reviewed regressions and authorized isolated real turn/resume passed locally and on a fresh accepted AWS worker. Fresh product browser consent and selected-product-account execution remain open |
| GitHub | Native `gh auth login` in a private profile returns URL/code. No token entry, host import or second company step. All repositories GitHub permits for the user-owned connection are available; worker fetch/push/PR access stays bound to selected repositories/branches. Denied/revoked access never borrows another connection | 21: native onboarding and worker gateway active; removal of redundant GitHub company gate in progress. User-reported deployed Codex chat creation passed; full selected-connection clone/write/restart acceptance remains separate |
| Linear | Complete real browser OAuth, discover tools and perform a non-mutating authenticated workspace read through the selected agent/environment. Support independent g2i and 12-apps connections, including the same MCP name, with no cross-company credential fallback | 02/03/04/10/21: OAuth/DCR/PKCE, scoped environment integration and fixture workspace-read checks implemented and activated. Four browser fixtures pass; real browser consent and selected-environment authenticated workspace read remain open |
| AWS deployment | A documented, repeatable script deploys the complete application at a stable HTTPS URL, validates readiness, preserves data across updates and supports rollback; verify all four integrations on the deployed application | 45: authorized infrastructure, HTTPS rollout, backup/restore, failed-rollout recovery, fresh/resumed worker, isolated native Claude, real guest Chrome and public workspace upload passed. Product integration consent/selected-account execution, authenticated deployed transports, combined selected-GitHub→EC2 acceptance and remote app forwarding remain open |

Common authentication acceptance:

- Product clarification (2026-09-17): Relay is a multi-user product, not a
  personal terminal wrapper. All four login flows must be user-owned, including
  the administrator's; host-credential import and other single-user-only options
  must not appear in the product onboarding. Keep local development fixtures
  separate from the deployed multi-user interface.
- Keep multiple named Codex and Claude accounts per Relay user, including
  personal and company accounts. Make the selected account and availability
  explicit; enforce user/company boundaries in the backend, not only the UI.
  Test unauthorized cross-user/company access, restart, expiry, revocation,
  failed consent and reconnect. Do not silently import global CLI profiles.
- Show actionable setup errors. The reported MCP message requiring a
  pre-registered OAuth client is an unresolved setup requirement, not a
  successful connection. Configure the provider's client ID/secret and allowed
  callback where required; do not assume dynamic registration is supported or
  show “Saved” as proof of authenticated access.
- GitHub onboarding clarification (2026-09-17): request only the inputs needed
  for native `gh auth login`, then display the authorization URL and code.
  Keep the first screen simple; optional naming can follow authentication.
  The 2026-09-18 clarification removes the GitHub company step.
  Remove both personal-access-token entry
  and the host-login import button. Use a separate private `gh` profile for each
  Relay account; do not switch or reuse the developer's active global account.
  This refines the already-required GitHub MVP login, not a new parallel feature.
- Keep controller-managed secrets encrypted at rest and out of browser
  responses, logs, source control and build artifacts. Describe the actual
  native CLI credential delivery boundary: local workers share the host
  filesystem, while isolated cloud workers provide a stronger boundary. Do not
  promise credential isolation that the chosen native flow does not provide.
- Record automated regression evidence separately from real OAuth consent and
  authenticated runtime checks. The user performs account consent; do not
  authorize accounts or send real agent prompts automatically for a test.
  An externally blocked check remains open with its exact prerequisite.

### 45 — AWS deployment ownership and acceptance

The user permits adding reusable AWS support to `12-apps/ci` if appropriate.
Reference review found only DigitalOcean and Cloudflare in that repository's
current `main` vendor registry; there is no registered AWS deployment adapter.
Use its vendor-extension pattern for the shared AWS implementation, with a thin
Relay-specific consumer. That was the original implementation plan. The pinned
shared engine is now implemented and exercised by the operator deployment
recorded above; the proposed CI workflow remains opt-in, unmerged and inactive.

- **In `12-apps/ci`:** add a reusable AWS adapter, vendor registration and
  explicitly enabled caller job, off by default. Consume the already-built
  immutable image/artifact rather than rebuilding source during deployment.
  Provide configuration/preflight validation, resource/deployment status,
  health-gated rollout and rollback, and regression coverage preserving the
  existing providers. Destructive cleanup must be a separate explicit action.
- **In Relay:** provide the deploy script/entry point, application descriptor,
  image/runtime configuration and an operator runbook, consuming the shared
  implementation without duplicating its engine. Verify the shared workflow
  can be consumed by this repository outside the `12-apps` organization before
  depending on private cross-repository Actions access. Use a compatible
  published shared-workflow revision; do not assume existing `@v2` includes AWS.
- **Infrastructure and secrets:** document AWS account, region, network,
  resource sizes/costs and prerequisites. Prefer least-privilege IAM roles and
  CI OIDC over long-lived AWS keys. Scope Doppler to the intended deployment
  environment; never reuse the local `dev` configuration implicitly for
  production or bake OAuth/provider/Doppler credentials into images.
- **Remote authentication and transport:** configure stable HTTPS, secure
  cookies, canonical origin and every required registered OAuth callback.
  Verify native agent login from the user's browser when Relay runs remotely,
  without assuming the user can reach the server's localhost callback. Verify
  SSE, Chrome WebSockets and chat application forwarding through the proxy.
- **Durability and rollout:** persist the controller database, encryption key,
  account records and conversation/attachment data independently of disposable
  workers. Exercise backup/restore and an upgrade/rollback with retained data.
  Gate success on real application/database readiness, not a static proxy 200
  or an unexamined authenticated-endpoint response. Do not copy future-pay's
  dual-instance rollout blindly: establish whether Relay's controller can run
  concurrently, and document downtime if the safe strategy is single-instance.
- **Delivery proof:** script validation/dry-run and regression tests first;
  then an explicitly authorized AWS deployment, authenticated browser smoke
  checks for the four required integrations, and worker start/stop/resume with
  conversation preservation. Agree on the AWS account/region, costs and
  permissions before creating billable resources. A merged workflow alone is
  not deployed-MVP acceptance.

References inspected for this request:

- [future-pay root DEPLOYMENT.md](https://github.com/12-apps/future-pay/blob/main/DEPLOYMENT.md)
  and its [CD caller](https://github.com/12-apps/future-pay/blob/main/.github/workflows/cd.yml):
  shared `12-apps/ci` orchestration, application-specific configuration,
  health-gated updates, rollback and runtime secret injection. The root guide,
  not the older `docs/DEPLOYMENT.md` static-site guide, is the reference here.
- [12-apps/ci deployment framework](https://github.com/12-apps/ci/blob/main/.github/deploy/README.md),
  [vendor registry](https://github.com/12-apps/ci/blob/main/.github/deploy/targets.json)
  and [consumer guide](https://github.com/12-apps/ci/blob/main/CONSUMING.md):
  vendor adapters, prebuilt artifacts and explicitly enabled deployment jobs.
- [Relay EC2 worker notes](../deploy/aws/README.md): existing worker/AMI
  scaffolding, not a complete controller deployment script. Its gateway/API-key
  examples do not demonstrate the newly required Google and native-account
  onboarding on AWS.

## Ordered feature queue

| # | Request / acceptance condition | State |
| --- | --- | --- |
| 01 | Render Markdown and HTML; isolate snippet CSS and malformed/unclosed tags from the chat UI | Delivered: seven targeted browser checks pass; genuine saved HTML renders and survives reload on the live application at 1600/900/320px, with unchanged message hashes. Live mobile PR-bar overflow fixed and covered |
| 02 | Sidebar MCP manager; environment selection configures the chosen agent with those servers | Required for the MVP Linear gate: prior real Codex/Claude MCP discovery and environment/browser checks; deployed manager acceptance and provider runtime configuration still pending |
| 03 | Preconfigured development MCPs, including Linear and Atlassian | Reopened for delivery: prior seven-provider endpoint and preset UI checks; current deployed acceptance pending |
| 04 | Custom MCPs, including browser OAuth installation of `https://paladira.com/api/mcp` | Reopened for delivery: prior live discovery and local consent fixture; actual user authorization/authenticated acceptance pending |
| 05 | Store conversation/context usage outside disposable containers; continue viewing after stop | Reopened for delivery: prior stop/restart, real PostgreSQL reload and stopped-chat browser checks; current saved-data acceptance pending |
| 06 | Composer Up/Down recall at text boundaries, previous/next messages and draft restoration | Reopened for delivery: prior boundary/draft/chat-isolation unit and browser checks; current deployed acceptance pending |
| 07 | Hover/touch message rail shows sent-message list; selection jumps to the original message | Reopened for delivery: prior hover/mobile open, focused jump, visible target and Escape checks; current deployed acceptance pending |
| 08 | Desktop HTML and other document previews occupy a third column, like workspace changes | Reopened for delivery: prior geometry, scrolling, document-type and mobile checks; current deployed acceptance pending |
| 09 | Answer whether pages use WebSockets, distinguishing chat updates from browser streaming | Answered: Chrome uses WebSocket; chat/sidebar use SSE; commands/settings use HTTP |
| 10 | Independent per-organization MCP accounts, e.g. two Linear workspaces | Reopened for delivery: prior same-name, company filtering and credential/revocation checks; deployed scope/account acceptance pending |
| 11 | Delete chats from Organize; confirm target and preserve other chats | Reopened for delivery: prior confirmation/cancel, target-only deletion, errors and other-tab checks; deployed disposable-chat acceptance pending |
| 12 | Compact single-line sidebar chats, without the Idle/age sub-row | Reopened for delivery: prior row geometry, inline actions and accessible status checks; current deployed acceptance pending |
| 13 | Reasonable default styling for unstyled HTML | Reopened for delivery: prior typography, table alignment and author-CSS override checks; current deployed acceptance pending |
| 14 | Improve composer / command UI | Reopened for delivery: prior responsive controls, agent switching and command-picker interaction checks; current deployed acceptance pending |
| 15 | Make the specified chat itself a real long-chat rendering example, not a personal-folder copy or invented messages | Awaiting real source chat/transcript. The earlier startup preserved 269 genuine and 241 historical sample records; the database used for the later Google activation already had zero chats. Neither checkpoint fulfills this request |
| 16 | Private, persisted Chrome connections per user; authenticate separately, anonymous browser by default, top-right opt-in for agent access | Reopened for delivery: prior real-extension, private-profile, consent/revocation/restart and cross-user checks; current deployed setup acceptance pending |
| 17 | Queued follow-up questions must be clickable and answerable | Reopened for delivery: prior options/text/skip, retained-draft and stale-reply checks; current deployed acceptance pending |
| 18 | `/plan` works from the web composer | Reopened for delivery: prior task/read-only, busy-queue and failure-preservation checks; current provider runtime configuration and deployed acceptance pending |
| 19 | Send now on individual queued messages, retaining the rest | Reopened for delivery: prior interruption/FIFO, Stop race, retry, attachment and draft checks; current deployed acceptance pending |
| 20 | `/goal` and every available native/installed slash command work, without unsupported-terminal placeholders | Paused for the user's priority delivery re-audit of 01–14/16–19; preserve doctor MCP work, then resume remaining gaps in `command-support.md`; provider runtime/deployed native acceptance pending |
| 21 | GitHub follows provider permissions without an extra company step; agents, environments and MCPs retain company availability. No cross-user credential fallback, including secondary repos | MVP refinement in progress: remove legacy GitHub-only gate while retaining explicit connections and exact repository/branch worker grants. Historical company-save requirement superseded; full integration acceptance tracked separately |
| 22 | Resize sidebar, chat and third-column panels | Existing source; dedicated interaction verification pending |
| 23 | Shared Chrome viewport presets: xxs, xs, sm, md, lg, xlg | All six passed on an actual isolated AWS guest at DPR 2; authenticated deployed-product acceptance remains open |
| 24 | Resizing changes the actual viewport correctly, without stretching or needing a new tab | Actual isolated AWS guest passed same-tab/document resizing and revisit with preserved input; authenticated deployed-product acceptance remains open |
| 25 | Paste cropped/copied images and files into the focused composer | Existing source; pending ordered verification |
| 26 | Long chats mount a bounded message subset, retaining history navigation and reducing DOM memory | Source/tests exist; full verification pending, including intermittent Jump to latest detachment during automatic paging |
| 27 | Auto mode handles the reported local IPC/tool approval without manual prompts | Source policy fix exists; exact native/live case unverified |
| 28 | Remove invented rendering messages; do not inject browser activity into agent context; use official Playwright MCP when requested | Earlier checkpoint retained 241 tagged records; no cleanup completion is claimed from the later empty-database checkpoint. Official dependency installed, integration not implemented |
| 29 | Sharp, non-opaque browser output at every viewport, including sm/md/lg/xlg, after resizing | Actual isolated AWS guest passed exact DPR-2 sharp pixels at all six sizes; md/xlg screenshots visually inspected. Authenticated deployed-product acceptance remains open |
| 30 | Visible chat tabs and browser interaction pause idle sleep/countdown | Source/tests and actual isolated AWS guest viewer-presence checks passed; full deployed idle/countdown acceptance remains open |
| 31 | Attachment images are clickable to inspect before and after sending | Existing source; pending ordered verification |
| 32 | Direct native-browser app URLs per chat, preserving port/path; remote HTTP and WebSocket forwarding too | Local aliases implemented; remote forwarding pending |
| 33 | Compact always available; send native `/compact`, queue while busy, retain draft, no misleading Claude/idle tooltip | Source, FIFO, browser and real-CLI/local-stub checks passed; provider runtime/deployed native acceptance pending |
| 34 | Hide internal `<relay-title>` metadata from streamed/saved responses; no bogus HTML previews | Queued; cause inspected, fix not started |
| 35 | Notify the agent when PR checks fail; if the container is stopped when checks pass, wake it and deliver a GitHub event message | New report appended; not started |
| 36 | Subscribe to GitHub PR/check/auto-merge events for prompt UI status updates, with polling as a reconciliation fallback | New report appended after clarification; not started |
| 37 | Composer attachments use one row of image thumbnails and file cards above the text, matching the supplied screenshots. Every card is clickable: large image preview; scrollable text-file preview with filename, size and line count, for both draft and sent attachments | New report appended and clarified with image + file examples; not started |
| 38 | Drag and drop files and images onto the chat to attach them to the current draft without sending automatically; preserve existing text/attachments and apply the same validation and previews | New report appended after item 37; not started |
| 39 | Add a saved-prompts composer dropdown: truncated prompt rows with per-row (…) edit/delete menus, + Prompt and edit popups, drag-to-reorder, and availability for selected projects or all projects. Clicking a prompt inserts it into the composer without sending | New feature appended after item 38; panel sketch and interactions captured; implementation not started |
| 40 | Search across messages the user wrote and the AI's final answers, with conversation/result navigation. Do not store or index reasoning/chain-of-thought for this feature; exclude tool activity and intermediate responses from results | New feature appended after saved prompts; search-screen reference received; not started |
| 41 | Deleting a worker/container must preserve the chat and its messages outside disposable storage; only explicit chat deletion removes the conversation. Reproduce actual container deletion independently of stop/restart, using disposable fixtures | New data-loss report appended; item 05 stop/restart verification does not establish container-deletion safety; not started |
| 42 | Explore and implement a third-column panel showing the main agent's active secondary agents, with native status and supported conversation details. Selecting a secondary agent opens a popup/composer for prompts addressed to that agent, including while it is working; retain accessible keyboard navigation and keep the main agent/conversation independent. Investigate actual Claude Code/Claude web and Codex capabilities, reusing item 20's Codex descendant-navigation work where applicable. Do not invent child sessions or claim unsupported native messaging/steering | Codex feasibility confirmed read-only: descendant listing, status and direct input/steering are available, with experimental API caveats. Claude capability investigation and the requested both-provider panel/popup remain queued, not implemented |
| 43 | Detect missing agent authentication; show Codex and Claude sign-in actions and browser authorization URLs instead of an empty agent picker | Both providers' native onboarding is implemented and active, with account-scoped progress/link/code/retry UX. Integrated fixtures pass. Personal/umg need fresh consent; selected-account real turn/resume remains open. No global profile is imported |
| 44 | Authenticate Relay users with Google using `@12-apps/auth`; persist data privately per user and support multiple named Claude/Codex accounts (personal/company), explicitly selected per chat with no credential fallback | Google identity and both providers' named accounts are implemented and active locally/AWS. Persistence, isolation, explicit binding and access-only renewal pass automated checks. Fresh product consent, selected-account real turns and deployed restart/resume remain open |
| 45 | Provide a repeatable AWS deployment script for the complete Relay application, following future-pay's deployment guidance; add reusable AWS support to `12-apps/ci` and keep Relay a thin application-specific consumer | Shared engine and Relay operators implemented. Authorized HTTPS/readiness/anonymous denial, backup/restore, failed-rollout recovery, fresh/resumed worker, isolated native Claude, real guest Chrome and public workspace upload passed. Product consent/selected-account runtime, authenticated deployed transports, combined selected-GitHub→EC2 and remote app forwarding remain open; MVP is not complete |
| 46 | Delete a saved agent account, separately from disconnecting it; confirm the specific account, remove its stored credentials, prevent other-user deletion, and retain conversations without silently selecting another account | Implemented as the requested account-lifecycle refinement and active locally/AWS. Exact-account deletion, cancellation, cross-user denial and conversation retention pass backend/browser fixtures. No real user account was deleted for acceptance |

## Verification ledger

- Codex post-consent correction (2026-09-18): the user confirmed OpenAI approved
  login while Relay failed verification. Reproduced with installed Codex 0.154.0
  and a loopback OAuth issuer: `account/login/completed` success can precede
  account-cache readiness, despite an existing native credential file. Added
  bounded null-only account-read retries after matching native consent, plus
  safe final-verification diagnostics. No host credentials are adopted and
  credential-file validation stays strict. The regression failed before and
  passed after the fix. **33/33 focused account/server** and **14/14 browser**
  tests passed; **five real-executable fixture logins** passed, including four
  transient-null reads. Zero real tokens, real consent or model turns in this
  smoke. User consent and the authorized real-turn/resume gate remain pending.
  The local controller was no longer running when work resumed; activation
  with the existing database is the next step, not assumed completed.

- Codex reconnection refinement (2026-09-17): replaced reopening the saved
  account's name/company form with a one-click Reconnect action inside its card.
  It retains the exact account ID and access scope, shows immediate progress,
  hides stale errors during the attempt and renders a failure only once. New
  account creation keeps explicit company selection, with extra company inputs
  and the longer access/storage explanation behind expandable controls.
  **13/13 account/Google browser tests** and **28/28 focused account/server tests**
  passed; **15/15 account/client tests** passed again after final message hardening.
  The new browser regression covers failure, retry, original scope preservation,
  no duplicate account and no repeated form. Reviewed the shorter dialog capture.
  The reported login failed about 15 seconds after entering pending state;
  the previous client applied a 15-second deadline to initialization and code
  issuance and discarded the underlying stage. An isolated native probe with
  the live configuration succeeded (8.3-second initialization, 0.55-second code
  issuance), so the historical failure's exact cause is not proven. Both startup
  stages now have separate bounded 60-second deadlines and fixed stage-specific
  errors; native tokens, codes, URLs and raw error strings are never forwarded.
  A second native probe succeeded with the new deadlines (6.9-second initialization,
  0.57-second code issuance), then cancelled and removed its private profile.
  Neither probe granted consent or submitted a model prompt.
  The user authorized “Responda apenas OK” through Personal. A restart preflight
  detected its live pending login and stopped before touching the server/data.
  That flow then expired without completion, and its native process exited.
  After verifying no remaining pending logins or chats, Relay was restarted
  with this version through Doppler. Backup `relay-before-reconnect-HscGUw` was
  verified offline; all **12 then-existing encrypted record payloads** and the
  credential file remained byte-for-byte unchanged. Both named accounts were
  disconnected before and after the restart; no previous credentials were
  restored from backups. Google remains configured, anonymous account access
  remains 401, and the served account/picker/style files match the source.
  Personal must complete fresh user consent before the already-authorized
  real-turn/resume check. No real model prompt has been submitted.
  The two final mobile/reconnect browser checks also passed after message
  wording was shortened for a multi-user product.
  At this historical checkpoint the separate Delete account request was
  appended as item 46 and was not implemented. The later integrated account
  deletion implementation and current acceptance status supersede that note.

- Codex sign-in UX follow-up (2026-09-17): Add account now explicitly expands
  or collapses a focused form and retains the unsent name/company selection.
  Submission immediately displays Connecting and disables duplicate requests.
  Each account card owns its sign-in status, link/code and Copy/Cancel controls;
  reopening the dialog automatically restores pending details. Previously,
  the backend could announce pending before code issuance, while the UI treated
  missing details as "Sign-in is not pending" and ignored still-pending poll
  updates. That transition is now handled, with stale-response guards and
  independent account controls. All **12 account/Google browser scenarios** have
  passing runs, and **25/25 focused account/server checks** pass, with one
  worker/two CPUs/nice 10.
  Cases cover slow issuance/reload, distinct simultaneous codes, copy/open,
  cancellation races, failure/retry, draft retention and mobile layout. Reviewed
  mobile and multi-account screenshots. These tests use offline consent fixtures.
  The user's separate real Personal sign-in is confirmed by their screenshot and
  a read-only encrypted-record check; the verifier printed no credentials and
  made no account writes. A subsequent browser run exposed a server-teardown
  race: an already accepted request could finish its asynchronous owner lookup
  after stream cleanup and then open a new SSE stream. Four deterministic
  regressions failed before the fix and passed afterward; API dispatch now
  rejects these late requests while restarting. Two later full browser runs
  each passed 11/12 and hit Chromium's `ERR_NETWORK_CHANGED` before fixture
  consent (on `/api/auth` and `/api/auth/csrf`, respectively). These were not
  clean full-suite passes; the affected cancellation scenario subsequently
  passed **two consecutive isolated reruns**. No assertion or authentication
  requirement was relaxed.
  Under the user's standing authorization, Relay was then restarted through
  Doppler with the same settings after checking for active chats/pending consent.
  The offline backup `relay-before-codex-ux-K5wRZH` was verified before startup.
  All **13 encrypted record payloads** and the credential file remained identical,
  Personal stayed connected, Google was configured and anonymous account access
  remained 401. The database had zero chats before and after this restart.
  Real model execution and chat/account resume after restart remain open; no
  real prompt was submitted automatically.

- Authorized Codex activation (2026-09-17): stopped the original Relay and
  embedded PostgreSQL cleanly, copied both the control database/credential
  directory and application data into the private local backup
  `relay-before-codex-WlhgAG`, and verified the copies before restarting.
  Relay now runs the current branch at `http://localhost:8787` through the
  repository's Doppler launcher (`code-web/dev`), with the same data paths,
  PostgreSQL port 55438, namespace isolation, no mock provider, CPU affinity
  0–1 and nice 10. All **10 encrypted record payloads** and the local credential
  file retained identical fingerprints; all records decrypt successfully.
  Google reports configured, the served account module matches the current
  source, and anonymous account API access returns 401. These are live backend
  and static-serving checks, not a claim of authenticated UI acceptance.
  At that checkpoint, user consent, a consented real turn and account/chat
  resume after restart were still open. The later UX follow-up above confirms
  Personal account consent. No model turn or account authorization was performed
  automatically.

- Codex native follow-up (2026-09-17): the production controller client and
  installed Codex 0.154.0 successfully requested a real device-code URL/code
  from the native service, then cancelled the flow. Both account reads stayed
  unsigned-in, no credential file was created, and the private temporary
  profile was removed. No consent was granted and no model turn was sent.
  PR #4 is saved remotely as a draft; its GitGuardian check passed, with no
  GitHub Actions test runs configured/reported. The original live Relay
  process on `localhost:8787` is still running unchanged; restart permission
  and the real consent/turn/resume acceptance remain pending.

- Codex named-account implementation checkpoint (2026-09-17): **621/621 full
  backend tests** passed, with no skips. A final consent-binding audit then
  passed **44/44 focused tests**, including one new regression preventing
  approval/feedback/logout/desktop records from crossing named accounts.
  **7/7 account/Google browser checks** and **8/8 existing model-controls browser
  regressions** passed; all 30 changed JavaScript files passed syntax checks.
  Runs used one test worker, CPU affinity 0–1 and nice 10. The account browser
  checks exercise offline consent, two users, personal/company accounts,
  explicit chat selection, mobile cancellation and disconnected access.
  The installed Codex 0.154.0 accepted a fictitious external-token login and
  completed account/read and logout without creating worker `auth.json`;
  this transport check used no real credentials and sent zero model turns.
  No real Codex OAuth authorization or paid-account execution is claimed.
  The live `localhost:8787` backend has not been restarted with this feature;
  user consent, a separately authorized minimal turn and live restart/resume
  remain release gates. See [codex-accounts.md](codex-accounts.md) for storage
  boundaries and the acceptance steps. The unfinished doctor changes remain
  paused and are excluded from this feature's commit.

- MVP scope update (2026-09-17): recorded Codex, Claude, GitHub and Linear
  authentication as mandatory end-to-end gates and appended AWS delivery as
  item 45. Inspected future-pay's root deployment guide and the shared CI
  deployment contract; the remote `12-apps/ci` main vendor registry lists only
  DigitalOcean and Cloudflare. The user permits a reusable AWS extension there.
  This checkpoint changes requirements only: no provider login implementation,
  CI workflow change, AWS provisioning or live deployment is claimed.

- Google activation (2026-09-17, after the pre-activation checkpoint below):
  the user supplied the owner setting in Doppler and authorized startup with
  existing data. An offline encrypted backup preceded activation. All five
  existing non-auth records retained their encrypted payloads, the database
  already had zero chats, and no worker or real model turn was started.
  The canonical origin is `http://localhost:8787`; Google is configured and
  unauthenticated chat/configuration/environment/GitHub API requests return
  401. The user subsequently completed real Google sign-in. The reported empty
  Agent picker/“Invalid agent” and missing Codex/Claude Connect actions remain
  unresolved; this is not successful agent onboarding. A reported MCP request
  for a pre-registered OAuth client also remains an open setup gate, not proof
  of completed Linear or other MCP authentication.

- Authentication implementation, pre-activation checkpoint (2026-09-17): installed the published
  `@12-apps/auth@2.21.0` server factory, not a framework rewrite. Google login,
  stable per-user identity, revocable encrypted sessions and user-specific
  GitHub/MCP/environment/group/preference namespaces are implemented. Dedicated
  offline OAuth/browser coverage is recorded in `docs/google-login.md`:
  **86/86 selected API/runtime/launcher checks**, **4/4 Google browser checks**
  and **8/8 legacy document/PR/Chrome browser regressions** pass. The auth build,
  changed JavaScript syntax and diff checks pass; one test worker, two CPUs,
  nice 10. Browser tests use disposable offline fixtures, not the saved database.
  At that checkpoint no real Google account had been authorized and the live
  process/data had not been changed by the implementation. With the user's
  Doppler CLI authorization, the repository was scoped to `code-web/dev`; a
  value-redacted check confirmed both Google client settings were present.
  `AGENT_OWNER_EMAIL` was then missing; the later activation above resolves
  that prerequisite. `npm run start:google` / `npm run dev` use Doppler, reject
  wrong project/config metadata and do not write secret fallback files or pass
  the Doppler token to Relay. Multiple native
  provider-account login/selection remains unfinished, not an implied result
  of Google sign-in.

- Priority delivery acceptance, 01 (2026-09-17): after explicit user startup
  consent, backed up the existing encrypted control directory offline, then
  started the current application against that database and its existing
  workspace. Before/after message and queue hashes match: **1 chat, 510
  messages, 0 queued inputs, 0 started workers**. The 241 historical tagged
  samples remain preserved, not regenerated, removed or used for this check.
  A fresh sandboxed Chromium profile opened a genuine saved HTML answer through
  the message navigator and preview controls on port 8787. Chat HTTP and SSE
  responses were not replaced; mutations other than ephemeral presence were
  blocked by the verifier. Eight served asset hashes matched the current files.
  Opaque-origin isolation, table rendering, Escape, reload and 1600/900/320px
  layouts passed twice, with no page errors, blocked mutation attempts or
  changes to messages/workspace. Local screenshots and receipts stay outside
  Git; no personal Chrome profile or external authorization was used.
  The first live check reproduced **404px document width on a 320px screen**:
  the PR bar's implicit minimum grid track expanded to fit its branch. An
  explicit `minmax(0, 1fr)` track now contains it while retaining the full
  branch title and visible PR/change/CI/close controls. A separate intercepted
  PR-metadata layout fixture covers that regression at 1600/900/390/320px;
  it is not presented as a live GitHub integration check. The combined document
  and PR regression suite passes **7/7**, syntax and diff checks pass, one
  worker/two CPUs/nice 10. The live verifier initially injected Playwright's
  `serviceWorkers: "block"` script, which itself throws when reading
  `navigator.serviceWorker` in an opaque iframe; that unnecessary test-only
  injection was removed, not the product sandbox. An earlier reload timeout
  was not reproduced in the final two runs and is not claimed as a separate
  fixed application defect. Item 01 closes; item 02 is next. Runtime agent
  authentication and the other priority acceptance gates remain open.
- Priority delivery re-audit, 01 (2026-09-17): added
  `test/browser/delivery-preview.spec.mjs`. Unlike the previous rendering
  fixtures, it sends through the actual composer, receives the server's SSE,
  verifies stored user/assistant messages through HTTP, sends a second turn and
  reloads that same conversation. The mock provider and in-memory database are
  explicit test dependencies; no chat API/event response is intercepted.
  Malformed HTML, Markdown tables, CSS isolation, opaque sandbox, stripped
  scripts/frames and 1600/900/320px layouts pass. A separate loopback HTTP
  receiver confirms zero escaped preview requests; iframe load completion is
  awaited, rather than confusing browser-reported blocked attempts with network
  delivery. Desktop/mobile screenshots were inspected. The new test and four
  existing document checks pass **5/5**, syntax and diff checks pass, with one
  worker/two CPUs/nice 10. Two initial test-authoring assertions were corrected:
  the mock prefix required a separate heading paragraph, and request events
  needed the actual receiver check. No product fix or deployment is claimed.
  Only disposable fixture conversations were created/deleted; real chats,
  accounts, saved profiles and application/database processes were not changed.
  Item 01 remains open for the saved-data application startup/acceptance;
  permission to start it has been requested. Item 20 stays paused.
- 20: actual **2.1.222** reproduced a plugin still executing after `/doctor`
  saved its disablement. Diagnostic readback now compares an opaque fingerprint
  of the effective native plugin settings and reloads that same owner before
  completion/FIFO. Unchanged, declined and policy-overridden settings do not
  reload. Errors, Stop, Send now and revoked capabilities retain receipt/stale
  publication guards; partial reloads cannot authorize Send now. Six added
  unit/transport checks pass; syntax/unit **587/587**, targeted **131/131** and
  Claude command browser **48/48**. Real local-marketplace/user/project skill
  fixtures verify disabled model invocation, retained skills and source files,
  immediate native/web catalogs, consent/refusal and Stop/resume. The retained
  app keeps its PID/data; other-chat catalogs remain unchanged. Native success,
  cleanup refusal and pending-question Stop cases pass with **33/27/13** authored
  replies. The **23**-reply one-shot skip scenario also passes; its eleven cold
  query startups exceeded the original aggregate fixture timeout, so only this
  extended harness budget increased, not per-query or production timeouts.
  The explicit plugin reload/app regression passes **15** main replies and
  **2** titles. Broader doctor checks, including MCP cleanup, still need
  acceptance; this is a checkpoint, not completion of item 20. **24 open items**,
  same order; no live service, user profile or installation changed.
- 20: private `/doctor` and `/checkup` now have shared-host admission guards,
  literal FIFO/attachments and diagnostic-safe file checks. Actual **2.1.222**
  diagnoses malformed user/project JSON without repairing it, deduplicates local
  memory only after cleanup consent and applies an exact local read rule only
  after separate permission consent. Denial/skip preserve their respective
  files/rules; a retained app/PID/data survives until Stop, then the same journal
  resumes. Native readback does not invent settings from errors, overwrite newer
  choices or cross ownership. Syntax/unit **581/581**, command browser **48/48**;
  six real-CLI cases with **5–13** authored replies, including Stop during a
  pending question with unchanged files and retained paused queue; the native
  retained-project `/update-config` regression passes **7** replies. An intervening
  full-suite repeat was **580/581** (Chrome connection username-field visibility
  timeout); the unchanged isolated Chrome test passed **1/1** and the final full
  run passed **581/581**. Its intermittent cause is not established or claimed
  fixed. Broader doctor checks still need
  effect acceptance; stay on item 20 before the next command. No live
  activation or account/installation changes; **24 open items**, same order.
  Read-only Codex feasibility confirmation for queued item 42: the existing
  descendant picker already uses `thread/list/read`, status notifications and
  direct `turn/start`/`turn/steer`. Official OpenAI documentation confirms these
  primitives ([app-server](https://learn.chatgpt.com/docs/app-server#api-overview),
  [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)).
  This is not implementation of the requested both-provider panel/popup; that
  remains queued. No secondary agents were spawned for this investigation.
- 20: explicit private Claude workspace trust now has an exact-path inspection,
  unchecked confirmation and five-minute actor/chat/scope/worker-bound review.
  Shared host profiles, unsafe/linked paths and broader native trust roots stay
  locked. Stop, expiry, scope/account revocation and uncertain replies cannot
  automatically retry a grant. The separate control-only native CLI reuses the
  current capability without moving the conversation or restarting its app.
  Actual **2.1.222** verifies the product consent flow, no inference/history
  changes, saved trust, and approval reduction after granting trust to an
  already-running untrusted application's owner; HTTP app/PID/data survive.
  Untrusted, refused-write and ordinary trusted cases also pass, preserving
  exact argument boundaries and native ask/deny rules (**16/18** authored
  replies). Eight unit/HTTP/adapter/transport additions (including idle-timeout
  protection and queue retention) and five desktop/mobile browser checks pass:
  syntax/unit **572/572**. The broad browser run was **212 passing / 4 failed**
  with `ERR_NETWORK_CHANGED` in each failure trace. Re-running all four affected
  suites plus the five new trust checks in a loopback-only namespace passes
  **36/36**; no new all-green full-suite result is claimed.
  This closes the private consent subtask below, not item 20's remaining command
  effects or company/account/live gates. The requested both-provider subagent
  panel is appended as item **42**, making **24 open items**; no queue reorder.
- 20: classified `/fewer-permission-prompts` as a private mutating prompt,
  blocking shared-host history/settings access before startup, accepted input
  or queue writes. Literal arguments/files, FIFO and native settings readback
  are retained. Actual **2.1.222** testing found project allow rules ignored
  before workspace trust, including pre-existing rules; a saved/effective
  settings entry does not prove it is authorized. The lost startup warning is
  now visible without raw private paths or trust-latch editing instructions.
  Native private history scan, exact project merge, real approval reduction,
  extra-argument refusal, original ask/deny rules and Stop/resume pass; refusal
  and untrusted cases preserve the native gate (**16** authored replies).
  Retained app/PID/data cases pass for trusted and untrusted workspaces (**18**).
  Trusted fixtures use the actual native consent handshake with an authored
  acceptance, never a seeded latch or bypass. Five unit/session/controller and
  two responsive browser additions: syntax/unit **564/564**, command browser
  **46/46**; native app/config and app/debug regressions **7/5** replies.
  At this earlier checkpoint, explicit web workspace-trust consent was still
  unfinished; the next ledger entry above completes that private setup.
  Item 20/count/order and account/company/live gates remain open. Save this
  verified checkpoint to PR #2; no deployment or live-account/data changes.
- 20: reproduced `/batch` cancelling its five native worktree agents when the
  launching reply ended, then reproduced FIFO releasing after the first of
  five reports. Bound background Agent/default-async lifecycle now retains the
  owner; synchronous Agent completion telemetry is distinguished from actual
  queued reports. Native notifications drain individually, including errors
  without tokens; each report is persisted before releasing its queued user
  input. Send now waits for actual per-task/per-report cancellation receipts,
  preserving the worker and unrelated Relay queue entries. Installed 2.1.222
  verifies real five-worktree edits/tests/CLI effects, plan refusal, app/PID/data
  retention and Stop/resume with private authored inference and no remote Git.
  Seven unit and two responsive browser additions: syntax/unit **559/559**,
  command browser **44/44**, full browser **210/210**. Native research early/FIFO
  and report-cancellation app regressions pass (**20** replies each). Concurrent
  smokes identified a native Git commondir-creation race; the actual tool error
  stays visible. Authored agent recovery retries only an unstarted unit, never
  a Relay transport replay. Deterministic native invalid-agent recovery passes
  with all five units' effects and the app preserved (**46** replies). Neither
  Git/native policies nor real accounts are modified. Item 20, queue count/order
  and account/company/live gates remain open; save to PR #2 without deployment.
- 20: reproduced `/debug` advertising a nonexistent log because native
  diagnostics were category-filtered and redirected to stderr. Explicit debug
  now records subsequent actual diagnostics in a bounded, credential-redacted
  private worker file; ordinary use stores no pre-opt-in diagnostic history.
  Its native SDK owner survives the reply for reproduction without restarting
  an existing application. Capture closes on Stop/sleep/process exit; linked,
  replaced or oversized targets fail closed, and shared-host logs are blocked
  before startup/queue writes. Cancellation preserves the native checkpoint,
  queued input and existing app; capture errors are visible without raw logs.
  Installed **2.1.222** verifies native file creation/Read and following turns,
  retained HTTP app/PID/data and same-history Stop/resume (**3/5/6** authored
  main replies). Twelve unit/session/controller additions and one browser
  addition; syntax/unit **552/552**, full browser **208/208**. A stalled unit
  fixture was corrected to wait for the actual native lifecycle-start event,
  with delayed-start coverage; production event guards were not weakened.
  Native regressions pass: loop ordinary resume/timed fire **11**, dynamic
  cancellation **7**, first-app Send now **8**, retained local configuration
  Stop/resume **7** replies. Other commands/company/account/live gates remain;
  queue count/order unchanged. Commit/push to PR #2, no deployment, merge,
  live-service restart, personal-profile reads or live-chat changes.
- 20: reproduced and fixed `/update-config` missing project/local configuration
  changes. Native SDK `get_settings` now supplies the real effective merge
  before/after the unchanged prompt; only model/default mode are returned,
  without raw sources, credentials, env or hooks. Readback finishes before a
  one-shot owner closes and does not restart retained applications. Refusal,
  invalid configuration and cancellation fail visibly without late publication;
  failed first inspection cannot advertise a nonexistent native journal.
  Installed **2.1.222** verifies user/project/local writes, higher-priority local
  overrides, denial, same-history Stop/resume and real app/PID/data preservation
  (**5** main replies per ordinary variant, **7** with an application).
  Six unit/session additions; syntax/unit **540/540**, browser **67/67**, native
  app Send-now regression **8** requests. This closes the private configuration
  scope/retained-owner checks from the previous checkpoint. Item 20's remaining
  commands and account/company/live gates stay open; no later feature started,
  no live service/profile/data changes. Commit/push to PR #2 before proceeding.
- 20: reproduced `/update-config` saving a private native model while Relay
  kept the previous web selection. It now participates in guarded native
  settings readback, FIFO and newer-choice reconciliation without parsing
  free-form prose as assignments. Empty/help variants cannot evade the
  shared-host mutation guard; reference attachments remain supported.
  Installed **2.1.222** verifies actual private settings writes, native denial,
  next-turn model/environment effects and same-history Stop/resume (**5/5/5**
  authored main replies). `/dataviz` verifies native resource extraction,
  Read/Bash/Write effects, valid light/dark and invalid palettes, HTML/SVG
  creation, denial and fresh private assets after Stop/resume (**7/4/14**
  replies). `/design-sync` verifies resources and the real unauthenticated
  authorization refusal (**3** replies); it does not upload or authorize an
  account. Four unit additions; syntax/unit **534/534**, browser **67/67**.
  Project/local configuration precedence and retained-owner checks remain
  before closing that command. Other commands and account/company/live gates
  remain in `command-support.md`; no queue item is newly closed. All native
  fixtures are disposable and loopback-only; no real inference, personal
  profiles or live services were used. Save to PR #2 without merge/deployment.
- 20: reproduced and fixed `/deep-research` losing its native Workflow owner
  at the launching reply. Bound native task events now retain the private SDK
  process; busy/idle/FIFO wait for the actual final report, including an early
  research finish. Send now uses native task cancellation and waits for the
  matching receipt/report; failures stay actionable and deliberate cancellation
  is not shown as a fake failure. Installed **2.1.222** verifies real orchestration
  with authored structured replies: phase fan-out, URL deduplication, six votes,
  synthesis, Stop/resume, queue ordering and an unchanged HTTP app/PID/data
  (**17/4/4/17/18/20/20/20** model replies across variants). This is not real
  web retrieval or a model-quality claim. Nine unit/session additions, syntax/unit
  **530/530**, browser **65/65**; app Send-now, dynamic-loop cancellation and
  plugin/app regressions pass. Other commands and company/account/live gates
  remain in `command-support.md`; item 20/order/count unchanged. Save to PR #2
  without merge, deployment or live-data/account changes.
- 20: installed Claude plugin namespaces now have real legacy-command/skill
  effects, same-basename isolation, Unicode/multiline FIFO, Stop/resume and
  private-chat isolation acceptance. Reproduced `/reload-plugins` returning
  “isn't available in this environment” despite successful transport. It now
  uses the actual `reload_plugins` SDK control, updates the menu and reports
  verified counts without a model prompt, fake native input or exposed config.
  First control-only sessions retain their owner without publishing a missing
  journal. Failed/partial/late reloads, cancellation and private-profile guards
  are covered. Installed **2.1.222** cases pass: normal **13**, Plan refusals
  **13**, retained HTTP app/state **15** authored main replies. Syntax/unit
  **521/521**, browser **63/63**; native app Send-now, dynamic cancellation and
  retained MCP/app regressions pass. Other unverified entries from the fresh
  native catalog are now explicit in `command-support.md`. Item 20/order/count
  and company/account/live gates remain unchanged. Save to PR #2 without
  merge, deployment or personal-profile changes.
- 20: fixed dynamic `/loop` lifetime: a successful native `ScheduleWakeup`
  receipt retains its SDK process before the scheduler reports an ID. Native
  replacement, firing and cancellation reconcile that pending job without
  deleting unrelated fixed/restored jobs; failed/unavailable/foreign/late
  results cannot invent or erase a schedule. Installed Claude **2.1.222**
  verifies timed counter writes, waiting cancellation, Send now, Stop,
  unavailable rollout, wakeup replacement and unrelated-cron preservation
  (**8/7/8/5/5/9/12** authored main replies). A completed tick without rearming
  leaves no native SDK fallback: same-process `CronList`, idle release and
  history resume pass (**9** replies); no controller timer is substituted.
  Rollout caches exist only in new disposable fixtures, never real accounts.
  Six session cases; syntax/unit **509/509**, browser **61/61**; ordinary
  resume/final-expiry and retained-app Send-now regressions pass. Next:
  installed plugin namespaces; existing shared-host/company/account/live gates
  remain. Queue order/count unchanged. Save to PR #2 without merge/deployment.
- 20: fixed ordinary `/loop` resume without `CronList` and automatic schedule
  completion/expiry. A bounded reader of the private native process's filtered
  scheduling diagnostics observes actual restoration/fire/expiry, without
  debug files, fabricated user turns, model requests or a parallel scheduler.
  Installed Claude **2.1.222** verifies ordinary resume and real timed work,
  one-shot completion/idle sleep, an aged durable job's final fire/deletion,
  and exclusion of expired recurring/overdue one-shot native history
  (**11/5/5/4/4** authored main replies). Five new session cases; syntax/unit
  **503/503**, browser **61/61**; scheduled Send-now and retained-app Send-now
  regressions pass. Only disposable fixture timestamps were aged; no clock,
  policy, live-chat or account changes. Next: dynamic `ScheduleWakeup`, then
  plugin namespaces; shared-host/company/account/live gates remain. Queue
  order/count unchanged. Save to PR #2 without merge or deployment.
- 20: fixed two reproduced native `/loop` defects: reply completion killed its
  scheduler, and timed turns were invisible to busy/Send-now handling. Bound
  scheduling results now retain the SDK session and pause idle sleep; native
  lifecycle events expose running work and cancellation waits for its own
  receipt. Installed-CLI fixtures verify real timed counter effects, list/delete,
  queue preservation and Stop/resume (**10/9/7** authored main replies).
  `/simplify` now has actual cleanup/unchanged-behavior, empty, Plan-refusal,
  Stop, Send-now and retained-HTTP-app evidence (**6/5/4/3/3/8/6** main replies).
  Seven unit/controller and two browser additions; **498/498** syntax/unit,
  **61/61** browser; native app interruption and review-fix regressions pass.
  Corrected test assumptions about native restored schedules, Plan exceptions
  and asynchronous lifecycle-start ordering; no real inference/account changes.
  Next: `/loop` ordinary-resume/expiry/dynamic reconciliation, then plugin
  namespaces; shared-host/company/account/live gates remain. Queue order/count
  unchanged. Save to PR #2 without merge/deployment or edits to live user data.
- 20: reproduced generated `/run-fixture` losing its real HTTP app at reply
  completion, then fixed private SDK lifetime based on a bound native main
  Bash background-task event rather than the slash command's name. Ordinary
  app-launch requests now retain it too; unknown/foreign/child/stale/quoted
  events cannot. `/run-skill-generator` acceptance creates its driver and
  recipe through native protected-file approvals, actually drives HTTP,
  reloads/discovers the saved skill, and reuses it through direct invocation,
  `/run` and `/verify`. Five disposable variants cover direct/plain launch,
  denial, Stop and Send now; actual PID/data, file absence/content, unrelated
  queue and same-native-history resume verified (**18/18/7/5/6** main replies).
  Authored loopback inference, not real accounts or a model-quality claim.
  Four new unit/session cases; syntax/unit **491/491**, browser **59/59**;
  native first-run, approval/questions, classifier cancellation and review-fix
  regressions pass. Remaining item-20 gates: `/simplify`, `/loop`, plugin
  namespaces and shared-host/company/account/live checks. Queue order/count
  unchanged. Save to PR #2 without merge, deployment or live-data/account edits.
- 20: added installed-Claude native Bash/permission-classifier acceptance,
  closing that distinct private-profile test gate. **19** disposable variants
  verify Manual/Edits once-approval and repeated denial, Deny prompts,
  Auto/Plan two-stage allow/refusal, malformed replies, API/fallback failures,
  Stop and Send now with late verdicts. Actual marker writes/absence, original
  arguments, unchanged app PID/data, selected-input completion, saved native
  history and unrelated queued input are checked (**99** main and **38**
  classifier requests, plus titles). All model/classifier replies are authored
  on loopback: this proves integration/effects, not model judgment. No runtime
  product change or claim that item 27's Codex/local-IPC case is fixed.
  Fixture assumptions corrected for native Plan classification, retry budgets
  and asynchronous Send now completion. Syntax/unit **487/487**; browser
  **59/59**. Remaining item-20 gates: bundled workflows, plugin namespaces,
  shared-host/company/account checks and live activation. Queue order/count
  unchanged; save to PR #2 without merge, deployment or live-data/account edits.
- 20: first Claude Fast opt-in now works in an already-running standard-speed
  application through native settings, after a fresh authenticated account
  check. A refused/unconfirmed activation now explicitly disables Fast in the
  retained CLI and clears the preference; failed controls cannot claim success
  or replay writes. Installed-native acceptance covers actual app/PID/data
  continuity, credits, entitlement/network failures, cooldown persistence,
  toggles, model changes, recovery and Stop/resume (**51** main loopback
  requests). Private managed-policy acceptance retains the app and verifies
  native refusal with subsequent standard speed (**3** requests), without
  changing the policy. Seven unit/session additions; syntax/unit **487/487**,
  browser **59/59**. Existing native Fast base/settings/policy/limits regressions
  pass (**7/3/2/21** requests). Real native cooldown time is not accelerated;
  prior expiry verification remains controller-clock/explicit-Stop scoped.
  Item 20 stays active; shell classifier, bundled workflows, plugin namespaces
  and company/account/live activation gates remain. Save to PR #2, no merge,
  deployment or live-data/account changes; queue order/count unchanged.
- 20: fixed native MCP reconnect leaving stale tools available after disable
  in a retained application session. Reconnect now uses ordered native toggles
  and verified status, without restarting the app, editing credentials or
  replaying writes. Installed-CLI acceptance verifies HTTP/stdio, real tool
  removal and refusal, re-enable/recovery, independent chats and Stop during
  reconnect, with the same HTTP app/data (**9** main loopback replies). Native
  retained-session review now has actual diff/findings/edit/CLI-effect evidence
  for read-only, empty, fix, Plan refusal, Send now and Stop (**8/8/10/9/6/5**
  main replies, plus native titles). Four unit/adapter additions; syntax/unit
  **480/480**, combined browser **59/59**. Existing native MCP normal/error
  regressions pass (**3/0** replies). Fixture metadata/cleanup corrections are
  recorded separately. Item 20/order/count unchanged; remaining gates include
  retained Fast/cooldown, shell classifier, bundled workflows and plugin
  namespaces. Save to PR #2 without merge, deploy or live-data/account changes.
- 20: reproduced and fixed retained Claude sessions losing gateway access at
  their initial capability deadline. Controller-owned renewal now keeps the
  original scoped session alive; expiry, changed owner/company/profile/account
  and Stop still deny access. Workers cannot renew or resurrect tokens. Stop
  revokes before slow persistence/shutdown, and canceled pre-input SDK controls
  cannot leave a stuck logical turn or replay input. Installed-CLI acceptance
  crosses two actual lease lifetimes with the same CLI and HTTP app/data,
  checks a fixed-expiry control, rejects account changes before upstream traffic
  and resumes saved context with a fresh token (**9** loopback model replies).
  Seven broker/adapter/controller additions and two responsive browser cases;
  syntax/unit **476/476**, combined browser **59/59**. Native first-run Send now,
  review Stop/resume and approvals/questions regressions pass (**8/3/13** replies).
  Item 20/order/count unchanged. Remaining work includes retained-session
  Fast/MCP/review interop, classifier and bundled workflows.
  Save to PR #2 without merge, deployment, live-data or account changes.
- 20: reproduced and fixed native Claude Auto pinning the process environment
  so later High/Low choices changed the web selector but not actual requests.
  SDK sessions now reset effort natively before input and apply later choices
  without replacing the CLI or its running app. Explicit worker overrides keep
  native precedence and surface a bounded notice; changed startup environments
  reject input without stopping the app. Failed/canceled first SDK reset leaves
  no unusable resume ID and explicit retry starts fresh. Installed-CLI variants
  verify actual effort, seven changes, unchanged profile defaults, HTTP app/data,
  native status and Stop/resume (**19/19** loopback requests). Four adapter and
  two responsive browser additions; syntax/unit **469/469**, combined browser
  **57/57**. Native settings, approvals/questions and Plan regressions pass
  (**3/13/14** replies), plus first-command Send now (**8**) and Fast/settings
  interop (**3**). Fixture title/launch accounting and an overall settings
  deadline were corrected separately, without loosening effect assertions.
  Item 20/order/count unchanged. Next: long-lived capabilities and remaining
  retained-session interop; classifier and other bundled workflows remain open.
  Save to PR #2 without merge, deployment, live-data or account changes.
- 20: reproduced and fixed Claude's native Enter/ExitPlanMode leaving Relay's
  selector and subsequent-turn mode stale. Only allowlisted structured status
  from the current main session is reconciled; stale/foreign/child events and
  changed owners/profiles cannot alter it. Native configuration readback and
  live mode events are serialized. Newer web choices, including same-value
  reselection, remain authoritative for the next turn; Stop invalidates old
  callbacks, duplicate status is a no-op, and persistence failure stops safely.
  Installed-CLI acceptance covers explicit plan approval, denial, Stop while
  awaiting approval and newer web Plan selection, with real file/policy and
  retained HTTP app/data effects (**14/13/9/14** loopback requests). Seven new
  unit/adapter cases and two responsive browser cases; syntax/unit suite
  **465/465**, combined Claude-command/conversation browser suite **55/55**.
  Native settings and approval/question regressions pass (**3/13** requests).
  The separate shell classifier, long-lived capabilities/startup settings,
  retained-session interop and other workflows remain open. Item 20/order/count
  unchanged; save to PR #2 without merge, deployment, live-data or account changes.
- 20: private Claude profiles now support native once-approval, denial and
  `AskUserQuestion` through the live SDK channel, including ordinary turns and
  retained application sessions. Original tool inputs stay controller-side;
  the browser cannot widen arguments/permissions. Concurrent requests are
  serialized, stale/cross-chat IDs and session grants rejected, Stop cancels
  pending/late actions and ambiguous transport writes are never replayed.
  Installed-CLI acceptance proves actual protected recipe creation/reuse after
  approval, denial without writing, Stop with retained queued input, and native
  multiple-choice/text/skip questions (13/12/10 loopback requests). Ordinary
  transport startup/cleanup, nine unit/controller additions and four responsive
  browser additions pass. Long approval paths now wrap; Manual-mode help no
  longer incorrectly says all replies are unsupported. Syntax/unit suite
  **458/458**, combined Claude-command/conversation browser suite **53/53**;
  native command/MCP/review-fix/goal/Fast and application Send now regressions
  pass. Shared hosts, classifier/Plan transitions, other workflows and live
  activation remain open. Item 20/order/count unchanged; save to PR #2 without
  merge, deployment, live-data or account changes.
- 20: fixed native Claude `/run` servers dying when a reply ended. Retained
  application sessions now preserve real HTTP apps/data across replies and Send
  now, including first-command interruption; Stop closes them and native history
  resumes. Fixed dropped background answers, cumulative usage double counting
  and resumed empty checkpoints hiding actual usage. Fast off reaches the live
  CLI immediately. Installed-CLI loopback acceptance covers actual HTTP/tools,
  existing recipe reload, model change, later/first interruption, background
  exit and Stop/resume (12/10/8/6 requests). Protected recipe creation remains
  denied, not falsely counted as implemented. Thirteen unit/controller and three
  browser additions; normal suite **449/449**, Claude command browser suite
  **23/23**. Previous command/MCP/review Send now smokes also passed. Remaining
  native classifier, startup-setting, long-lived
  credential and retained-session interop gates are in `command-support.md`.
  Original order/count unchanged; item 20 remains active. Save this checkpoint
  to PR #2 without merge, deploy, live-data or account changes.
- 20: bundled Claude `/code-review` now has effect-level acceptance and a fix
  for first-command Stop/resume losing its native journal. Review turns use SDK
  interruption with bounded flushing; provisional IDs prevent broken resumes
  after startup/forced-stop failures, without replaying `--fix`. Installed CLI
  verifies actual diff/read/findings, explicit file edits and CLI output, Plan
  refusal, empty findings, saved final answers, Stop and Send now. Six isolated
  variants use five/five/seven/six/three/three local requests; no real inference,
  external network, personal profile or GitHub mutation. Four adapter plus one
  FIFO/error test and three responsive browser additions; normal suite
  **436/436**, Claude command browser suite **20/20**. Fixture corrections are
  documented separately from the reproduced product defect. Next safe item-20
  work: other bundled workflows and installed plugin namespaces; `--comment`,
  host/account/company and live activation gates remain explicit. Original
  order/count unchanged; save to PR #2 without merge/deploy/live-data changes.
- 20: fixed installed Claude's print-mode `/mcp` mutation handlers returning
  terminal-only placeholders. Native SDK reconnect/toggle now verify actual
  status and private-profile persistence; literal single/all commands use FIFO.
  Bare manager/status controls, drafts and installed command catalogs remain
  intact. No model calls for MCP actions; native errors pause the queue and
  Stop cannot leave a broken first-session resume ID. Shared host writes and
  unsafe private files fail closed; saved credentials/selections stay unchanged.
  Actual CLI/environment/gateway smoke verifies HTTP/stdio state and next-turn
  tool availability with three local model replies; failure/Stop variant uses
  zero inference. Nine unit/controller cases; three browser additions, related
  suite **28/28**. Normal unit suite **431/431**; previous native goal smoke passes
  with four loopback replies. Fixture-only corrections are recorded without
  weakening effect assertions. Next safe item-20 work: bundled Claude workflows
  and installed plugin namespaces. Original order/count and host/account/live
  gates remain open; save to PR #2, no merge/deploy/live-data changes.
- 20: Claude `/goal` now has actual native evaluator-loop and same-session
  Stop/resume acceptance. Four loopback requests exercise negative/positive
  evaluation; six cover interrupted evaluation, restored condition, explicit
  continuation, independent chats and all native clear aliases; two cover
  evaluator failure and native hook policy. Fixed silently dropped evaluation
  warnings and concatenated native response steps. The stream accumulator
  retains every content block, deduplicates events and excludes child/thinking
  text from the parent's response. Preserved native model/effort and literal
  FIFO commands; no invented Codex goal state. Seven new unit/controller cases;
  three browser additions, related browser suite **25/25**. Native commands and
  Fast regressions still pass (four and seven loopback requests respectively).
  Normal unit suite **422/422**; JavaScript syntax/whitespace checks pass.
  Next safe item-20 work: native MCP actions, bundled workflows and installed
  plugin namespaces. Original order/count, previous host/gateway/policy and
  activation gates remain open; no merge/deploy/live-data changes.
- 20: native Claude Fast credits, API rejection/cooldown and `/config`/`/settings`
  interoperability are now verified. Fixed lost native credit notices and
  process-local cooldown loss; authoritative API denials override stale native
  ON state. Scoped gateway observations retain deadlines before Stop, including
  interrupted turns/newer model choices, without leaking prompts/keys or
  crossing credentials/profiles. Eight added tests; normal suite **415/415**,
  related browser suite **22/22**. Actual CLI/gateway loopback smokes: base seven
  model requests/twelve account checks, limits twenty-one, settings three,
  managed policy two standard replies. Expiry uses an injected Relay clock;
  managed policy uses a private mount namespace, never host-policy writes.
  Installed native managed per-session opt-in still cannot activate Fast in
  this print-mode path: enforced and documented, not claimed as supported.
  Host/custom-gateway/live activation gates remain open. Next safe item-20 work:
  Claude goals and remaining installed commands, retaining all explicit command
  limitations. Queue order/count unchanged; no merge/deploy/live-data changes.
- 20: Claude `/fast` now has private-gateway per-chat opt-in/state, native
  request-level acceptance and same-session Stop/resume. Fresh controller-side
  account checks keep provider keys out of workers; the documented bearer-token
  compatibility flag is used only after a positive check. Account errors do not
  grant Fast; ordinary tasks fall back visibly to standard mode. Credential and
  profile changes require fresh opt-in; native disable/model policies, FIFO,
  attachments, Stop and newer picker choices are protected. Reproduced the
  native Sonnet-to-Opus stale-state result and fixed startup/persistence without
  lowering effort or loosening assertions. Thirteen unit/controller cases,
  three browser additions; related browser regressions **22/22**. Final normal
  unit suite **407/407**; installed Claude smoke passed with seven loopback model
  replies and twelve allowed/denied account checks, plus native disable/model
  policies. Changed JavaScript syntax and whitespace checks pass.
  Next safe work remains within item 20: native Fast rejection/cooldown and
  configuration interop, then Claude goals and remaining installed commands.
  Host/custom-gateway/account/activation gates and the original queue order/count
  remain open. Save to PR #2 without merge, deployment or live-data changes.
- 20: `/autocompact` now has effect-level native acceptance and private-profile
  mutation protection. Verified real automatic summary/compact-boundary after
  changing 200k to 100k and Stop/resume, reset, retained disabled state, invalid
  values and native environment precedence. Five + two loopback replies; no
  fabricated live history or external inference. Shared host writes and linked
  files fail closed, and attachments cannot become command arguments. Three
  new unit/controller cases and one mobile browser case; normal suite **394/394**,
  related browser regressions **19/19**, prior native settings smoke still green.
  The environment-precedence fixture was corrected to supply its missing local
  executor; no production semantics or assertions were weakened. Separately,
  a network/PID-isolated `/fast` probe proved that native print mode needs startup
  opt-in and then still enforces the dummy account's organization restriction.
  Fast remains unimplemented/unaccepted; no bypass flags or personal credentials
  were used. Next safe item-20 work: per-chat native Fast opt-in/state and account
  gates, then Claude goals and remaining installed commands. Original queue
  order/count and live/account gates remain unchanged. Save to PR #2, no deploy
  or merge.
- 20: fixed Claude `/config`/`/settings` effects being overwritten by Relay's
  stale next-turn model and permission flags. Private-profile readback now
  reconciles actually applied values, including partial failures and same-value
  requests; retains newer web choices; and survives Stop/resume in the original
  chat. Five native permission modes, explicit Auto effort, native effort status
  and the separate Claude account-default model are covered. Shared host writes
  stay gated on item 21; files are rejected before submission/queueing. Eleven
  new unit/controller and four browser checks cover failure, scope, FIFO,
  concurrency, file-read safety and desktop/320px controls. Actual installed
  Claude 2.1.222 verifies model and thinking changes with three loopback replies;
  original command smoke still passes with four. Normal suite **391/391**, related
  browser regressions **27/27**, syntax/whitespace pass. The existing slider test
  caught Auto being misordered as the lowest effort; fixed the picker without
  changing its Low assertion. Native Plan promotion of Haiku to Sonnet is
  documented separately from execution-model verification. No real credentials,
  live data, app/Chrome restarts or deployment. Save to PR #2 without merging.
  Item 20 stays active: next verify remaining stateful Claude `/fast`,
  `/autocompact`, `/goal` and other installed-command effects. Queue count/order
  and previous activation/account/browser gates are unchanged.
- 20: installed Claude 2.1.222 now has real command-first, custom-command/skill
  expansion, multiline/Unicode, native local alias and same-session resume
  acceptance. Four loopback fixture model replies; no external inference or
  personal/native host-profile changes. Reproduced and fixed stale Relay menus
  after successful `/reload-skills`: scoped invalidation plus a persisted
  catalog revision refresh controller/browser caches and an open slash query,
  without consuming drafts/files or accepting old replies. Failed/interrupted
  reloads do not announce success. Four controller/unit and three browser cases
  pass. Final normal unit suite **380/380**, related browser regressions **28/28**,
  native smoke and repository JavaScript syntax/whitespace checks pass. The
  initial unit fixture needed its missing broker; product regressions and
  assertions remain recorded in `command-support.md`. Existing broad browser
  history/network gates remain open. Next safe item-20 work: stateful Claude
  command effects and restart persistence, then other installed-command effects;
  account/host-profile and activation gates remain explicit. Update PR #2 without
  merge/deployment. The original queue order/count is unchanged.
- 20: `/init` now has document, controller and browser acceptance evidence.
  Installed Codex 0.154.0 reads a disposable repository and uses native Code Mode
  tools to create actual AGENTS.md bytes, preserves them after same-session
  resume, and cannot write in Plan mode. Unrelated files remain unchanged.
  Nine deterministic loopback responses; no external inference, personal
  credentials or live chat/profile/approval changes. This proves integration,
  not generated-prose quality, which still needs review. Six controller/unit
  cases cover routing, FIFO, attachments, Stop/restart, failures and ownership;
  three browser cases cover discovery, multiline idle/busy sends, newer-draft/file
  preservation and failed-send retry. Normal unit suite **376/376**; focused
  browser suite **3/3**. OpenAI Docs supplied the scaffold/review contract.
  Existing production dispatch required no change. Native fixture corrections
  and remaining gates are documented in `command-support.md`; earlier broad
  browser failures and activation remain open. Keep item 20 active; next safe
  work is installed Claude-command acceptance. Save checkpoints to PR #2 without
  merge/deployment.
- 20: `/fast` and `/personality` now have browser/controller and installed-native
  parameter acceptance. Settings persist per chat, honor FIFO, use real model
  capabilities, never become prompts, and clear unsupported native overrides.
  Fixed late writes after Stop or a newer model/Fast-off choice; the personality
  picker prevents duplicate pending selections, retains attachments and ignores
  stale dialog/chat responses. Delayed send failures no longer overwrite newer
  or other-chat drafts. OpenAI Docs supplied the native command contract.
  Eight new controller cases and eight browser scenarios pass; the final normal
  `npm test` passes **370/370**, and related browser regressions pass **22/22**.
  Actual Codex 0.154.0 acknowledges all three personalities and catalog Fast
  tiers, including clearing after same-session resume. Four disposable loopback
  responses, no external inference or personal credentials. Syntax/whitespace
  checks pass; the 320px picker was visually inspected. Initial reproduced
  races and smoke-fixture corrections are retained in `command-support.md`;
  earlier full-browser history/network failures remain open. No deployment or
  live chat/account changes. Save to PR #2 without merge. Keep item 20 active;
  next is `/init` document acceptance, then installed Claude-command acceptance.
- 20: `/app` now opens a scoped same-session desktop handoff panel. An awake
  worker supplies native metadata through read-only `thread/read`; a bound
  controller locator survives stop/restart without waking it. Local host-profile
  links require explicit same-computer/profile confirmation. No transcript,
  credential, account or SSH-key transfer; no prompt, native setting change,
  automatic stop or queue mutation. Refresh/account/navigation races clear old
  paths and links. Private gateway profiles and remote workers have explicit
  limitations, not fabricated local links or pretend handoff success.
  OpenAI Docs supplied the actual local deep-link and remote-connection contract.
  Nine unit/controller cases and seven handoff browser cases pass; the final
  related browser regression run passes 20/20. The actual installed Codex
  0.154.0 smoke passes on a disposable private profile: same native identity
  before/after resume, unchanged history, one loopback seed response and no
  external model calls. The normal, default-concurrency `npm test` passes
  **362/362**, including the real Chrome extension case. All JavaScript syntax
  and whitespace checks pass; the 320px panel was visually inspected.
  Initial checks caught a cache-header override (fixed) and test selectors that
  hit Stop instead of Queue and assumed a hash router (corrected to the real
  controls). No assertions/timeouts/launch flags were relaxed. This is a focused
  browser checkpoint, not a rerun or closure of the earlier full-suite
  history/network failures. Nothing was deployed or changed in live chats.
  OS desktop launch remains unverified; private-profile handoff and one-click
  remote selection remain unimplemented. Keep item 20 open. Next safe work is
  the remaining `/fast`/`/personality` browser/native parameter acceptance,
  followed by `/init` and installed Claude-command acceptance. Preserve these
  open gates while saving this increment to PR #2 without merge/deployment.
- 20: `/pets` and `/pet` now open a saved web companion picker; direct names/IDs
  and Off work while busy without sending/queueing a prompt. Eight actual
  OpenAI v4 built-ins are downloaded lazily, hash-checked and cached. Private
  accounts can explicitly upload bounded PNG/WebP sheets plus optional frame
  metadata and delete only their own custom pets. Current-chat states, still
  frames for reduced motion, hidden-tab pausing, released bitmaps, drafts/files,
  account/revision guards and visibly disclosed shared built-in preferences are
  implemented. OpenAI Docs informed CLI aliases/status and standard web sheet
  behavior. No native profiles or live services/chats/accounts/Chrome changed.
  Six pet unit/controller and eleven focused browser cases pass; all eight
  real built-ins pass checksum/decode/transparency/frame/state checks in a fresh
  browser without model calls. Mobile review caught cramped columns, corrected
  to full-width choices. A final account-change review also clears private
  picker text/files/labels, not just its image; its added browser case passes.
  The initial full unit/controller run passed 352/352 at concurrency two. With
  the added quota case, the next run passed 352/353 with one cancelled 60-second
  Chrome-extension test; that unchanged case passed alone in 46.7 seconds.
  The full browser run passed 140/147, including all eleven pet cases. Item 26's
  Jump to latest detachment remains; six other failures show startup/reload
  `ERR_NETWORK_CHANGED` in traces (MCP, organization, syntax theme, two title
  cases and Vim). The final combined follow-up passed 17/18, including the new
  privacy case and all six unchanged network-affected cases; a pet-state case
  failed before startup with the same network error, then passed unchanged in
  isolation. All twelve pet scenarios have passing evidence across those runs,
  but the broader timeout/network/history gates remain open. JavaScript syntax
  and whitespace checks pass; no assertions, timeouts or launch flags relaxed.
  Next UI command: `/app`; item 20 and activation remain open. Save this
  checkpoint to PR #2 without merge/deployment.
- 20: `/theme` now previews and saves four syntax palettes for conversation code
  and diff colors. OpenAI Docs guided preview/confirmation/persistence; this is
  a web equivalent, not a native configuration write or agent prompt. Per-account
  settings (or explicitly shared installation scope) have auth/origin, revision,
  account-change and late-response guards. Draft/files and busy work remain.
  A self-hosted, pinned tokenizer runs in a separate browser worker, never the
  page's opt-in Vim runtime. Source is literal and never executed; bounded jobs,
  source/line/token limits, deferred batches and stale-element checks protect
  rendering. Unknown/large/complex blocks remain intact as plain text. Retrying
  replaces failed worker/module state. Four new unit/controller cases and the
  full 347/347 suite pass at concurrency two; all JavaScript syntax checks pass.
  Thirteen new browser scenarios cover real colors/copy/preview isolation,
  save/cancel/defaults, private HTTP persistence, mobile, busy/draft/file safety,
  errors/late responses, accounts, worker retry and 70-block batching. A focus
  account-change test failed before the stale-panel notice/disable fix. The next
  combined run passed 21/22, including all nine Vim cases; the failure occurred
  during startup before that scenario, with `ERR_NETWORK_CHANGED` on preferences
  and MCP requests in the trace. It passed unchanged in isolation; the startup
  network condition is not declared fixed. Desktop/320px layouts were inspected.
  The full browser suite finished 134/136, including all thirteen theme cases
  and both shared-Chrome cases. Item 26's Jump to latest detachment reproduced;
  a sign-out case failed before its scenario when startup script requests
  reported `ERR_NETWORK_CHANGED`. No assertions/timeouts were relaxed. A final
  light-theme contrast correction applies the palette to diff line numbers,
  with an actual computed-color assertion. All thirteen theme, nine Vim and four
  unchanged sign-out cases then passed together (26/26). That follow-up does not
  erase the full-run failure or establish the network condition's root cause.
  Code-palette foreground contrast was checked (above 4.5:1); desktop/320px
  layouts were inspected. Prior default-concurrency failures remain recorded.
  No live service/chat/account/Chrome or native config changes. Next: `/pets`
  and `/pet`; item 20 and activation remain open. Save this checkpoint to
  existing PR #2 without merge/deployment.
- 20: `/title` now configures Relay's browser-tab title through an eight-field
  picker with preview, selection, drag/arrow order, explicit save, defaults and
  a neutral app-only title. OpenAI Docs guided behavior and spinner/project
  defaults; chat names and native terminal configuration are not changed.
  Account-scoped preferences (or explicitly shared installation preferences)
  reuse the tested footer picker/storage mechanics but separate record kinds.
  Stale/revoked writes and late acknowledgements cannot overwrite newer settings,
  panels or drafts. Account changes immediately neutralize the title. Saved
  runtime/branch/model/goal metadata drives the title; spinner animation pauses
  for approvals/questions, hidden tabs and reduced motion. Values are bounded
  plain text, not HTML/templates or copied prompts. Native Codex 0.154.0 lacks
  `update_plan`, even with goals disabled: initial step-count smoke attempts
  failed and exposed the capability difference. All six actual goal states and
  clearing now pass real-CLI smoke verification without inference/credentials.
  Optional native plan notifications retain only current-thread/turn aggregate
  counts, with schema/protocol-fixture, stop/reload and reset coverage; no claim
  that this installed CLI emits the legacy plan tool. Seven new unit/controller
  checks and eleven title browser checks pass; the ten existing footer and two
  attachment checks remain green (23/23 focused browser tests). Two deterministic
  title regressions failed before correction: slow preferences delayed startup,
  and another account discovered on focus could reuse a cached private chat's
  name. Title loading is now non-blocking and its title/preview verify ownership.
  Real HTTP/private-account browser persistence also passes without waking an
  agent. Full unit/controller suite: 343/343 with concurrency two. The first
  full browser run was deliberately interrupted to make corrections: 31 passed,
  two failed, one interrupted and 86 not run. The attachment test targeted a
  hidden input before startup selected a chat; it now asserts the actual chat
  and visible composer before file selection, without removing assertions or
  increasing timeouts. Item 26's Jump to latest detachment reproduced again and
  remains open. Prior default-concurrency failures remain open. The final full
  browser run completed 122/123, including all eleven title cases. The shared
  Chrome case reached its overall 30-second deadline late in its desktop-
  screenshot/expand flow, after typing and viewport checks passed. This is not
  a green full suite; no timeout/assertion was relaxed. Both shared-browser cases
  then passed isolated (the original case in 10.0 seconds), with no code changes;
  the full-suite timeout is retained, not declared fixed. Desktop and 320px title
  layouts were visually inspected. No live
  service/chat/account/Chrome changes. Next: `/theme`; item 20
  and backend activation remain open.
- 20: `/statusline` now configures the actual web footer: fifteen fields,
  live preview, checkbox selection, drag/arrow reordering, explicit save, hide
  and defaults. OpenAI Docs informed selection/order/persistence and disabling;
  the UI explicitly distinguishes this from worker terminal configuration.
  Preferences are account-scoped (or explicitly installation-shared without a
  private account), revision-guarded and never contain arbitrary scripts/data.
  Late loads/saves preserve newer panels, drafts, chat selection and account
  preferences. Missing metrics are not zero; context and cumulative counters
  remain distinct, cache/reasoning are not double-counted, expired limit windows
  are marked and stopped workers show saved snapshots. Native initialization
  captures bounded model/directory/version fields, not raw user-agent/host data.
  The actual Codex 0.154.0 handshake passes in an isolated profile without
  inference; Claude's init path has local protocol-fixture coverage. Separate
  read-only Git snapshots include main/default branches and detached HEADs on
  the worker; PR discovery behavior is unchanged. No settings action wakes a
  worker, sends a prompt or changes native config/credentials. Seven new
  unit/controller checks and ten responsive browser checks pass. The full
  unit/controller suite passes 336/336 with concurrency limited to two, without
  skipping tests or relaxing assertions. The prior default-concurrency failures
  remain documented, not declared fixed by this result. Desktop and 320px picker
  layouts were inspected; close/save/error state stay visible as the field list
  scrolls. The first full browser run passed 110/111, finding a mobile startup
  race: automatic initial chat selection closed a drawer already opened by the
  user. A deterministic regression test failed before the fix; initial selection
  now preserves that drawer, while explicit chat selection still closes it.
  All sixteen organization/status-line browser cases then passed, including the
  original failure, without altering its assertions/timeouts. The final full
  browser suite passes 112/112. No live service, chat, personal Chrome or account
  changed. Backend
  activation remains pending. Next: `/title`; item 20 remains in progress.
- 20: `/vim`, explicit on/off and Chat actions now control real web-composer Vim
  editing. The OpenAI Docs skill informed the per-session behavior; the mode is
  per chat in this page, not a native configuration change. A pinned, self-hosted
  editor loads only on opt-in. Normal/Insert/Visual editing, motions, operators,
  text objects, registers, undo, search and substitutions work on the unsent
  draft. Insert-mode Relay shortcuts, command/file pickers and attachments keep
  their existing paths. Normal Enter cannot send; mode, help and off controls
  are visible. Chat/account changes reset registers, macros, search and undo;
  late asset loads and load failures cannot erase newer drafts or switch chats.
  Two new unit/controller checks and nine actual-editor browser checks pass,
  including mobile, account changes, workspace references, clipboard files,
  busy queueing, IME and read-only/size limits. The full unit/controller suite
  passes 329/329 with `node --test --test-concurrency=2 test/*.test.mjs`.
  Default-concurrency `npm run check` is not green: after correcting the obsolete
  assertion that Vim must be unavailable, its latest run had 319 passes, nine
  failures and one cancellation, involving fixture timeouts and shutdown races.
  No timeout was relaxed and no test was skipped; the default-run failures are
  retained, not declared fixed by the bounded-concurrency result. The final full
  browser suite passes 102/102, including all nine Vim cases; repository-wide
  JavaScript syntax and `git diff --check` pass. Desktop and 320px editor layouts
  were visually inspected. Item 26's known intermittent paging failure did not
  reproduce in this browser run but remains open. No worker,
  native config, live chat/account, personal Chrome or live service changed.
  Backend activation remains pending. Save this incremental checkpoint to PR #2
  without merge/deployment. Next: `/statusline`; item 20 remains in progress.
- 20: `/keymap` now opens a working web keyboard editor, also reachable through
  Chat actions. The OpenAI Docs skill informed context/action selection,
  alternatives, unbinding and persistence; Relay explicitly distinguishes its
  web shortcuts from native terminal configuration. Seven actual actions cover
  new chat, composer/question focus, send/queue, newline and boundary-aware
  history. Composer overrides global; pickers, IME and browser editing retain
  their controls. Reserved/conflicting bindings are rejected. Preferences persist
  per signed-in Relay account, or in the disclosed installation-shared scope
  without an account. Scope/revision guards reject stale writes and late replies
  cannot roll back newer settings, replace a panel or clear a newer draft/files.
  Five unit/controller checks and five desktop/mobile browser checks pass;
  `npm run check`: 327/327, full browser suite: 93/93. Desktop and 320px dialogs
  were visually inspected. Item 26 passed in this full run but its previously
  reproduced intermittent paging failure remains unresolved, not declared fixed.
  No worker was woken for keymap settings; no native config, live chat/account,
  personal Chrome or live service changed. Backend activation remains pending.
  Save this verified incremental checkpoint to existing PR #2, without merge or
  deployment. Next: `/vim`; item 20 and the overall queue remain in progress.
- 20: `/logout` now opens saved status without waking a worker, explicitly
  inspects a private native account, and requires a separate idle confirmation
  before Codex clears its credentials. The OpenAI Docs skill informed native
  account/storage semantics. Main, side, child and goal work is not stopped to
  force sign-out; confirmed operations pause the queue. Owner/company/repos/
  environment/workspace/session/worker, file identity and startup/current/admin
  policy bind encrypted five-minute reviews. Intent precedes dispatch, and lost
  replies, Stop or restart cannot replay uncertain operations. No raw credential
  bytes reach the browser; account/limit snapshots are invalidated and late
  inspections cannot restore old account data. Profile file inspection rejects
  links/special/oversized files but is a preflight, not an atomic filesystem
  sandbox. Native removal is verified; history, workspace, draft/files and sibling
  profiles remain. Shared host and OS keyring/auto storage stay locked pending
  isolation (21). Real CLI 0.154.0 testing found gateway mode hides in-memory
  native accounts; this now has an explicit unavailable state, never false success
  or a claim that those credentials are absent. Default-file and observable
  ephemeral native removal pass with dummy accounts and loopback-only network/PID
  namespaces; an authenticated-provider fixture makes ephemeral accounts visible.
  Seventeen new unit/controller checks and four responsive browser checks pass.
  Final `npm run check`: 322/322. Full browser run: 87/88; item 26's previously
  recorded Jump to latest detachment/pointer-interception timeout reproduced at
  `test/browser/conversation.spec.mjs:79` and remains unresolved, not bypassed.
  Desktop/mobile sign-out controls were visually inspected; final native smoke
  passes. No live account, OS keyring, chat, worker or Chrome changed. Backend
  activation remains pending. Next: terminal UI equivalents; item 20 remains open.
  The user authorized saving the verified checkpoint to the existing PR #2 on
  `feat/mcp-connections`; auto-merge is off. This is a work-in-progress backup,
  not a claim that the full queue is finished or ready to deploy/merge.
- 40–41: appended the user's latest search request (only user-written messages
  and final AI answers, no reasoning/tool/intermediate-response index) and the
  report that deleting a container deletes messages. These follow saved prompts
  (39); no out-of-order implementation or live-data deletion occurred.
- 20: `/feedback` now opens an explicit report/policy/review flow. Only final
  confirmation uploads to OpenAI; logs are off by default, and draft text/files
  never become implicit attachments or agent input. Diagnostic consent is
  separate, explains conversation/code/path/account metadata, and is blocked
  for shared host profiles pending item 21. Private configuration and managed
  storage roots must stay within the native profile. The OpenAI Docs skill
  informed the native contract. Real 0.154.0 testing found that the upload
  handler caches startup configuration, so current policy is checked before
  dispatch and log consent is also bound to verified startup configuration.
  Changes never silently restart a worker. Encrypted bounded review/submission
  records bind owner/company/repos/environment/workspace/native thread/worker;
  stale reviews, Stop, lost replies and restart cannot silently replay uploads.
  The native reference is a session ID, not an independent external receipt.
  Actual CLI tests use loopback inference and a local TLS report receiver inside
  network/PID namespaces: four classifications, text-only versus native history
  and diagnostic files, positive/error responses, disabled policy and no extra
  agent turns pass. No report or diagnostic data reached OpenAI. Fifteen new
  unit/controller checks and five responsive browser checks cover the controls;
  the full browser suite passes 84/84. Desktop and 320px dialogs were visually
  inspected. The first targeted browser run had one transient bootstrap failure
  before the feedback dialog opened; its isolated, whole-file and full-suite
  reruns passed. It is not counted as a reproduced/fixed product defect.
  Live activation remains pending; no personal account, production data or live
  worker/Chrome changed. Keep item 20 in progress. Next: `/logout`, then terminal
  UI equivalents. Saved prompts remain item 39 after attachments/drag-and-drop.
  Final checkpoint: `npm run check` passes 305/305, the full browser suite passes
  84/84, and the final real-CLI feedback smoke passes. `git diff --check` is
  clean. No commit, deployment or live support submission occurred.
- 20: `/approve` is now a native automatic-review retry flow, not a blanket
  approval shortcut. Actual main-thread denials are retained in encrypted,
  owner/project/session-bound records; the web panel displays literal reviewed
  metadata and requires confirmation. It queues that specific action, preserving
  FIFO, paused queues, newer denials and the unrelated draft/attachments. Native
  approval is recorded before an explicitly requested retry through the tracked
  turn path; permission settings and automatic review remain in force. Durable
  phases prevent silent replays after lost replies, Stop or restart. The OpenAI
  Docs skill informed the contract; the installed CLI exposed and verified the
  snake_case, stdin file-URI and filesystem-representation conversions. A private
  real-CLI fixture proves same-thread resume, harmless command execution after
  review, continued denial on a later request, actual filesystem-permission
  metadata and all seven action formats. No live account, data, worker or Chrome
  session changed. Live activation remains pending. Keep item 20 in progress;
  next remaining inventory entry is `/feedback`, then `/logout` and terminal UI
  equivalents. Item 39's saved prompts remain queued after attachment cards and
  drag-and-drop.
  Final checkpoint: `npm run check` passes 290/290, the full browser suite passes
  79/79, and the final real-CLI approval smoke passes with private fixtures only.
  Eleven new unit/controller tests cover binding, tampering, duplicate/lost
  responses, Stop, bounded same-millisecond events and queued-selection retention;
  stale retries cannot cross companies/providers and remain removable after a
  switch. Four browser checks cover literal metadata, explicit confirmation,
  mobile layout, drafts/attachments, uncertainty and late responses. Desktop and
  320px dialogs were visually inspected. `git diff --check` is clean. No commit,
  deployment, personal account authorization or production-data change occurred.
- 20: `/import` now has a source/group/conversation picker, explicit selection
  confirmation, asynchronous result cards and incomplete-outcome recovery.
  Opening a selected imported conversation creates one independent stopped chat
  with a copied workspace and privately retained native history. It does not send
  input or copy personal accounts/profile settings; nonempty drafts and attached
  files stay in the original chat. Six new controller tests and five browser
  checks cover adoption, isolation, cancellation, cleanup, navigation and late
  results. The real CLI proves native continuation and same-thread resume after
  deleting the source chat. Both the original import smoke and regular fork
  smoke pass. The OpenAI Docs skill informed the native workflow.
  Real testing exposed two details: Claude image blocks become native unsupported
  markers, which are retained with a warning; temporary Git directories can
  mutate during inspection, so only their read-only safety scan gets bounded
  retries. Twelve inspector tests retain source-change/link rejection. An import
  warning initially disappeared into its closing dialog; the fixed positive
  navigation browser test now passes. The first full browser run also exposed
  intermittent Jump to latest detachment during automatic paging (26); its
  isolated rerun passes, but that does not establish a fix. No live data, account,
  worker or personal Chrome session changed. Backend activation is still pending.
  Keep item 20 in progress; next remaining inventory entry is `/approve`.
  Item 39's saved-prompts dropdown remains queued after attachments/drag-and-drop.
  Final checkpoint: `npm run check` passes 279/279 and the final full browser run
  passes 75/75. The five import browser checks and the long-chat isolated rerun
  also pass; the earlier intermittent paging failure remains recorded for 26,
  not declared fixed by a green rerun. Native import, imported-chat continuation
  and regular fork smokes pass with private fixtures only. Desktop and 320px
  mobile import dialogs were visually inspected; `git diff --check` is clean.
- 20: `/import` backend integration checkpoint: worker-side source/target
  fingerprinting, encrypted-record callbacks, owner/company/profile binding,
  native result notifications, exact worker-stop tracking, scoped HTTP routes,
  input/queue guards and idle keepalive are connected. Eleven filesystem tests,
  nine adapter/controller tests and seventeen execution/recovery tests pass,
  alongside the nine selection-plan tests. Lost SSH transport does not count
  as an observed native stop; a matching EC2 stop must finish before it can
  authorize acknowledgement. Native reconciliation reloads saved settings but
  never trusts hooks, authenticates accounts or starts an agent turn. The
  installed-CLI smoke exercises production inspection/reconciliation and the
  actual adapter across restart. It also verifies that an empty native root may
  be replaced without losing its recorded import or repeating a stale request.
  The OpenAI Docs skill informed the native flow. The inspector is a bounded
  preflight, not a sandbox for imported code. Composer/result UI and opening
  imported Relay chats are still pending; do not mark `/import` or item 20 done.
  No live data or account was changed. Item 39 remains queued in order.
  Final checkpoint: `npm run check` passes 272/272, the production-adapter
  installed-CLI import smoke passes, and `git diff --check` is clean. No browser
  UI change or deployment is claimed. Continue with the import picker/result
  flow and imported-chat adoption before moving to the next command.
- 39: The saved-prompts composer dropdown was appended after drag-and-drop, as
  requested. The supplied panel sketch places + Prompt above saved prompt rows,
  with long text truncated to fit and a per-row (…) menu for edit/delete. Add
  and edit open popups; saved prompts can be reordered by dragging and dropping.
  Clicking a row inserts its prompt into the draft without sending. Each prompt
  has explicit availability for selected projects or all projects. These details
  refine the same queued item, without interrupting `/import` work in item 20.
- 20: `/import` execution/recovery layer now records intent before dispatch,
  correlates native progress/completion, recovers history without replay, and
  makes confirmations idempotent across restart. Reviews are single-use and
  expire; discarded old result cards cannot authorize old confirmations again.
  Partial failures and unreported selections are not labelled successful. A
  missing history entry or timeout is not treated as a stopped worker; uncertain
  outcomes require its exact observed stop before explicit acknowledgement.
  Sixteen lifecycle tests plus the nine selection tests pass. The installed CLI
  smoke verifies the new layer, actual imported history, persisted operation
  restoration and no duplicate native import after process restart. OpenAI Docs
  informed the asynchronous native workflow. Production filesystem inspection,
  encrypted adapter storage, lifecycle/input guards, HTTP/UI and imported-chat
  adoption are still pending; this is not yet a usable web `/import` command.
  No live chat, native account or personal Chrome session was changed. Continue
  `/import` before advancing in the queue.
  Final checkpoint: `npm run check` passes 251/251; the 25 import-specific tests
  and the installed-CLI smoke pass; `git diff --check` is clean. No browser UI
  change or live deployment is claimed by this backend checkpoint.
- 20: `/import` native-contract and selection checkpoint: nine review-plan tests
  pass, and the installed CLI verifies Claude/Cursor migration in private
  fixtures, source/existing-file preservation, selected native chat history,
  asynchronous results and persistence after restart. The OpenAI Docs skill
  informed the contract. Real testing exposed that skill/command/MCP detail
  subsets do not constrain native imports; these must be confirmed as whole
  groups, while session selections are individually honored. Other-project
  histories are excluded from the review. The metadata planner is not a
  filesystem/authorization boundary. Execution controls, persistence, the web
  dialog and imported-chat opening remain pending; `/import` is not yet available
  through the web UI. No live data or account was changed. Continue this same
  item next, before advancing to the remaining command inventory or item 21.
  Checkpoint regression: `npm run check` passes 235/235, the installed-CLI import
  smoke passes including restart persistence, and `git diff --check` is clean.
- 20: `/memories` now offers native local-memory enablement, use and generation
  controls plus an explicitly confirmed private-profile reset. The OpenAI Docs
  skill informed the distinction between memory use and chat contribution;
  installed-CLI evidence established saved defaults and current-thread updates.
  Generation opt-outs are applied before saving defaults, and concurrent native
  opt-outs win over in-flight enables. Shared host profiles remain read-only
  pending company isolation (21), managed overrides stay locked, and settings
  operations never send a synthetic user message or restart the worker/Chrome.
  Nine unit/controller checks and three browser checks pass. The real CLI passes
  actual memory-summary injection versus disabled use, contribution state,
  restart persistence and reset retaining configuration, unrelated memories and
  conversation history. The first smoke's request-count assertion exposed native
  startup consolidation despite new chat contribution being off; the fixture now
  explicitly verifies those background requests and the UI explains their quota
  implications. It does not claim that resetting files erases existing context
  or stops an active native background pass. All native model responses were
  loopback fixtures, not paid inference or real account work.
  Next inventory entry: `/import`; overall item 20 remains in progress.
- Memories checkpoint regression: final `npm run check` passes 226/226 and the
  full browser suite passes 70/70. The native-settings targeted group passes
  45/45; the installed-CLI memory smoke passes after final concurrency checks.
  Desktop and 320px mobile confirmation views were visually inspected; the reset
  action includes irreversible-deletion and regeneration warnings. The three
  memory browser checks pass again after fixing destructive-button styling.
  `git diff --check` is clean. No live app,
  user conversation, native account or personal Chrome session was changed.
  Live activation remains pending the saved-data restart choice.
- 20: `/experimental` now lists the loaded thread's native beta features and
  confirms private-profile enable/disable actions. Native requirements and
  managed, project or session overrides stay locked; shared host profiles remain
  read-only pending company isolation (21). The OpenAI Docs skill informed the
  beta catalog, policy checks and restart distinction: saving a flag never
  automatically stops the worker, Chrome or background terminals. Network proxy
  is not a network-access grant, and native sleep prevention is separate from
  Relay's idle timer. Ten unit/controller checks and three browser checks pass,
  including stale confirmations, uncertain-write recovery and draft/file safety.
  The installed CLI passes private-profile toggles for Network proxy, Worktrees
  and Prevent sleep while running, configuration refresh, restart persistence
  and trusted project overrides with zero model calls. The native smoke caught
  unstable object ordering in revision hashing; canonical hashing now preserves
  revisions across equivalent responses while rejecting actual changes.
  Next inventory entry: `/memories`; overall item 20 remains in progress.
- Experimental checkpoint regression: `npm run check` passes 217/217 and the
  full browser suite passes 67/67. Updated desktop and 320px mobile confirmation
  views were visually inspected; the picker uses one dialog scroll area. Final
  real-CLI experimental and command/MCP hook smoke checks pass, and
  `git diff --check` is clean. Tests use only isolated fixtures; no live app,
  saved user conversation, account or personal Chrome was changed. Startup and
  live deployment remain pending the user's saved-data restart choice.
- 20: `/hooks` now has event/search filtering, literal source details and explicit
  source-review confirmation before trusting the exact native definition hash.
  Private profiles support verified enable/disable; trust does not enable a
  disabled hook. Managed hooks stay locked, while shared host profiles hide
  executable definitions and remain read-only pending company isolation (21).
  The OpenAI Docs skill informed trust/policy behavior and unsupported MCP
  SessionEnd handling. Eleven new unit/controller checks and three browser
  checks pass. The installed CLI passes real command and anonymous MCP hook
  execution against loopback fixtures, including disabled/untrusted/modified
  rejection, command and argument hash changes, retrust and restart persistence.
  The first native smoke exposed cached definitions differing from `hooks/list`;
  idle private refresh now reloads configuration before reporting state. No
  real account, paid model, live chat or personal Chrome was changed.
  Next inventory entry: `/experimental`; keep overall item 20 in progress.
- Hooks checkpoint regression: final `npm run check` passes 207/207 and the full
  browser suite passes 64/64. Desktop and 320px mobile review/confirmation views
  were visually inspected; the source-review checkbox follows the existing theme
  and remains keyboard accessible. The expanded real-CLI smoke passed both
  command and MCP execution with private loopback fixtures after the final
  controller checks. No live deployment is claimed.
- After the user's computer restart, port 8787 was confirmed offline. Source
  changes survived; restarting the saved-data app was offered separately, and
  tests resumed with isolated fixtures. Deployment is not implied by the reboot.
- 20: `/plugins` now provides marketplace tabs, search, details and confirmed
  install/enable/disable/remove actions in private chat profiles. Shared host
  profiles are inspection-only; company/account isolation remains item 21.
  The OpenAI Docs skill identified plugin mutation RPCs as not production-ready;
  the implementation uses supported CLI commands with native policy checks,
  configuration reload and skill refresh instead. Ten new unit/controller/process
  checks pass, including cancellation, stale revisions, output/time limits,
  minimal environment, policy overrides and interrupted-change reconciliation.
  Three browser checks pass for confirmation, drafts, late replies and mobile
  layout. Real installed Codex passes the complete private local marketplace
  lifecycle with a loaded native thread and zero inference. Remote authenticated
  marketplaces and deployment are not claimed. The next native inventory entry
  is `/hooks`; keep overall item 20 in progress.
- Plugins checkpoint regression: `npm run check` passes 196/196 and the full
  browser suite passes 61/61. The first targeted mobile check exposed horizontal
  overflow in the existing chat header at 320px; controls now wrap with an
  automatically sized header, and both horizontal and vertical containment are
  checked. Final desktop/mobile previews were inspected. The installed-CLI
  smoke passed again after the final controller changes. No live server, native
  account, user chat or Chrome session was restarted or modified.
- 38: Drag-and-drop images and files onto the chat was appended after the
  clickable attachment-card redesign, as requested. Drops should stage draft
  attachments, never submit automatically, retain existing text/files and use
  the same limits, upload errors and previews. Not implemented ahead of the
  current command work.
- 20: `/apps` now opens a searchable native app picker for the current Codex
  thread. Selection stages a token and a private, chat-owned reference without
  sending a message, installing an app or modifying credentials. Dispatch checks
  native accessibility/enabled/callable policy again, including queued inputs;
  stale owner/company/root and forked references cannot silently grant access.
  Seven new unit/controller/protocol checks and three desktop/mobile browser
  checks pass. The installed CLI also passes scoped discovery and unknown-app
  rejection in a private unauthenticated profile with zero model calls. Real
  authenticated connector invocation is not claimed, and shared host-profile
  credential isolation remains item 21. The OpenAI command/app-server references
  informed the structured `app://` mention implementation. Live activation is
  pending; the next inventory entry at that checkpoint was `/plugins`.
- Apps checkpoint regression: `npm run check` passes 186/186 checks and the
  full browser suite passes 58/58. The first parallel run hit an existing
  two-second Chrome capture deadline, which passed in isolation. A later full
  rerun exposed fixture shutdown waiting on an unfinished browser HTTP request;
  the new regression reproduced it before the fixture cleanup fix. The final
  full suites pass without manual cleanup. Only test-owned Chrome processes
  were stopped during diagnosis; the live server and the user's Chrome were
  not restarted, and no live chat or account was modified.
- 37: The latest examples extend the queued attachment redesign to both images
  and files, before and after sending. Preserve one card row, thumbnail images,
  filename/type cards, and click-to-open large image or scrollable text previews
  (including filename, size and text line count). This stays after item 36 and
  has not been implemented ahead of the current command work.
- 20: `/ide`, `/mention` and `@path` now use explicit workspace context. A
  read-only third-column viewer opens actual worker files, captures selected
  ranges, and stages references in the existing private attachment flow. Send
  waits for capture; queued/sent snapshots survive source edits and worker or
  controller restart. Twelve reader/controller checks cover containment,
  bounded search, binary/large files, Unicode/line endings, ownership before
  and after capture, remote executor roots, fork rebinding, Claude input,
  Stop races and viewer leases. Real installed Codex passes against loopback
  model responses: the selected text arrives as user-level untrusted context,
  without unselected text or later file edits. Native `UserInput.mention`
  silently ignored file paths in the first smoke; the implemented path uses
  `additionalContext` instead. This is Relay's viewer, not an external IDE
  connection. Selected text is kept out of ordinary chat/SSE summaries and
  fetched only for attachment previews. Live backend activation is pending;
  next command category is native configuration and connected services.
- Workspace-context regression: 178/178 unit/integration checks and 55/55
  browser checks passed, including five new workspace-context scenarios. The
  shared presence dependency now tracks announced transitions rather than
  racing wall-clock expiry; a deterministic regression reproduced the missing
  close notification before the fix. The real-CLI/local-model workspace smoke
  passed again after final integration. The first browser run
  exposed older agent-picker fixtures racing their underlying stopped-chat
  sidebar snapshots; their native fixture revision now consistently identifies
  the newer state, without changing assertions or production picker behavior.
  No live backend, user messages, personal Chrome profile or account was changed.
- 20: `/agent` and `/subagents` now open a native descendant picker with separate
  conversation, draft, approvals and stop controls. Nine controller/protocol
  tests cover ancestry vs. unrelated roots/forks, scoped actions, offline
  persistence, retry IDs, native completion races, snapshot restoration and
  live-history races, and automatic nested-agent discovery. Three desktop/mobile browser checks cover routing,
  aliases, saved reads without waking, pagination and late-reply draft safety.
  The real installed CLI passed bounded history, nested ancestry, direct child
  replies/steering, interruption and parent survival with private synthetic
  sessions and loopback model responses. No actual delegated work, paid model
  calls or changes to the user's live chat/browser were involved. Live activation
  still awaits the safe restart decision. Next in the command inventory:
  `/ide` and explicit workspace file mentions.
- Regression at the agent-thread checkpoint: 165/165 unit/integration checks
  and 50/50 browser checks passed. Native navigation passed three consecutive
  real-CLI/local-fixture runs; the nine targeted checks and native smoke then
  passed again after child Stop was extended to pause only that child's active
  goal. The first full browser run exposed fixture chats crowding the sidebar's
  existing drag test; the new fixtures now delete only their own temporary chats,
  and both the combined agent/organization run and full suite pass. No live
  backend restart, real chat mutation, account or personal-browser access.
- 20: `/fork [title]` now reaches the controller and creates an independent chat,
  copying native history, workspace and chat-owned attachment records. It keeps
  company/environment/model settings, not queues, approvals or browser grants.
  Ten controller checks cover isolation, private persistence, first-input goal
  activation, Plan, manual Stop, agent switching, idempotence, cancellation,
  empty chats and startup races. Two browser checks cover retry identities,
  successful navigation, duplicate clicks and late responses preserving drafts.
  The real CLI/controller smoke verified active-source isolation, deletion of
  the source, deferred goal continuation and budget, attachments, restart, and
  zero model calls for fresh/opened-empty chats. Remaining native commands are
  still in `command-support.md`; live activation remains pending.
- Regression after controller/UI fork integration: 156/156 unit/integration
  checks and 47/47 browser checks passed. An additional real-CLI/controller smoke
  passed after cancellation cleanup was added. All tests used isolated fixtures;
  the user's backend, live chat and Chrome profile were not restarted or changed.
- 20 (previous persistent-fork checkpoint, before UI wiring): Native history
  transfer preserves the fork's exact byte boundary and nested ancestry without
  copying credentials. Seven workspace-copy checks cover Git staged/unstaged
  state, ignored/untracked files, independent hardlinks, rebased internal links,
  worker-executor transfer, Git redirects, traversal, limits, cancellation and
  concurrent edits. Missing/mismatched fork history now fails instead of silently
  opening an empty session. The real installed Codex smoke passed fresh-profile
  and nested resume, independent workspace edits, goal-budget restoration and
  continuation after fixture source profiles were removed. Controller persistence,
  attachment rebinding, first-input goal activation and UI wiring were completed
  in the subsequent checkpoint above. No live chat, browser, account or backend
  process was changed.
- Regression at the persistent-fork checkpoint: 145/145 unit/integration checks
  and 45/45 browser checks passed. The five bundle checks were rerun after the
  final budget/operation-validation change. Remote workspace transfer used an
  executor fixture; no EC2 instance was provisioned for verification.
- 20: Implemented native `/side` and `/btw` using an ephemeral Codex fork in
  the existing worker, with a resizable third-column UI, isolated streaming,
  questions/approvals, attached files, and side-only stop/end controls. Main
  drafts, transcripts, queues and goals remain untouched. Reading side state
  does not wake a worker; active side turns prevent idle sleep. No transcript
  directory is copied and no side messages are injected into the main chat.
  The real installed CLI passed concurrent main/side turns, inherited context,
  active-goal isolation, cancellation, and main continuation after side close.
  It rejects `deferGoalContinuation` on ephemeral forks; that option is correctly
  omitted. Four controller checks cover authentication, ownership, attachments,
  question routing and close-during-fork cleanup; three browser checks cover
  responsive resizing, draft retention, answers, reload and delayed-response
  isolation. Full command coverage remains in progress; activation is pending.
- Regression after side-chat implementation: 132/132 unit/integration checks
  and 45/45 browser checks passed. An earlier run had 44/45: Chrome reported
  `ERR_NETWORK_CHANGED` on startup settings GETs before the Plan test could
  open its composer. The complete rerun passed; no assertion was weakened or
  failure hidden. Native side-fork tests used the real CLI with loopback model
  fixtures only, without accessing a real account, live chat or personal Chrome.
- Previous regression checkpoint during #20: 127/127 unit/integration tests and
  42/42 browser tests passed, including native-terminal/config-inspection and
  aliases. Real installed Codex and Claude compaction plus Codex review
  completion/interruption also passed against loopback API fixtures. Codex
  terminal/config inspection and empty-task cleanup passed against the real CLI;
  Claude reload-skills, autocompact and config help returned native output with
  zero model calls. Live backend activation remains pending.
- 20/21 dependency audit: host-auth workers intentionally use the host's
  `CODEX_HOME` / `CLAUDE_CONFIG_DIR`. Native settings/account/plugin commands can
  therefore affect shared configuration unless explicitly scoped. Do not wire
  arbitrary global config/account mutations as a shortcut to command coverage;
  company isolation acceptance must include inherited native configuration, not
  only Relay's own connection records. No host settings were changed by checks.
- 20 (in progress): Real installed Codex goal set/get/pause/clear and automatic
  continuation passed against a loopback-only model stub. Added native review,
  `/init`, goal editing, queued model/effort/permission settings and working web
  aliases. Native review exposed distinct inner started-turn and outer completed-
  turn IDs; the adapter now tracks both. The corrected real-CLI review smoke
  returned reviewer output. Browser goal-edit/queue/control/draft checks passed.
  Full command coverage and the remaining native/terminal controls are not yet
  verified; do not mark this queue item complete.
- 36: The user accepted the existing roughly one-minute auto-merge polling but
  explicitly still requested event subscriptions. Keep that as a separate queued
  implementation, not a retraction of #35 or permission to interrupt the current item.
- 19: Five queue controller tests passed for selected-only Send now, FIFO,
  paused queues, invalid/duplicate IDs, manual Stop winning races, preparation
  cancellation and attachment-preserving failures. New browser check passed for
  the per-row action, pending/disabled state, retry, other rows and composer draft.
- 18: `/plan <task>` reaches the controller as a plan action and uses read-only
  mode. Bare `/plan` now queues when busy instead of failing a mode update, and
  failed controls retain the typed command. Three command tests and the new
  browser task/queue/error-preservation check passed.
- 17: Added selectable question options and free-text answers, Skip, and Alt+Up
  focus. Stable request rendering preserves input/focus during live updates.
  Frontend and controller now retain a newer question if an older response finishes
  later; answers are validated against requested IDs. Nine relevant controller
  checks and the new browser interaction/race/retry test passed. Native request
  handling was checked against the official OpenAI app-server documentation.
- 16: Real-extension test passed (no skipped test), including signed-out guest,
  explicit UI grant, saved login reuse only in the automation tab, immediate
  revoke, late-result rejection, preserved unrelated tabs, persisted pairing and
  default-off after browser/controller restart. Five ownership/pairing/session
  tests and the desktop/mobile setup browser test also passed.
- 14: Five browser checks passed: composer/command UI at 320–1440px,
  agent switching, prefix selection via keyboard/click, delayed discovery,
  Escape cancellation, retryable errors, and no accidental prompt submission.
- 15: Read-only live audit: 495 records = 254 real (16 user, 10 assistant,
  227 tool, 1 system) + 241 tagged synthetic. The agent is idle with no queued
  input or pending approval. Asked for the source real conversation and for
  permission to activate the backend without interrupting work. No data changed.
- 12: Compact-sidebar browser check passed: no status/age sub-row, controls align
  with the title, row height stays below 40px, status remains accessible.
- 13: Preview CSS uses a low-priority layer with system typography, spacing,
  zebra tables, borders, code/list/heading styles, and responsive padding.
  Previously passed document tests verify actual table styles/alignment and
  author-CSS overrides without changing the host UI.
- 11: Both deletion browser tests passed: cancel keeps the chat, confirmation
  deletes only its target, other drafts remain, mobile controls fit, failures
  stay retryable, deleting the final chat clears previews, and another open tab
  updates. Tests delete isolated fixtures only, never the user's live chat.
- 10: Passing MCP tests demonstrate independent same-name Linear connections,
  distinct credentials, primary-repository filtering despite a secondary repo or
  display group, denied cross-company capability use, and independent disconnect.
  The browser check saves/selects both connections in one multi-company environment.
- 09: Read client/server transport paths: `/api/chats/:id/browser/live` is an
  authenticated WebSocket; `/api/chats/:id/events` and `/api/sidebar/events` are
  SSE with reconnects/heartbeats. Mutations use HTTP. Provider PR checks are
  separate scheduled HTTP polling, not page reload polling.
- 08: The already-passing document acceptance tests check desktop three-column
  geometry, HTML/Markdown/SVG/text, independent preview scroll across live updates,
  panel mutual exclusion, focus restoration, draft preservation and widths down
  to 320px. No iframe is mounted inside the message transcript.
- 07: Browser acceptance passed for hover/mobile opening, original-message
  positioning/focus and Escape dismissal.
- 06: Up/Down traversal stops at the first message, preserves the unsent draft
  and per-chat edits, ignores modifiers/selection/IME composition, and sends
  nothing. Unit and browser acceptance checks passed.
- 05: Real PostgreSQL restart restores messages and context into an empty new
  controller directory. Stop-time usage is flushed before worker cleanup; saved
  account/rate-limit data also survives. A stopped-chat browser reload shows the
  context snapshot without any wake/message/queue requests. Six relevant unit
  checks and the browser acceptance check passed.
- 04: Read-only discovery against the real Paladira endpoint succeeded: it
  advertises dynamic registration, PKCE S256, read/write scopes and refresh tokens.
  A matching `/api/mcp` + `/api/oauth/*` fixture completed registration, consent,
  code exchange, saved-token reload and tool discovery. Six OAuth tests and the
  popup-consent browser test passed. No live account was authorized; real consent
  remains a user action after backend activation, not a claimed completed install.
- 03: All seven presets fill the expected endpoint/authentication without saving
  or granting access. Verified against official [Linear](https://linear.app/docs/mcp),
  [Atlassian](https://atlassian.github.io/atlassian-mcp-server/),
  [GitHub](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md),
  [Sentry](https://mcp.sentry.dev/),
  [Figma](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/),
  [Notion](https://developers.notion.com/guides/mcp/get-started-with-mcp), and
  [Context7](https://context7.com/docs/resources/all-clients) docs. Updated the
  Atlassian help URL; its recommended v2 endpoint was already correct.
- 02: Both installed CLIs discovered selected HTTP and stdio MCPs using private
  temporary configurations, without model calls or real credentials. Nine
  connection/OAuth/environment tests and two MCP browser checks passed. Worker
  configuration contains scoped gateway capabilities, not upstream secrets;
  stopping/restarting revokes and refreshes those capabilities. Native Codex
  configuration was checked against the official MCP documentation.
- 01: Four browser acceptance checks passed for Markdown, raw/fenced HTML,
  malformed snippets, CSS isolation, blocked remote requests, desktop/mobile
  preview panels, and live updates. The running server returns the expected
  opaque-sandbox preview CSP and all required preview assets successfully.
- Prior regression run: 121 unit/integration checks passed. Browser run: 32/34;
  the old Compact-disabled assertion was updated and a real smooth-scroll/history
  paging regression was fixed. Both affected browser cases then passed three
  times each. This is not a substitute for ordered feature acceptance.
- Both installed Codex and Claude completed native compaction through Relay's
  real adapters against deterministic loopback API stubs; no real model calls.
- Do not discard the active live worker, unsent drafts or guest Chrome/cart state
  during deployment. Real OAuth consent must be completed by the user.
