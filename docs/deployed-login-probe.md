# Public deployed login probe

This operator checks the fixed MVP origin
`https://d20atclccf8cku.cloudfront.net` through the installed, pinned official
Playwright MCP. It is not a login, account-consent or running-image identity test.
There is no arbitrary origin, cookie, token, browser profile or revision flag.

Default is zero browser/network/file activity:

```sh
taskset -c 0,1 nice -n 10 node scripts/smoke-deployed-login.mjs
```

After coordinating the single browser slot, explicitly test anonymous entry:

```sh
taskset -c 0,1 nice -n 10 node scripts/smoke-deployed-login.mjs --run
```

This creates one isolated headless browser with a task-private HOME and checks
1600×1000, 390×844 and 320×740 viewports. Every viewport requires a visible,
enabled Google button, no horizontal document overflow and an anonymous
`/api/chats` response of 401. Absolute screenshot paths stay inside a fresh
0700 directory under ignored `test-results/deployed-login-*`; PNGs become 0600.
Only these pre-provider entry screenshots are retained. MCP logs/transient
output and the private HOME are removed after transport cleanup. Existing user
profiles, saved accounts and production application data are never read.

Optional provider initiation requires both flags:

```sh
taskset -c 0,1 nice -n 10 node scripts/smoke-deployed-login.mjs --run --check-google-redirect
```

It clicks the existing Google button once, waits at most 30 seconds for the
provider navigation, and returns only an allowlisted hostname and booleans for
`redirectUriMismatch`, `googleError400`, `visibleEmailField`, and
`providerReached`. It never fills an email/password, selects an account or
submits consent. There is no provider screenshot. A visible email field is not
authentication; even a successful provider landing always has
`loginVerified: false`. A mismatch is an observed external configuration blocker,
not a passing login. Exit zero means the entry checks and bounded observation
completed, not that Google login works. Inspect those booleans explicitly.

The expected Google OAuth callback for this fixed origin is:

```text
https://d20atclccf8cku.cloudfront.net/api/auth/callback/google
```

The operator suppresses all raw tool errors, snapshots, console output, OAuth
URLs/states, page text and cookies. Error receipts contain only fixed
phase/category and cleanup flags. Calls and the overall run are bounded;
`finally` independently attempts browser, client and transport closure.
Transport closure requires the actual MCP child-close event, not merely a
resolved SDK `close()` call. Each cleanup phase has a six-second deadline.
Unconfirmed cleanup cannot become a successful receipt, and cleanup failures do
not overwrite the primary failure; private transient files remain intact when
transport death is unconfirmed. A process externally killed with SIGKILL
cannot run its cleanup: retained private artifacts then require exact-path
operator cleanup, never broad profile removal.

Pair the behavior receipt and screenshots with the **separate immutable AWS
deployment receipt** (verified ECR digest and application revision). This script
does not infer deployment identity from public UI behavior or caller input.
It cannot close authenticated SSE, provider consent, selected-account native
turn/resume, or GitHub/Linear integration acceptance gates.

## Legacy entrypoint

`scripts/smoke-deployed-browser.mjs` is now a thin compatibility wrapper, not a
second browser implementation. Its existing no-argument or exact AWS-origin
positional invocation still performs a live anonymous readiness/entry check;
it delegates all browser work and confirmed cleanup to this operator, without
clicking Google. New callers should use the explicit `--run` command above.
The legacy localhost positional argument now fails with a fixed migration
message before network/browser/file activity: it is never silently redirected
to AWS and does not widen this operator's fixed-origin policy. Local acceptance
uses the repository's isolated browser fixtures instead. Unknown/additional
arguments also fail without echoing their contents.

The wrapper preserves the canonical receipt and adds only its compatibility
marker and readiness result. Screenshot locations use the canonical private
per-run directory rather than the old fixed `aws-mcp` directory. Its offline
coverage is `test/deployed-browser-compat.test.mjs`; no extra live browser run
is required to exercise the delegation itself.

## Recorded deployed observation

On 2026-09-18 at 10:10 UTC, the reviewed operator ran against the separately
verified `3a0b7b3` release. All three viewport checks passed and the Google
button reached `accounts.google.com`. Google returned `redirect_uri_mismatch`
and Error 400; no email entry was displayed, no credentials were entered and
no consent was submitted. Browser/client closure and the actual MCP child-close
event were observed; private transient directories were removed. The three
pre-provider PNGs remain in the task-private ignored screenshot directory.
This repeats the callback configuration blocker, not a successful login.

Offline deterministic coverage:

```sh
taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 test/deployed-login.test.mjs
```

Fixtures execute the complete generated code in a VM matching MCP's absence of
a global `URL`, parse the real `### Result` response shape, and cover both tool
names, all viewports, mismatch/email observations, rejected private responses,
timeouts, cancellation, screenshot permissions and independent cleanup. They
perform no provider request or browser launch; real deployment proof must come
from a separately reviewed explicit run.
