# Final worker IMDS denial and builder-only SSM removal

Status: implemented; another fresh AWS image acceptance is required.

The first fresh-worker audit failed `credentialsAbsent` and
`metadataReachable`, while the operator independently confirmed an EC2-disabled
metadata endpoint and no instance role. The old guest probe treated every HTTP
error as access. AWS documents HTTP 403 as either a denied request or disabled
IMDS, so that interpretation was incorrect. The credential scan's precise
failure category is **not yet established**; removing unnecessary SSM is a
boundary improvement, not proof of its cause.

Decision:

- Probe the exact IMDSv2 token endpoint using PUT and a one-second requested
  token TTL. Do not read, retain, print or use any returned token. Disable proxy
  inheritance and redirects. HTTP 200 means accessible and fails; 403 means
  denied access, not independent proof of disabled configuration. HTTP 401,
  other/unexpected HTTP statuses and unknown network failures fail closed.
  Only explicit timeout/unreachable/refused errors count as unavailable.
- Keep the operator's separate strict EC2 `HttpEndpoint=disabled` and no-role
  checks. Neither a guest 403 nor network failure replaces these AWS guards.
- After the builder's scheduled SSM command has finished and the finalizer has
  stopped its services, remove only `amazon-ssm-agent`: snap `remove --purge`
  and, if present, the exact Debian package with `dpkg --purge`. Bound each
  removal and fail before `IMAGE_FINALIZED` on error or residual executable.
  Do not remove unrelated packages or snapshots. `--purge` prevents snap from
  automatically archiving registration state. Existing SSM snapshots reject
  the image rather than being silently ignored. Mask both known SSM units and
  scrub only the fixed SSM state paths, including revision-specific snap data.
- Preserve the strict credential filename scan. Add bounded integer counts
  from a fixed category list; unknown files in SSM state still fail, as do
  scan errors, residual package files and SSM snapshots. The worker, controller
  and operator independently allowlist counts, boolean audit checks and a
  fixed metadata-result enum. No path, filename, credential or HTTP response
  body appears in a failure receipt.

Offline regressions exercise the real embedded helper's HTTP/network cases,
forbid token-body reads, verify category redaction and shell syntax/removal
ordering, and retain the existing operator isolation/cleanup tests. They do
not establish successful snap removal on the next real builder, fresh boot,
stop/start persistence or a passed AWS image gate.

References: [AWS IMDS requests and response codes](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instancedata-data-retrieval.html),
[Ubuntu SSM snap installation and data locations](https://docs.aws.amazon.com/systems-manager/latest/userguide/agent-install-ubuntu-64-snap.html),
[snap snapshots and purge semantics](https://snapcraft.io/docs/how-to-guides/manage-snaps/create-data-snapshots/).
