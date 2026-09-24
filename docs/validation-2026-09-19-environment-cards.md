# Company-filtered environment editor

Scope: local synthetic-account UI acceptance; no real credentials, models, workers,
or cloud changes. This does not claim deployed acceptance.

The environment dialog now has stacked company/environment selectors and three
summary cards: Software, Environment variables, and Setup script. Editors share a
single draft, so returning to the cards does not discard edits. Save remains fixed
outside the scrolling editor and is disabled until the draft actually changes.
Successful saves close the dialog; failed saves retain the error and draft.

Company selection filters environments; it does not rewrite access. Legacy
multi-company and unassigned-chat bindings remain unchanged unless the user
explicitly edits Advanced access settings. New environments default only to the
selected company. Existing protected values are never loaded for summaries or
replaced by empty values when another setting is saved.

Validation:

- `node --test --test-concurrency=1 test/workspace-settings.test.mjs`: 9 passed.
- `playwright test test/browser/environment-selection.spec.mjs --workers=1`: 7 passed.
  company isolation, editor navigation, rejected navigation with dirty state,
  clean/reverted Save state, preserved legacy scopes and redacted values,
  error retention, successful close, narrow layout, and new-company-only scope.
- Inspected desktop and 390px overview cards, plus 390px/320px long variable editors;
  Save remains in view and the modal has no horizontal overflow. The variables
  table retains its own horizontal scrolling on narrow screens.

Tests use CPU 0–1, nice 10, and one browser worker. Browser startup needs the
repository's normal `node scripts/build-auth.mjs` generated fixture artifact.
