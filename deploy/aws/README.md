# Private EC2 workers

For the separately scoped, disabled-by-default GitHub application rollout,
see the [CI identity and activation runbook](CI.md). It does not provision workers
or modify this application's infrastructure stack.

One chat owns one VM and encrypted EBS root volume. The controller starts or
resumes it on demand, stops it after idle, and terminates it when its runtime is
deleted. MCP and provider-API-key integrations use revocable gateway
capabilities; their upstream credentials stay on the controller. Native named
Codex/Claude accounts require the selected account's short-lived access token
inside this one-chat VM. Refresh tokens and durable account credentials stay
encrypted on the controller. Do not use a shared VM for untrusted users.
Docker access is root-equivalent inside this one-chat VM.

The controller uses its IAM role through the default AWS credential chain:
leave `AWS_PROFILE` empty on EC2. An explicit named profile remains supported
for operators. `AGENT_EC2_DEPLOYMENT` must match the CloudFormation stack.
Every lookup/mutation requires matching deployment, ManagedBy and chat tags;
the backend also verifies subnet, exact security group/key, absence of an IAM
profile/public IP, and disabled metadata. Ambiguous/legacy instances fail closed.
The CloudFormation controller role limits AWS actions to the deployment's
resources. The old broad `agent-web-poc` starter IAM policy has been removed.

## Bake an image

Run this **explicitly** after creating the application stack; it incurs charges
for one temporary private builder, an AMI and its encrypted snapshot. Copy the
six named stack outputs into the corresponding arguments. The account ID is an
additional required safety check; a profile name alone is not sufficient.

```bash
node deploy/aws/bake-worker-ami.mjs \
  --profile code-web --region us-east-1 --expected-account 123456789012 \
  --deployment YOUR_STACK \
  --subnet-id subnet-0123456789abcdef0 \
  --security-group-id sg-0123456789abcdef0 \
  --key-name YOUR_STACK-worker \
  --builder-instance-profile STACK_BUILDER_PROFILE \
  --base-image-id ami-0123456789abcdef0 \
  --dry-run
```

`--dry-run` validates arguments and pinned recipe without making any AWS calls.
Remove it to perform the bake. `bake-worker-ami.sh` is an equivalent wrapper.
`--name`, `--instance-type` (x86_64 t3 sizes) and `--volume-gb` are optional.
The actual run checks STS identity, completed stack outputs, deployment-owned
network/key/profile, private subnet, controller-only SSH ingress, HTTP(S) egress,
and a builder role limited to `AmazonSSMManagedInstanceCore` before launching.
Base images must be official Canonical Ubuntu 24.04 amd64 images.

The baker gzip-compresses cloud-init user-data and checks the compressed bytes
against EC2's 16 KiB limit locally, including in `--dry-run`. It checks again
after inserting the deployment public key, before launching any VM. The private
temporary binary file is passed with `--user-data fileb://...`; AWS CLI performs
the single required base64 encoding and cloud-init decompresses on boot. Raw
user-data and credential material are never printed. See the
[transport decision and offline CLI proof](../../docs/adr/2026-09-19-worker-user-data-gzip.md).

The builder has no public IP. Installation/validation use SSM Run Command, not
SSH, and never receive an operator private key, Doppler/provider secrets or user
credentials. SSM needs private NAT egress (or appropriate VPC endpoints); the
stack's builder role is temporary and never attached to final workers.

AWS CLI failures expose only a fixed service/action and allowlisted error
category (for example `ec2/run-instances: InvalidParameterValue`), never raw
stderr, command arguments or user-data. Unknown failures remain redacted.
The launch uses the bake UUID as its EC2 client token. Cleanup success is
reported only after observing `terminated` for that exact ID, base image and
ownership tags; a successful termination request alone is insufficient.
If cleanup cannot be confirmed, inspect that exact builder before retrying.
An earlier bootstrap failure remains in the error together with this warning.

The image installs Node 22, **Codex 0.154.0**, **Claude Code 2.1.222**, Chrome with
its native sandbox, Python/venv, Docker Engine/Compose/Buildx. Docker starts only
when selected by the chat's environment. A failed bootstrap or finalizer does
not produce an AMI. The finalizer clears cloud-init/SSM registration and logs,
user credential locations, machine identity and SSH host private keys, and
performs a credential-filename scan without printing contents.

The build updates package indexes and installs explicit dependencies; it does
not perform a full OS upgrade inside cloud-init. A temporary needrestart policy
protects only bootstrap/SSM services during installation and is removed before
imaging. Normal worker security-update policy remains intact. Bootstrap failures
include a validated stage/boolean receipt (installed tools, ready marker,
cloud-init status and SSH ordering-cycle check), never raw private diagnostics.
Ubuntu 24.04 dependencies use their real `t64` package names. Cloud-init filters
the package catalogue before installation and rejects the old virtual aliases,
even when `apt-get -s install` successfully resolves them. This distinction was
reproduced on the deployed controller before correcting the failed bake.

Final workers use **IMDS disabled**, no IAM profile and no public IP. Therefore
the image retains only the deployment's selected **public** SSH key; it is tied
to `WorkerKeyName`. Rotate the private key by baking a new AMI with a new key.
Cloud-init is disabled in the final image; generic DHCP netplan avoids copying
the builder NIC identity. Boot generates unique SSH host keys and resets the
heartbeat. The controller pins SSH host identity per deployment/instance ID,
not recycled private IP, and ignores ambient SSH config/agent forwarding.

The builder is terminated on success/failure after checking its exact tags and
network/profile. A changed scope intentionally prevents automatic cleanup; the
log identifies the builder for operator review. Created AMIs/snapshots are
retained, including after later failures; remove obsolete ones explicitly only
after confirming no deployment uses them. There is no automatic AWS teardown.

## Controller worker settings

Set via the deployment secret/rollout path, not in a committed environment file:

```dotenv
AGENT_WORKER_BACKEND=ec2
AGENT_EC2_DEPLOYMENT=YOUR_STACK
AGENT_EC2_GATEWAY_ORIGIN=https://YOUR_RELAY_ORIGIN
AGENT_EC2_AMI_ID=ami-0123456789abcdef0
AGENT_EC2_SUBNET_ID=subnet-0123456789abcdef0
AGENT_EC2_SECURITY_GROUP_ID=sg-0123456789abcdef0
AGENT_EC2_KEY_NAME=YOUR_STACK-worker
AGENT_EC2_SSH_PRIVATE_KEY=/run/relay/worker-key
AGENT_EC2_SSH_USER=ubuntu
AWS_REGION=us-east-1
AWS_PROFILE=
```

Only the controller stores the SSH private key. `AGENT_EC2_USE_PUBLIC_IP=1` is
now rejected. An old AMI without deployment/key/version tags must be rebaked.
Every AMI also needs the verifier-issued `AgentRelayAcceptance=verified-v1`
and verification UUID tags. Image availability or bake tags alone cannot admit
new or existing workers, publish an environment, or start native acceptance.
Provider `host` authentication mode is also rejected for remote workers.

## Acceptance gate (not satisfied by local fixtures)

Before selecting a baked AMI for real chats, boot a fresh worker with IMDS
disabled/no role/no public IP. From the controller verify generic DHCP and
SSH work, `IMAGE_FINALIZED` exists, exact CLI versions, regenerated machine/host
identity, absence of builder/user credentials, stopped SSM, heartbeat/watchdog,
and stop/start persistence. Then exercise one authorized scoped provider turn
and selected environment MCP read. Do not infer success from AMI availability
or an SSM command being queued. Real OAuth consent remains per user/account.

Local checks:

```bash
taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 \
  test/ec2-backend.test.mjs test/worker-ami-baker.test.mjs \
  test/config-auth.test.mjs test/runtime-manager.test.mjs
```

### Fresh worker acceptance operator

The stack's existing application secret must already contain the deployment
SSH key, and the controller bootstrap/SSM agent must be ready; the application
itself need not be running. Full environment publication rejects an unaccepted
image, including preliminary configuration. Never bypass that guard to prepare
verification. Do not start real chats until the operator below succeeds:

For a new deployment the order is: provision infrastructure → initialize the
transport key → bake → verify/mark the image → publish the full Doppler-backed
environment → build/deploy. Initialize the key without any provider credentials:

```bash
node scripts/aws-secrets.mjs initialize-worker-key
```

This action accepts only an empty application secret (or the identical key-only
record as a no-op), verifies the stack/public-key ownership, and uses conditional
version promotion. It rejects an already configured deployment, including one
with a different saved transport key. It does not fetch Doppler, configure an
AMI or authorize worker startup. Existing deployments already holding their
verified transport key skip this bootstrap; it must not overwrite them.

```bash
node deploy/aws/verify-worker-ami.mjs \
  --profile code-web --region us-east-2 --expected-account 123456789012 \
  --deployment YOUR_STACK --image-id ami-0123456789abcdef0 --dry-run
```

Remove `--dry-run` for the explicit, billable acceptance run. It verifies STS,
exact stack resources, private network/controller identity, and encrypted,
deployment-tagged native-version AMI. It launches one uniquely tagged disposable
worker without IAM/public IP/IMDS and asks the controller, through SSM, to SSH
into that worker. The controller fetches **only its own application secret**
locally using its instance role. Its SSH key is decoded into root-only `0600`
files in a private `/dev/shm` directory, matched against the deployment's public
key, and removed on success or failure. No private key enters an SSM parameter,
operator output, source archive, worker image or worker filesystem.

The image contains a root-owned, fixed-path audit helper. Its narrowly scoped
sudo rule permits the chat agent to run only that no-argument, read-only audit.
It emits public identity hashes, booleans and bounded fixed-category failure
counts, never credential names, paths or contents. The
operator verifies the finalization marker, credential scrub, inactive/disabled
SSM, inaccessible metadata, new machine/SSH host identity, exact CLI versions,
boot heartbeat and watchdog. It writes a disposable sentinel, stops/starts the
VM, then verifies the sentinel and machine/host identities persisted. SSH host
pins are isolated from the product's known-hosts file and retained across both
probe phases. No model prompt is sent and no user account is imported.

Success is a structured `accepted: true, cleanedUp: true` receipt with checks,
instance/image IDs, SSM command IDs and public hashes. It is emitted only after
the two audits, confirmed termination of that exact disposable VM, observed
deletion of its encrypted disposable volumes, and verified acceptance-tag
publication to that exact owned/private image. An ownership change blocks
cleanup; inspect the logged instance ID
manually rather than weakening scope checks. Failed SSM output contains only
fixed stage descriptions; no private diagnostics are printed. The original
controller, stack secret and product data are not deleted or modified. Only
the tested AMI's two acceptance tags are changed after successful verification.
Deleting either tag or changing its version denies subsequent admission without
forcibly stopping already running chats; sleep/delete cleanup stays available.
The marker is trusted operator metadata, not cryptographic attestation. The
controller role cannot tag AMIs. Its narrower `RunInstances` IAM condition
requires a separate reviewed stack update before it is active. See the
[admission decision](../../docs/adr/2026-09-19-worker-image-acceptance-admission.md).

Probe failures include an allowlisted category and numeric exit code, when
available (SSH host-key/authentication/network, missing remote command, worker
audit, or invalid receipt). Raw stdout/stderr never becomes a diagnostic. A
failed cleanup retains the original probe error and marks cleanup unconfirmed.
EC2 may detach network interfaces while an instance is `shutting-down`; only
read-only termination observation tolerates that, with the exact instance,
image and all deployment/verification ownership tags still required. No stop,
start or terminate action uses that reduced terminal-state check.

Additional local fixture checks:

```bash
taskset -c 0,1 nice -n 10 node --test test/worker-ami-verification.test.mjs
taskset -c 0,1 nice -n 10 python3 -B test/worker-controller-verification.py
```

Implementation references: [SSM Run Command parameters](https://docs.aws.amazon.com/cli/latest/reference/ssm/send-command.html),
[EC2 launch options](https://docs.aws.amazon.com/cli/latest/reference/ec2/run-instances.html),
and [AWS CLI IAM role credentials](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-role.html).
