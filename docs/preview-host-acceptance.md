# Controller-role preview-host lifecycle acceptance

`scripts/smoke-preview-hosts.mjs` defaults to a dry plan: no AWS, credential reads
or journal changes. Its explicit `--run` creates **one** temporary CloudFront
distribution; `--cleanup` only resumes the exact existing journal's teardown.
This is an operator primitive test, not a Google user, product record, working
app preview, browser consent or end-to-end AWS proxy acceptance.

Run only after independent review and explicit authorization, on the exact
controller `i-08c991c22089589a5`, account `456808212788`, region `us-east-2`, stack
`agent-relay-mvp`. Root must first keep a feature-aware rollback image: an old
controller without strict Host dispatch must not serve the new hostname.

## Isolated launch contract

Use a separate disposable container from the independently confirmed immutable
application digest. The current reviewed application image is:

`456808212788.dkr.ecr.us-east-2.amazonaws.com/agent-relay-mvp-applicationrepository-sujdgarjwejp@sha256:9dbb6306863a60de96cf91118165b6164d053de72dbe04777fc5dfd296db6d9a`

It includes the reviewed production provider. It does not need a rebuild for
this operator: bind the reviewed helper file read-only to
`/app/scripts/smoke-preview-hosts.mjs` and override the entrypoint with `node`.
Required container settings:

- Unique `relay-preview-acceptance-<UUID>` name and an operator acceptance label.
- `--network host`, solely to use the exact controller instance role via IMDS.
  The helper creates no listener or application HTTP traffic.
- `--user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges`.
- A private tmpfs `/tmp`; only a new dedicated UID1000 mode0700 operator
  directory is writable, mounted at `/acceptance`. Never mount `/srv/relay/data`,
  `/var/lib/relay`, the Docker socket, a credential directory or the product DB.
- No `--env-file`, application secret, AWS profile/key, host auth cache, model
  key or worker SSH key. CLI rejects known provider/secret overrides. The image's
  static non-secret defaults do not start an app because the entrypoint is fixed.
- `-i` without a TTY, feeding only the bounded public JSON below. Never paste
  provider credentials into SSM commands or Docker arguments.

Public input is exact, no extra keys; derive origin DNS, origin ID and role ARN
from independently verified owned stack outputs/resources, not browser input:

```json
{"schema":1,"runId":"NEW-V4-UUID","expectedRoleArn":"arn:aws:iam::456808212788:role/agent-relay-mvp-ControllerRole-OWNEDSUFFIX","vpcOriginId":"vo_OWNED","controllerOriginDns":"ip-PRIVATE.us-east-2.compute.internal"}
```

The live STS ARN must be that exact role with the controller instance ID as its
session name, before any create intention and at each reconciliation. A general
operator/admin profile is insufficient. Production checks independently bind
account, VPC origin, controller, config, tags and saved caller reference; Relay's
own distribution is explicitly excluded. Owner/chat strings are unique
operator-run identifiers, not fabricated authenticated users. Port43123 is fixed;
no service is started or contacted at it.

## Lifecycle and interruption

The mode0700 journal directory and mode0600 nonsecret `journal.json` hold the
public run/config and at most one provider record. Every record update is an
atomic same-directory rename, fsynced before return; the intention precedes AWS
creation. An exclusive lock is acquired before reading. A stale lock is never
stolen automatically: first independently observe the exact old container has
ended, then the operator may remove only that lock and run `--cleanup` with the
same journal and public input. Do not delete the journal or generate a new run
to evade an ambiguous create response.

The create phase has a ten-minute deadline propagated to AWS calls. Once ready,
the helper constructs a fresh provider over the same journal: routing must be
pending/denied until full AWS revalidation returns the same ID/hostname, without
another creation. Revocation must invalidate lookup synchronously. Cleanup has
a separate fifteen-minute deadline, even after create failure or SIGTERM/SIGINT:
disable, wait for Deployed, record delete intention, delete, then confirm exact
ID absence in complete bounded inventory. The process retains the journal on
**every** exit; an SSM/operator deadline must allow the full25minutes plus startup
and command margin. Killing the process cannot be advertised as cleanup.

An existing journal never enters a new create acceptance phase. `--run` on it
performs cleanup but returns the fixed existing-journal category; `--cleanup`
may succeed once exact deletion is observed. Successful API submission alone is
not proof of deletion. Failure reports separate ready/role/revoke/deleted flags
and fixed categories; no raw AWS response, credential, stderr or exception is
printed. If cleanup is unconfirmed, retain the exact journal/container evidence
and finish scoped recovery before claiming the AWS gate passed.

The offline suite exercises the real production state machine against fake AWS,
including ambiguous create/delete, no duplicate after restart, exact role,
failed readiness cleanup, denied deletion, cancellation, durable fsync journal,
concurrent lock rejection and bad scope/symlink rejection. It is not actual AWS
permission or provisioning evidence. A real receipt must be paired with the
operator container's observed exact image/role and final resource inventory.
