# Browser connections belong to one company

## Decision

A signed-in Chrome connection belongs to one registered Relay company and one
Relay account. Company identity comes from the explicit `companyId`, not a
connection name, Chrome profile name, GitHub owner, environment, or last chat.
Only agent accounts remain usable across companies.

Pairing requires a company in the owner's registry. A scoped listing filters on
the server; an unfiltered listing remains owner-only for the settings overview.
The optional `includeLegacy=1` includes only that owner's unassigned records for
the explicit assignment screen, never other companies' connections.

Existing records without `companyId` are ambiguous. They remain stored, can
reconnect their extension, and retain the same ID, pairing token hash, extension
binding and saved profile. They cannot grant agent access until the user explicitly
assigns one company. Listing or opening settings does not migrate them. Assignment
is blocked while sharing and cannot move an already assigned connection to another
company. Moving requires explicit removal/re-pairing, which does not delete the
Chrome profile or its website logins.

Consent checks both connection owner and current chat owner/company. Grants retain
their company binding. Authorization completion, commands and their results,
viewer attachment, pushed browser events, and cached personal state recheck that
binding. A changed/archived chat revokes its grant before data is returned.

## UI

`BrowserConnectionSettings.open(companyId)` uses a locked, visible company label;
standalone settings retain a company dropdown. Unassigned profiles have a separate
collapsed assignment section. Assignment requires confirmation and does not enable
sharing. Switching companies clears pairing codes immediately and ignores late
responses from the previous selection.

## Safety and limitations

No live migration, credential access, profile filesystem change, provider call,
worker action or deployment is part of this change. Local mode retains its existing
shared company registry; private browser records and grants still require their
own exact owner. Google Relay mode uses its existing owner-specific registry.
The server enforces admission; client filtering is only additional UX protection.
