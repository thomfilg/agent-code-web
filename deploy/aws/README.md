# Private EC2 workers

For the separately scoped, disabled-by-default GitHub application rollout,
see the [CI identity and activation runbook](CI.md). It does not provision workers
or modify this application's infrastructure stack.

One chat owns one VM and encrypted EBS root volume. The controller starts or
resumes it on demand, stops it after idle, and terminates it when its runtime is
deleted. Master provider/MCP credentials stay on the controller; the worker
receives revocable, scoped gateway capabilities. Do not use a shared VM for
untrusted users. Docker access is root-equivalent inside this one-chat VM.

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

The builder has no public IP. Installation/validation use SSM Run Command, not
SSH, and never receive an operator private key, Doppler/provider secrets or user
credentials. SSM needs private NAT egress (or appropriate VPC endpoints); the
stack's builder role is temporary and never attached to final workers.

The image installs Node 22, **Codex 0.154.0**, **Claude Code 2.1.222**, Chrome with
its native sandbox, Python/venv, Docker Engine/Compose/Buildx. Docker starts only
when selected by the chat's environment. A failed bootstrap or finalizer does
not produce an AMI. The finalizer clears cloud-init/SSM registration and logs,
user credential locations, machine identity and SSH host private keys, and
performs a credential-filename scan without printing contents.

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

Implementation references: [SSM Run Command parameters](https://docs.aws.amazon.com/cli/latest/reference/ssm/send-command.html),
[EC2 launch options](https://docs.aws.amazon.com/cli/latest/reference/ec2/run-instances.html),
and [AWS CLI IAM role credentials](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-role.html).
