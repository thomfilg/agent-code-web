# Require operator acceptance before worker image admission

Status: implemented; live verifier, controller rollout and IAM stack update
must be recorded separately. Local fixtures do not establish AWS acceptance.

## Decision

A baked, available AMI is not accepted. `verify-worker-ami.mjs` may add
`AgentRelayAcceptance=verified-v1` and `AgentRelayAcceptanceId=<verification UUID>`
only after its independent fresh-boot audit, stop/start persistence audit,
confirmed termination of the exact disposable worker, and observed absence of
each tagged encrypted disposable volume. Immediately before tagging it rereads
the exact owned, private AMI and compares its immutable image/snapshot identity.
It then reads the exact marker back; a write/readback failure never returns an
accepted receipt. No credentials appear in these tags.

One shared validator requires private ownership, encrypted EBS, exact deployment
and SSH-key tags, pinned native versions, and both current marker fields.
Controller admission uses `DescribeImages --owners self`. It checks the actual
AMI of existing/running/stopped workers, not only the configured new-worker
AMI, before start and before returning the prepared executor for credential
delivery. Secret publication/update and native acceptance use the same gate.

The controller cannot create AMI tags. The infrastructure template additionally
requires `verified-v1` on the image for `RunInstances`; that narrower IAM rule
does not become live merely by editing the template. Start/admission is checked
in application code, not claimed to be atomically coupled to mutable AWS tags.

## Revocation and limits

An authorized operator can remove either acceptance tag or change the version
to revoke future admission. Every acquire rereads the marker; nothing silently
retags the AMI or chooses a different image. Existing active workers are not
automatically stopped. Exact-owned sleep/destroy remain available even after
revocation. Reacceptance requires rerunning the full verifier.

This is a trusted-operator decision marker, not cryptographic attestation or a
continuous monitor of running VMs. An AWS principal allowed to tag AMIs remains
trusted. IAM eventual consistency and revocation concurrent with admission are
not transactional guarantees. Concurrent verifiers may supersede each other's
marker ID; only a run that reads its own ID confirms success. An uncertain tag
write may have succeeded, so inspect the exact AMI instead of claiming either
acceptance or automatic rollback. Real provider consent, native model resume,
MCP and browser acceptance are separate gates, not certified by this marker.

The verifier requires the existing controller secret to contain its scoped SSH
key. `aws-secrets.mjs initialize-worker-key` closes the first-deployment cycle:
it validates the exact stack secret and the private/public transport-key pair,
then writes only `AGENT_WORKER_SSH_KEY_BASE64` to a previously empty secret.
An identical key-only record is a no-op; any existing environment, different
key, malformed data or uncertain version history is rejected. It never downloads
Doppler settings, supplies an AMI, publishes an environment or admits a worker.
Candidate staging and conditional AWSCURRENT promotion protect against a
concurrent full publication. Private data travels only through a mode-0600
tmpfs file, not argv/output. The operator inspects an ambiguous outcome instead
of overwriting it. Full environment publication never bypasses acceptance.

AWS documents both [AMI tag conditions for RunInstances](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ExamplePolicies_EC2.html)
and [conditional staging-label movement](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_UpdateSecretVersionStage.html).
