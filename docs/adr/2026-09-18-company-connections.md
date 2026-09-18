# Registered companies and company-owned connections

Status: accepted product direction, 2026-09-18. Rollout/acceptance tracked separately.

Companies have their own page, durable per-Relay-user records, a display name,
and an immutable identifier matching the GitHub owner of a primary repository.
Changing the display name never moves a chat or credential to another company.
Secondary repositories do not change the chat's company.

A company has many MCP connections and at most one saved native GitHub
connection, including pending/disconnected connections. Each connection belongs
to exactly one registered company. GitHub's provider permissions still decide
which repositories its credential can access; secondary repositories use the
primary company's credential, never borrow a different company's credential.
The MCP catalog's GitHub card opens the existing native GitHub connection, not
a second token-entry workflow. Agents' own Codex/Claude accounts remain usable
across projects, as specified in the separate account-choice decision.

Opening MCPs shows a company dropdown and provider cards with connection status.
Selecting a card opens only that connection's detail view. Multiple connections
for a provider remain individually selectable. Technical transport, endpoint,
headers and OAuth registration settings are under Advanced settings. Company
registration is not repeated inside each connection form.

Company assignment replaces the extra environment-MCP checklist. A permitted
chat environment loads that primary company's authenticated/anonymous explicitly
configured connections when its agent starts. Unauthenticated OAuth entries are
not injected. Environment access, per-user ownership, revocation, encrypted
upstream secrets and per-chat gateway capabilities remain independent gates.
Environment templates are settings, not account connections; their existing
company access policy remains enforced. This does not silently grant private
Chrome access or change its explicit per-chat consent.

Existing single-company MCP bindings can be recognized without duplicating
credentials. Multi-company, blank or mixed company/unassigned MCP bindings need
an explicit company selection before any worker grant. Existing GitHub bindings
without a company also need explicit assignment: old ignored allowlists cannot
be reused as current intent. Tokens are kept encrypted, not copied or exposed;
assignment does not require a new provider login when endpoint/scopes are
unchanged. Discovery seeds company names from legacy settings only; it never
chooses a credential's company. Ambiguous bindings remain visibly pending review.

This fixes the observed configuration gap: the AWS Linear connection had OAuth
credentials, but the `12-apps` environment's selected MCP list was empty, so the
chat's agent received no Linear tools. No real model prompt or provider consent
was submitted during diagnosis. Existing running native sessions do not hot-reload
tool configuration: changes apply on the next agent start. Hibernation and
worker-preserving automatic deployment remain separate, unfinished work.
