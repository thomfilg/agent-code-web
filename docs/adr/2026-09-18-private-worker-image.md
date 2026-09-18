# Private, deployment-scoped EC2 worker images

Status: accepted implementation decision; actual AWS boot/round-trip gate pending.

The MVP needs disposable, per-chat remote workers without giving untrusted
agents the controller's AWS role or provider credentials. A reusable host login,
public SSH builder, metadata-enabled final VM, or generic unscoped AMI does not
meet this boundary.

Decision:

- Controller AWS auth uses the default credential chain unless an operator
  explicitly supplies a profile. Each instance/image/volume belongs to one
  deployment; ambiguous, foreign, legacy or privileged workers fail closed.
- Bake from official Ubuntu 24.04 amd64 in the private worker subnet using SSM.
  The operator must state the expected AWS account. Before mutation, match STS,
  completed stack outputs, network/key tags and SSM-only builder IAM role.
- Pin Codex 0.154.0 and Claude Code 2.1.222. Do not copy agent/user credentials,
  SSH private keys or controller environment into the recipe/SSM commands.
- Disable IMDS and omit an instance profile on final workers. The AMI retains
  only its deployment's SSH public key, generic DHCP configuration and boot-time
  host-key/heartbeat generation. Disable cloud-init after clearing builder
  identity and disable/remove state for the SSM builder transport.
- Keep scoped SSH host-key history per instance, ignoring ambient client
  config. Transport always executes as the isolated chat agent, not the
  privileged transport account. Docker remains root-equivalent within this VM.
- Remove the outdated broad IAM starter policy; use the application's scoped
  CloudFormation policy instead. Local fixtures/dry-run do not establish live
  AWS acceptance: an IMDS-off fresh boot and authenticated provider/environment
  round trip must pass before claiming deployed readiness.

Trade-offs: key rotation requires a new deployment-specific AMI; private NAT
costs apply; CLI upgrades require rebaking and updating validation pins; legacy
instances are deliberately not adopted based on a chat tag alone. AMIs and
snapshots are retained for rollback and require explicit later cleanup.
