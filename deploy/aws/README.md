# EC2 worker mode

This mode converts a logical chat runtime into one actual EC2 instance. The web
control plane remains available, but an active chat starts/resumes its tagged
instance. Five minutes after a turn completes, the instance is stopped. Its
encrypted EBS root volume retains the workspace and CLI session; the next
message starts it again. Deleting the chat terminates the instance and its root
volume.

No provider key is copied to EC2. The worker gets one random chat capability and
calls the control plane's HTTPS credential-gateway route. The gateway swaps that
capability for `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` while forwarding only the
model request paths.

SSH is transport only: the AMI forces commands received through the `ubuntu`
login to execute as a dedicated, non-sudo `agent` account and disables SSH
forwarding and TTYs. A root-owned watchdog also powers off an abandoned worker
after roughly seven minutes without a heartbeat. The normal control-plane timer
still issues `StopInstances` at five minutes; the watchdog covers a crashed or
disconnected control plane.

## 1. Network boundaries

- Put the control plane behind TLS (ALB, Caddy, nginx, or Cloudflare Tunnel).
- Set `AGENT_EC2_GATEWAY_ORIGIN` to that HTTPS origin.
- Give the worker security group SSH ingress only from the control-plane
  security group/private address. Do not open port 22 to the world.
- Restrict worker egress to the credential gateway and explicitly required
  package/repository destinations. The POC cannot enforce another security
  group's egress policy for you.
- Prefer an IAM role on the control-plane host over static AWS credentials. A
  starter policy is in `control-plane-policy.json`; scope its RunInstances
  resources to your AMI, subnet, security group, key, and volumes before
  production use.

## 2. Bake a credential-free worker AMI

The bake script creates billable AWS resources and therefore is never run
automatically:

```bash
cd deploy/aws
export AWS_PROFILE=qc-arm
export AWS_REGION=us-east-1
export SUBNET_ID=subnet-...
export SECURITY_GROUP_ID=sg-...
export KEY_NAME=agent-web-worker
export SSH_PRIVATE_KEY=/absolute/path/to/id_ed25519
export USE_PUBLIC_IP=1 # only when baking outside the VPC
./bake-worker-ami.sh
```

It installs Node.js, Codex, and Claude Code, verifies their versions, stops the
builder before snapshotting, creates the AMI, and terminates the builder. It
never receives model credentials.

The current image also includes Python 3/venv and Docker Engine, Compose and
Buildx. Docker starts only when enabled by a chat's environment preflight.
Rebuild existing AMIs to use this capability. The enable helper is limited to
the dedicated worker; never install it on the control plane. Docker grants
root-equivalent access within this one-chat VM, so do not attach a sensitive
IAM role or store master secrets there. The control-plane stop timer still
stops the complete VM, including its containers. An agent with Docker access
can bypass the guest watchdog; it cannot bypass AWS StopInstances.

## 3. Start the control plane

```bash
export AGENT_WEB_HOST=0.0.0.0
export AGENT_WEB_AUTH_TOKEN='a-long-random-browser-token'
export AGENT_COOKIE_SECURE=1
export AGENT_IDLE_TIMEOUT_MS=300000

export AGENT_WORKER_BACKEND=ec2
export AGENT_EC2_GATEWAY_ORIGIN=https://agents.example.com
export AGENT_EC2_AMI_ID=ami-...
export AGENT_EC2_SUBNET_ID=subnet-...
export AGENT_EC2_SECURITY_GROUP_ID=sg-...
export AGENT_EC2_KEY_NAME=agent-web-worker
export AGENT_EC2_SSH_PRIVATE_KEY=/absolute/path/to/id_ed25519
export AGENT_EC2_SSH_USER=ubuntu
export AWS_PROFILE=qc-arm
export AWS_REGION=us-east-1

# Kept only in this process/secret manager, never copied to a worker:
export OPENAI_API_KEY='...'
export ANTHROPIC_API_KEY='...'

npm start
```

The default uses an EC2 private IP. Set `AGENT_EC2_USE_PUBLIC_IP=1` only when the
control plane cannot reach the worker subnet. The selected subnet must assign a
public IP for that mode.

The first message after autosleep includes EC2 start + SSH readiness latency.
Chat creation itself does not spend compute: an instance is allocated only when
the first message is sent.
