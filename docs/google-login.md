# Google login for Relay

Relay uses the framework-neutral `createApiAuth` server factory from
`@12-apps/auth` (`12-apps/shared-packages`), pinned in `package-lock.json`.
The package's Auth.js integration owns OAuth, PKCE, state, nonce, CSRF and
encrypted session cookies. Relay supplies identity ownership, allowed users,
revocation, the native Node HTTP adapter and its existing vanilla-JS UI.
No React, Next.js, Hono or copied authentication implementation is needed.

## Configure this application's Google client

1. Create a Google OAuth **Web application** client for Relay, or use a client
   you explicitly own and authorize for this application. Do not copy a client
   secret from an unrelated company's project.
2. Register the exact redirect URI
   `http://localhost:8787/api/auth/callback/google`, with JavaScript origin
   `http://localhost:8787`. Do not alternate between `localhost` and
   `127.0.0.1`; use the same hostname in Google and `AGENT_WEB_PUBLIC_URL`.
   Production requires an HTTPS origin and its corresponding callback URI.
3. Put `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `AGENT_OWNER_EMAIL` in
   **Doppler project `code-web`, config `dev`**. Set `AGENT_WEB_PUBLIC_URL` to
   `http://localhost:8787` (also the local launcher's default). Never submit a
   secret in a conversation. Add other trusted Google emails to
   `AGENT_ALLOWED_EMAILS` only when they should be allowed to use the server.
4. Install with `npm ci`. It compiles the package's TypeScript server entry for
   this plain Node ESM application. If installation scripts were disabled, run
   `npm run build:auth` explicitly. No dependency scripts are needed for that
   build.
5. Preserve the existing database/data directory configuration, stop the old
   Relay process only after checking its active work, and run
   `npm run start:google`. This command does not authorize Google, start a model
   turn or reset the saved database. Do not start a second process on port 8787
   or against the same embedded PostgreSQL directory.
6. Open the configured origin and select **Continue with Google**. If the
   Google consent app is in testing, add the intended accounts as test users in
   Google as well as Relay's allowlist. A verified but unlisted email is denied.

With `AGENT_GOOGLE_AUTH=1`, missing configuration shows setup instructions and
keeps data APIs locked; it never falls back to unauthenticated access, the old
bearer login or password accounts. An existing launch is not modified simply
by installing or compiling these changes.

Google's primary setup reference:
[OpenID Connect setup and redirect URIs](https://developers.google.com/identity/openid-connect/openid-connect#settingup).

## Doppler development setup

Following `future-pay`'s launcher pattern, Relay injects secrets with
`doppler run`. `@12-apps/auth` consumes the host's settings; the shared package
does not manage Doppler. `doppler.yaml` maps this repository to `code-web/dev`.

```bash
# From the repository root, authenticate once if needed; scope the CLI login here.
doppler login --scope "$PWD"
doppler setup --no-interactive
npm run doppler:check
npm run start:google
# Or watch source files during development:
npm run dev
```

The launcher accepts an existing `DOPPLER_TOKEN` or reads a private, read-only
dev service token from `../.doppler-code-web-dev-token`. Override that location
with `DOPPLER_DEV_TOKEN_FILE`. Restrict a token file to mode 600. The filename
is deliberately project-specific: it never borrows `future-pay`'s token or a
generic sibling `.doppler-dev-token`. Without a token file, it uses the CLI
login scoped to this repository. A selected but missing/unreadable token file
is an error, not permission to fall back to a broader account.

For unattended use, prefer a read-only service token restricted to
`code-web/dev`, created in Doppler's **Access** tab. The launcher explicitly
passes the project/config and checks the injected metadata before running the
server; ambient settings for another application or production cannot select
its secrets. It disables Doppler fallback files, so it neither writes local
secret snapshots nor starts with a stale cache when Doppler is unavailable.
The service token itself is removed from the server environment after loading.

`npm run doppler:check` prints only configuration presence, the public callback
and missing variable names. It does not print secret values/email addresses,
open the database, start a worker or authorize Google. Missing credentials or
an owner email prevent the Google launcher from starting. Existing
`AGENT_CONTROL_DIR`, `AGENT_DATA_DIR` and other runtime settings must remain
consistent with the saved-data installation.

`npm start` still accepts an already configured process environment.
`npm run dev:local` is the explicit no-Doppler mock development alternative.
If Doppler is not desired, `.env.google.example` documents the optional manual
configuration: copy it to an ignored `.env.google`, restrict it with
`chmod 600 .env.google`, fill it privately and run `npm run start:google:env`.
Do not run more than one server against the same embedded database directory.

References: [Doppler CLI setup/run](https://docs.doppler.com/docs/cli),
[config-scoped service tokens](https://docs.doppler.com/docs/service-tokens).

## What is stored, and where

- The Google session is an encrypted, HttpOnly, SameSite=Lax cookie. HTTPS adds
  Secure and `__Host-`. Relay-specific cookie names avoid colliding with another
  Auth.js application on localhost. Tokens are not stored in localStorage.
- Relay's stable user ID is bound to Google's immutable `sub`, not the email
  address, name or a pre-existing password account. User metadata and the
  revocable session registry are saved through the existing encrypted
  PostgreSQL record store. A session survives restart and expires after 30 days.
- If `AUTH_SECRET` is not explicitly supplied (at least 32 characters), Relay
  creates a random session-encryption secret and saves it in encrypted
  PostgreSQL. Keep the database's existing encryption key/control credentials
  safe; backing up ciphertext without its key is not sufficient for recovery.
- The Google OAuth client secret comes from Doppler into the server environment
  (or the optional ignored `.env.google`), not the browser or an agent.
  Google access/refresh/ID tokens are
  not saved as reusable agent credentials. Only basic identity scopes are used.

## Existing data and user isolation

The first successful sign-in of the configured, verified `AGENT_OWNER_EMAIL`
binds legacy shared data to that immutable Google identity. An invited user
logging in first sees none of it. Existing conversation content and workspace
paths are not rewritten or deleted. Changing an email later does not transfer
old conversations to a different Google subject.

New chats take their owner from the server-verified session, never from a
request-body `ownerId`. GitHub connections, MCP connections, environments,
custom groups and preferences have separate record namespaces per user.
Runtime environment/MCP selection and background PR requests use that same
owner namespace; missing resources do not fall back to the server owner's.
The server's `gh` login, local workspace sources and shared Codex/Claude
credentials are not offered to invited users.

The legacy username/password Chrome accounts remain stored, but Google mode
does not automatically link them by username/email or permit that login to
bypass Google. Migrating those private accounts requires a separate explicit
ownership-proof flow; nothing is silently reassigned.

Signing out revokes the server-side session and personal-Chrome sharing, closes
its live viewers, and refreshes other open tabs. It does not delete messages or
stop an already-running agent. Personal Chrome still requires explicit pairing
and the per-chat sharing toggle.

This remains a trusted-user control-plane POC, not an untrusted multi-tenant
execution sandbox. Local workers run under the host OS account. Google login
and record ownership do not create filesystem/network isolation between OS
processes. Do not open registration to arbitrary users.

## Separate provider-account feature

Google authenticates the **Relay user**, not Claude or Codex. Multiple named
Claude/Codex accounts, browser authorization URLs, private native profiles,
encrypted token synchronization and explicit per-chat account selection are a
separate pending implementation. This Google change must not be presented as
having delivered or verified those provider-login flows. No personal CLI login
has been adopted or authorized automatically.

## Verification

On 2026-09-17 the selected API/runtime/auth/launcher regression suite passed
**86/86**, the dedicated Google browser suite **4/4**, and the legacy
document/PR/private-Chrome browser subset **8/8**. Tests ran sequentially with
one worker on two logical CPUs (nice 10). The auth build, changed JavaScript
syntax and diff checks also passed. These are scoped regression results, not
a claim that the entire feature queue or real Google consent is complete.

`node --test --test-concurrency=1 test/doppler.test.mjs` covers project/config
pinning, scoped token selection and file permissions, missing configuration,
value-redacted diagnostics, data-path preservation, actual check-process exit
codes and exclusion of Google/Doppler credentials from worker environments.

`node --test --test-concurrency=1 test/google-auth.test.mjs` covers the real
shared-package OAuth callback with a signed, offline OIDC fixture; persistence,
logout/replay/expiry, denied accounts, CSRF/state/nonce/redirect checks, cookie
security, legacy ownership, two users and runtime credential scoping.

`npm run test:google:browser -- --workers=1` drives the real UI and callback,
including reload, account switching, Google denial and the 320px setup screen.
It uses an isolated in-memory Relay and does not contact Google, authorize a
real account, start native CLI workers or send prompts. Actual Google consent
remains a user-only acceptance step after client configuration.
