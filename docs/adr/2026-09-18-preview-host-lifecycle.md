# Durable, never-reassigned CloudFront app preview hosts

Status: implementation and fixture tests; **not an end-to-end preview acceptance
receipt**. No AWS resource was created/changed/deleted by this feature agent.
The user selected the no-custom-DNS route. Root owns active server routing,
bootstrap, runtime lifecycle, deployment and real acceptance.

## API and controller integration

`new PreviewHosts({records, config, aws?, onChange?, now?})` uses the existing
encrypted controller records store, namespace `preview-host`. `MemoryRecords`
is test-only injection. There is no local-file fallback. This primitive assumes
the existing **single active controller** deployment; its serialization is not
a distributed lock. Do not run two active controllers against the same store.

- `await initialize()` loads and validates durable records without AWS work.
  Restored ready records are not admitted until reconciliation rechecks AWS.
- `await ensure({ownerId, chatId, port})` reserves quota and persists a new
  `pp_<uuid>` intent before any AWS call, or returns the existing active tuple.
  `ownerId/chatId` must come from the authenticated controller-owned chat, not
  the request body. Ports are integers 1024–65535. Intent caller references are
  stable and never regenerated on a failed/ambiguous AWS request.
- `get(id,{ownerId,chatId})` and `list({ownerId,chatId})` return defensive frozen
  public views. Status is `pending`, `ready`, `revoking`, `deleted`, or `error`.
  Steps are `create`, `deploy`, `disable`, `delete`, or null. Fixed errors contain
  no provider stderr, credentials, arbitrary record fields or raw DB failures.
- `lookup(hostname)` synchronously returns only an exact ready assignment with
  immutable `id/ownerId/chatId/port/hostname`, or null. It does not authenticate a
  browser or choose a worker. Root must validate current session, chat/runtime
  generation, and exact executor before issuing grants or forwarding traffic.
- `await revoke(id,{ownerId,chatId})` synchronously removes ready admission and
  notifies listeners **before** awaiting durable revocation. Root must revoke
  grants/streams immediately; deleting CloudFront resources takes minutes.
- `await reconcile({limit:2})` coalesces concurrent passes and advances at most
  two assignments per pass (explicit limit 1–8). Root schedules it; there is no
  hidden timer. Pending/error/revoking work resumes after restart. Transient
  errors retain intent and may retry automatically on later passes; Retry UI
  is not a guarantee that no background retry will happen. Ownership/config
  errors never bypass validation and expose `retryable:false`; operator repair
  can make a later observation valid. Ready assignments are rechecked after
  sixty seconds. `onChange(view)` is notification, not unconditional revocation:
  root revokes when the assignment becomes non-ready or lifecycle changes, not
  on an unchanged ready refresh.
- `await close()` denies admission, clears ready cache, aborts the owned AWS CLI
  call and waits for the active reconciliation/persistence queue. Persisted
  intents allow later recovery; shutdown does not delete hosts or user data.

Config: `enabled` defaults false; enabled requires `expectedAccount`,
`deployment`, `vpcOriginId`, `controllerInstanceId`, `controllerOriginDns`,
`relayDistributionId`, and AWS `region/awsBin/profile` (empty profile uses the
controller IAM role). Root's config parser maps `AGENT_PREVIEW_*` settings and
requires Google authentication, HTTPS and EC2 workers. The entrypoint already
passes environment unchanged; no second configuration channel was introduced.
Default live intent caps: 8 deployment / 4 owner / 2 owner+chat, absolute 40.
Pending, error and revoking intents count against caps. Deleted tombstones do
not count, but remain durable forever to reject reused generated hostnames.

## CloudFront ownership and recovery

Each owner/chat/fixed-port gets its own generated CloudFront hostname. Changing
port requires another assignment. A revoked/deleted tuple gets a **new** intent
and distribution on later setup. A hostname observed in any old tombstone is
never accepted for another assignment, including another owner/chat.

Before provider work, verify STS account, exact existing VPC-origin ID/ARN,
deployment origin name, EC2 controller ARN/instance/tags/private DNS and HTTP
8787. CloudFront uses this same existing private VPC origin and AllViewer;
root's early, exact Host dispatcher must separate preview requests from Relay.
Unknown/noncanonical hosts must never reach Relay routes. Never trust
`X-Forwarded-Host` or use it to select a chat. AWS documents that
[AllViewer forwards the viewer headers, cookies and query strings](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html),
including Host; this differs from AllViewerExceptHostHeader. Actual AWS routing
is still an acceptance gate, not implied by this configuration.

Create uses `CreateDistributionWithTags`, the durable reference, no aliases,
CloudFront certificate, HTTPS-only viewers, cache-disabled/AllViewer policies,
no compression/functions/Lambda/origin failover/logging/gRPC, and zero error-cache
TTL. CloudFront deployment is polled, not assumed immediately ready. Owner and
chat tags are SHA-256 opaque identifiers, not emails. Every adoption/read/update
checks account ARN, ID, exact purpose/deployment/owner/chat/port tags, generated
hostname, caller reference and complete normalized immutable config.

On ambiguous creation, bounded paginated account inventory selects only the
saved intent's exact comment as a *candidate*, then all checks above remain
mandatory. Matching tags/comments alone never authorize adoption. Retrying the
same caller reference cannot allocate a second distribution: AWS documents
[`DistributionAlreadyExists` on a reused CallerReference](https://docs.aws.amazon.com/cli/latest/reference/cloudfront/create-distribution-with-tags.html).
Inventory is bounded to ten pages of 100; exceeding this is an explicit error,
not a claim of absence. Ambiguous revocation may complete that same saved create
solely to locate and disable/delete its late resource; its hostname is never
admitted to the router during cleanup.

Deletion validates exact ownership/config, disables with the current ETag,
waits for disabled **Deployed**, durably marks the delete intent, then deletes
with a fresh observed ETag. The next pass confirms exact ID absence in the full
bounded account inventory. This final list check is deliberate: a deleted
distribution no longer has tags for IAM resource-tag-gated GetDistribution.
Successful API submission alone is not cleanup completion. Failure/ETag races
never cause another resource to be selected or force-deleted.

## IAM and opt-in deployment

CloudFormation parameter `EnableAppPreviews` defaults `false`. The conditional
leaf `PreviewHostingPolicy` attaches to the existing controller role **after**
the existing VPC origin/distribution exist; putting those references in the role
itself would introduce a dependency cycle. Outputs add `VpcOriginId`,
`ControllerOriginDns`, and `PreviewHostingEnabled`. Secret publication forwards
preview settings only when both explicit `AGENT_PREVIEW_ENABLED=1/true` and that
stack enable output agree. Workers obtain no IAM role/CloudFront permission.

Permissions: account inventory read, exact VPC-origin read, tag-required create,
same-account distribution tagging, resource-tag-constrained read/update/delete,
and an explicit `cloudfront:*` deny on Relay's own distribution. No standalone
tagging call, VPC-origin mutation, DNS/certificate permission, PassRole or public
worker ingress is added. The primary
[CloudFront IAM action table](https://docs.aws.amazon.com/service-authorization/latest/reference/list_cloudfront.html)
explicitly supports request tags for CreateDistribution and resource tags for
GetDistribution/ListTagsForResource/UpdateDistribution/DeleteDistribution.

**Accepted trusted-controller boundary:** CloudFront lacks an `ec2:CreateAction`
equivalent for TagResource. Required request tags + same-account ARN and existing
tag checks constrain permission, but cannot prove an IAM-only restriction to
tagging at creation: a compromised controller could tag an unrelated untagged
distribution. Durable saved-reference/full-config application checks are
mandatory and trusted controller code never invokes standalone TagResource.
Do not describe this as an IAM sandbox against controller compromise. Existing
foreign tagged resources fail conditions; Relay itself is explicitly denied.

Before activation, root must inspect a CloudFormation change set: only this
new conditional IAM policy and outputs/parameter should change. No controller,
volume, worker, VPC origin or Relay distribution replacement/update is intended.
The code/fixture tests are not IAM simulator or real provisioning evidence.

## Evidence and remaining gates

Read-only STS + exact existing Relay `GetDistribution` schema inspection was
authorized and performed; no foreign distribution was queried. It confirmed
the response certificate defaults, empty error-response fields and added
`GrpcConfig.Enabled=false`; these are covered by strict config normalization.
Recursive quantity checks also verify generated list sizes. No credential/raw
CloudFront configuration was printed; only fixed schema fields/comparison flags.

Fixtures cover durable-before-create, concurrency, restart, ambiguous create
and delete, scoped get/revoke, quota reservations, late creation after revoke,
disable/deploy/delete ordering, exact absence, immutable config/tag/account
rejection, CLI error redaction, off-default env/IAM and acyclic CloudFormation.
Real role permissions/provisioning/deletion, authenticated bootstrap, original
paths/assets/uploads/SSE/WebSocket and owner/chat/session isolation remain root's
separate end-to-end acceptance obligations. Gate 45 is not closed by this file.
