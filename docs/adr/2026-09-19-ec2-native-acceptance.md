# ADR: bounded native Claude acceptance on a disposable private worker

Status: implemented operator; real AWS/provider execution remains a separate gate.

## Decision

Use an explicitly tagged, already-launched, disposable EC2 worker for the real
native Claude/SSH acceptance. Do not import personal accounts into the deployed
Relay database. GitHub access stays on the controller: repository preparation
clones there and uploads a credential-free workspace to the worker. A private
GitHub token or `gh` binary on the worker would test a different architecture and
is deliberately excluded. The existing isolated controller GitHub read test and
fresh product consent remain separate evidence.

`scripts/smoke-ec2-native.mjs` defaults to a zero-call plan. Only explicit `--run`
allows public AWS metadata checks, signed package download, an SSM port-forward
session, SSH and two native Haiku turns. It never launches, stops or terminates
instances, reads Secrets Manager, authorizes accounts, refreshes Claude tokens,
modifies the user's source credential, or invokes Codex.

## Boundaries

- Fixed MVP target: profile `code-web`, account `456808212788`, region
  `us-east-2`, completed stack `agent-relay-mvp`, controller
  `i-08c991c22089589a5`. Ownership outputs must match the stack resource list.
- The `t3.medium` worker must have the selected private, encrypted, pinned deployment AMI,
  exact deployment subnet/group/key, no public address, no role, disabled IMDS,
  and `AgentRelayNativeAcceptance=<acceptance UUID>`. `AgentWebChat` and image
  verification tags are rejected; this cannot select an active product chat.
- The worker group permits SSH only from the exact controller group. Re-check
  account/resources before credential transfer and recovery cleanup.
- Private SSM port-forwarding targets only that worker's private IP/port 22 via
  the controller. No credential is in SSM parameters. The existing SSH launcher
  carries its fixed header then the request through stdin, not process argv.
- The local deployment key is owner-private and its derived public key must
  match the stack key. A fresh private known-hosts file trusts the first
  controller-routed connection to this guarded worker, then pins that host key
  for subsequent native and cleanup channels. This is TOFU over the scoped AWS
  transport, not independent hardware host attestation.
- Only the source access token and expiry cross SSH. A current ten-minute
  minimum expiry is required. No refresh token, browser profile, host HOME,
  hooks, MCP configuration or user conversation history is copied. The source
  file is opened no-follow, owner-private, bounded, and hashed before/after in
  memory; no hash, credential or account identity is printed.
- The remote native profile/workspace is fresh and private. Profile identity
  is checked before/after; only the equality result leaves the worker. Claude
  native version is pinned to `2.1.222`. The first turn replies `OK` and stores
  an acceptance marker; `--resume` must recover that marker in the second turn.
- Each invocation has one turn, no tools, strict empty MCP config, no hooks,
  Haiku and a USD 0.05 CLI budget. The accepted receipt requires Haiku-only
  model usage and cost no greater than 0.05 per result. The sum is reported as
  `costUsdUpperBound` because resumed CLI accounting may be cumulative. CLI
  budget flags are safeguards, not a guaranteed provider-side billing cap.
- The worker's audit must show finalized/credential-free image, fresh machine
  identity, heartbeat/watchdog active and metadata/SSM disabled before use.
  This reuses the product launcher and the image acceptance ownership contract.
- Cleanup removes only the matching private profile after validating its
  ownership marker. Recovery refuses a still-live probe PID; it does not erase
  a profile underneath a running model process. Failure to confirm cleanup
  fails the operator and requires terminating the exact dedicated worker.
- The operator closes and terminates only its own SSM session, then removes
  its task-private downloaded plugin/GPG directory. SIGTERM/SSH interruption
  cannot guarantee remote process cleanup; the dedicated instance must be
  retired after every run, including success. That lifecycle belongs to the
  supervising operator, not this script.

## Verified private Session Manager plugin

Download only the pinned `1.2.835.0` signed Linux x86_64 `.deb` and signature.
Use a new private GPG home and the checked-in **public** AWS signer, requiring
fingerprint `7959637124CE093AD501D47A2C4D4AFF6F6757EE` and matching `VALIDSIG`.
Only then extract with `dpkg-deb --extract` and verify the binary's version.
No `apt`, global package install, `sudo` or user keyring modification is used.

The operator also pins reviewed AWS CLI `2.35.20`, whose Session Manager adapter
passes the SSM response through `AWS_SSM_START_SESSION_RESPONSE` for this plugin
version. A private wrapper rejects the historical response-in-argv fallback.
Neither AWS debug mode nor plugin session logging is enabled.

Primary sources: [AWS signature procedure](https://docs.aws.amazon.com/systems-manager/latest/userguide/install-plugin-linux-verify-signature.html),
[plugin release history](https://docs.aws.amazon.com/systems-manager/latest/userguide/plugin-version-history.html),
[AWS CLI 2.35.20 Session Manager adapter](https://github.com/aws/aws-cli/blob/2.35.20/awscli/customizations/sessionmanager.py).

## Running after review

First run the default plan (no AWS calls or credential reads):

```sh
taskset -c 0,1 nice -n 10 node scripts/smoke-ec2-native.mjs
```

The supervising operator must first launch the dedicated instance using the
accepted AMI, `t3.medium` type, deployment key/private network, no role, IMDS disabled and a new
UUID. Its tags are `ManagedBy=agent-relay`,
`AgentRelayDeployment=agent-relay-mvp`, and
`AgentRelayNativeAcceptance=<UUID>`. Do not set product chat or image-verification
tags. Wait for the guest to finish its fresh boot. Then explicitly run:

```sh
taskset -c 0,1 nice -n 10 node scripts/smoke-ec2-native.mjs --run \
  --worker-id i-EXACT-DISPOSABLE-WORKER \
  --image-id ami-EXACT-ACCEPTED-IMAGE \
  --acceptance-id EXACT-NEW-UUID \
  --claude-auth /absolute/path/to/authorized/private/claude/credential
```

The default SSH key path is
`~/.local/share/agent-relay-aws-mvp/worker-ed25519`; an absolute `--ssh-key` may
override it but must match the deployment public key. Do not pass tokens in
arguments. Keep the source account idle during the test so another process
does not legitimately refresh its credential concurrently.

After success **or failure**, recheck the exact instance ID and native acceptance
tag, terminate only that disposable instance, and observe its termination. The
JSON receipt intentionally says `workerRetirementRequired: true` until the
supervising operator records that separate cleanup evidence. Do not label the
full acceptance complete without it. If the process was forcibly killed,
also inspect/close its exact SSM session; never terminate all user sessions.

## Local evidence and limits

Fixtures cover default no-call plan, owner/network/AMI/tag drift, private
source/no-refresh transfer, before/after source preservation, bounded native
turn/resume behavior, failure cleanup, live-PID refusal, signature failure
before extraction, checked-in signer fingerprint, SSH stdin boundary, tunnel
session isolation, and receipt allowlisting. Existing real local SSH launcher
tests cover framing, streams, EOF and bounded termination.

These fixtures do **not** prove live provider authorization, AWS connectivity,
plugin download/execution, fresh product consent, or an end-to-end browser
product chat. Record the independently run real operator receipt plus exact
worker retirement before changing that gate. No AWS/model run was performed
while implementing this operator.
