#!/usr/bin/env bash
# Bake the no-secrets Codex + Claude Code worker AMI used by AGENT_WORKER_BACKEND=ec2.
# This launches one temporary instance, snapshots it, and terminates that exact
# builder. It never receives provider/API credentials.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AWS_BIN="${AWS_BIN:-$(command -v aws)}"
AWS_PROFILE="${AWS_PROFILE:-default}"
AWS_REGION="${AWS_REGION:-us-east-1}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.medium}"
VOLUME_GB="${VOLUME_GB:-20}"
SSH_USER="${SSH_USER:-ubuntu}"
AMI_NAME="${AMI_NAME:-agent-web-worker-$(date -u +%Y%m%d-%H%M%S)}"
CLOUD_INIT="${CLOUD_INIT:-${SCRIPT_DIR}/worker-cloud-init.yaml}"

: "${SUBNET_ID:?Set SUBNET_ID to a subnet reachable from this machine}"
: "${SECURITY_GROUP_ID:?Set SECURITY_GROUP_ID; SSH ingress should be restricted to this machine/control plane}"
: "${KEY_NAME:?Set KEY_NAME to an existing EC2 key pair}"
: "${SSH_PRIVATE_KEY:?Set SSH_PRIVATE_KEY to the absolute private-key path}"

aws_cmd() {
  "${AWS_BIN}" --profile "${AWS_PROFILE}" --region "${AWS_REGION}" "$@"
}

BASE_AMI="${BASE_AMI:-$(aws_cmd ec2 describe-images \
  --owners 099720109477 \
  --filters 'Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*' 'Name=state,Values=available' \
  --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)}"

BUILDER_ID=""
cleanup() {
  if [[ -n "${BUILDER_ID}" ]]; then
    aws_cmd ec2 terminate-instances --instance-ids "${BUILDER_ID}" >/dev/null 2>&1 || true
    echo "Terminating temporary builder ${BUILDER_ID}."
  fi
}
trap cleanup EXIT INT TERM

BLOCK_DEVICE="[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":${VOLUME_GB},\"VolumeType\":\"gp3\",\"Encrypted\":true,\"DeleteOnTermination\":true}}]"
BUILDER_ID="$(aws_cmd ec2 run-instances \
  --image-id "${BASE_AMI}" \
  --instance-type "${INSTANCE_TYPE}" \
  --subnet-id "${SUBNET_ID}" \
  --security-group-ids "${SECURITY_GROUP_ID}" \
  --key-name "${KEY_NAME}" \
  --metadata-options 'HttpTokens=required,HttpEndpoint=enabled' \
  --block-device-mappings "${BLOCK_DEVICE}" \
  --user-data "file://${CLOUD_INIT}" \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=agent-web-ami-builder},{Key=ManagedBy,Value=agent-web-poc}]' \
  --query 'Instances[0].InstanceId' --output text)"

echo "Builder ${BUILDER_ID} launched from ${BASE_AMI}."
aws_cmd ec2 wait instance-running --instance-ids "${BUILDER_ID}"
if [[ "${USE_PUBLIC_IP:-0}" == "1" ]]; then
  BUILDER_HOST="$(aws_cmd ec2 describe-instances --instance-ids "${BUILDER_ID}" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
else
  BUILDER_HOST="$(aws_cmd ec2 describe-instances --instance-ids "${BUILDER_ID}" --query 'Reservations[0].Instances[0].PrivateIpAddress' --output text)"
fi

echo "Waiting for CLI installation on ${BUILDER_HOST}..."
deadline=$((SECONDS + 900))
until ssh -T -i "${SSH_PRIVATE_KEY}" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 \
  "${SSH_USER}@${BUILDER_HOST}" 'test -f /opt/agent-web/READY' 2>/dev/null; do
  (( SECONDS < deadline )) || { echo "Worker bootstrap did not finish within 15 minutes." >&2; exit 1; }
  sleep 10
done

ssh -T -i "${SSH_PRIVATE_KEY}" -o BatchMode=yes "${SSH_USER}@${BUILDER_HOST}" 'cat /opt/agent-web/versions.txt'
aws_cmd ec2 stop-instances --instance-ids "${BUILDER_ID}" >/dev/null
aws_cmd ec2 wait instance-stopped --instance-ids "${BUILDER_ID}"

AMI_ID="$(aws_cmd ec2 create-image \
  --instance-id "${BUILDER_ID}" \
  --name "${AMI_NAME}" \
  --description 'Agent Relay worker: Codex + Claude Code, no credentials' \
  --tag-specifications 'ResourceType=image,Tags=[{Key=Name,Value=agent-web-worker},{Key=ManagedBy,Value=agent-web-poc}]' \
  --query ImageId --output text)"
aws_cmd ec2 wait image-available --image-ids "${AMI_ID}"

echo "Worker AMI ready: ${AMI_ID}"
echo "Set AGENT_EC2_AMI_ID=${AMI_ID} on the control plane."
