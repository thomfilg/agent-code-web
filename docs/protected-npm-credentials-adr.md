# ADR: delegated access to protected npm credentials

## Status

Accepted.

## Context

Environment variables marked **Protected** are encrypted at rest and deliberately omitted from worker and setup-script environments. Making `NODE_AUTH_TOKEN` agent-readable would let arbitrary shell commands, dependency scripts, logs, and model output recover the long-lived registry credential.

Private npm reads still need authentication. npm also embeds absolute tarball URLs in package metadata, so forwarding metadata alone is insufficient.

## Decision

When an environment contains an enabled protected `NODE_AUTH_TOKEN`, Relay creates a separate per-chat npm capability and configures npm, pnpm, and Yarn-compatible npm settings to use `/gateway/npm/`.

The worker receives only:

- a revocable `cap_…` value in `NODE_AUTH_TOKEN`;
- a generated `.npmrc` containing the literal `${NODE_AUTH_TOKEN}` reference;
- the fixed Relay registry URL.

The controller retains the real token and exchanges the capability only inside the npm gateway. The gateway:

- accepts `GET` and `HEAD` only;
- always targets the controller-configured registry origin;
- rejects browser-originated, duplicate-auth, forged, expired, and revoked requests;
- strips worker authorization before adding the real registry bearer;
- rewrites same-registry tarball URLs back through the gateway;
- revokes authority when the chat stops, fails, changes environment, or loses its lifecycle lease;
- fingerprints the credential and environment revision before restoring a hibernated native process.

The npm capability is intentionally independent from model, GitHub, browser, and MCP brokers, so granting package reads cannot replace or widen another authority.

## Consequences

Agents can run ordinary read/install commands for private packages without receiving the long-lived npm token. They may observe the short-lived Relay capability, but it cannot publish packages, select another registry, or survive revocation. Publishing remains outside this mechanism and requires a separate explicit workflow.

