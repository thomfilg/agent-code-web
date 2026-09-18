# Deployed GitHub gateway rejection gate

This is a negative-only HTTPS behavior check, not authenticated GitHub or
worker acceptance. Run it only after the release operator has independently
confirmed the immutable image/revision deployed to the fixed Relay origin.
Keep that deployment receipt alongside this probe's timestamped receipt.
The public endpoints do not attest the running revision; the probe explicitly
reports `deploymentIdentityVerified: false` and must never be used to claim
that an older deployed image contains newer source changes.

Preview the fixed checks without any network or credential/file access:

```bash
taskset -c 0,1 nice -n 10 node scripts/smoke-deployed-github.mjs
```

After the intended release is deployed:

```bash
taskset -c 0,1 nice -n 10 node scripts/smoke-deployed-github.mjs --run
```

The only destination is `https://d20atclccf8cku.cloudfront.net`. Thirteen fixed
requests cover Git smart-HTTP and PR MCP rejection of anonymous requests,
unissued synthetic capabilities, browser origins, unsupported paths, queries
and methods. Git uses read-only upload-pack discovery and `OPTIONS`; MCP sends
only `tools/list`, `GET` or `OPTIONS`, never `tools/call`. There are no Git pack
uploads, PR changes, account imports, browser starts, model turns or AWS calls.
No cookie, real capability, token, repository name, destination or revision can
be supplied on the command line. The optional `--run` is the sole flag.

Each check requires its exact status, fixed public rejection body, expected
content type and `no-store`, with no redirect or session cookie. A generic old
404/401 page is not accepted as proof of the new handlers. Responses are capped
at 2 KiB, requests at 10 seconds and the whole run at 45 seconds; cancellation
aborts the active request. Failures expose only fixed probe/category names and
an HTTP status, never response bodies or raw transport diagnostics.

The unsupported MCP method is rejected before successful capability admission;
this does **not** verify the authorized 405 path. No successful authenticated
Git/PR call, selected-user scope, EC2 worker access or provider write is claimed.
Those remain separate gates using an explicitly authorized account. The receipt
claims only negative route behavior at the fixed HTTPS origin and time.

Offline tests route all thirteen requests through the actual product handlers,
with provider/model entrypoints configured to fail if reached. They also check
default zero-network behavior, secret-safe failures, old-route rejection,
bounded bodies, cancellation and rejection of supplied URLs/credentials:

```bash
taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 test/deployed-github.test.mjs
```
