# Gzip transport for private-worker cloud-init user-data

Status: implemented and tested offline; fresh AWS bake remains required.

The hardened worker recipe reached 20,447 UTF-8 bytes. EC2 permits at most
16,384 raw user-data bytes before base64 transport encoding, so the previous
plain-text `file://` submission could not carry this recipe. This is a concrete
local size violation, not a claim that an AWS error body was inspected.

Decision:

- Compress the full recipe with deterministic gzip level 9. Cloud-init
  recognizes gzip and decompresses it before interpreting `#cloud-config`.
- Reject compressed payloads larger than 16,384 bytes before AWS access,
  including dry-run, and repeat the check after interpolation of the actual
  deployment SSH public key before `RunInstances`. Do not compare the larger
  base64 wire string against the raw-byte limit.
- Write the gzip buffer to a mode-0600 file in the private temporary bake
  directory. Pass `--user-data fileb://...`, not `file://` and not manually
  base64-encoded data. The EC2 CLI handles the single base64 layer. Delete the
  private temporary directory on success and failure as before.
- Preserve all account, role, subnet, deployment, image and cleanup guards.
  No S3 bootstrap download, new IAM permission or secret transport is added.

The current recipe compresses to 6,436 bytes before public-key interpolation.
Regression tests cover the actual recipe, deterministic gzip and exact content
round-trip, early oversized rejection, interpolation-only overflow, private
file mode and the existing bake lifecycle. A separate test invokes the locally
installed AWS CLI against an HTTP server bound only to 127.0.0.1, using
`--no-sign-request`, disabled IMDS and empty AWS config/credentials paths. Both
`base64` and `raw-in-base64-out` CLI settings produce exactly one base64 layer
around the gzip bytes. No AWS call or account credential is used by this test;
it skips explicitly if AWS CLI is absent. These tests do not replace a new AWS
bake and fresh IMDS-disabled worker acceptance.

References: [EC2 user-data raw size limit](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/user-data.html),
[AWS CLI binary file parameters, including EC2 user-data](https://docs.aws.amazon.com/cli/latest/userguide/cli-usage-parameters-file.html),
[cloud-init gzip format](https://docs.cloud-init.io/en/latest/explanation/format/gzip.html).
