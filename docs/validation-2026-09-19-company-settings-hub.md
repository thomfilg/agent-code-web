# Company Settings hub

The sidebar now has the signed-in user's round initial/avatar, name and Settings
button in one row, with Agent accounts on its own row. Settings opens company
tabs and an Add company form. Each tab has scoped GitHub, MCP, Environment and
Browser connection cards; existing editors retain their connection and consent
flows. The legacy Companies deep link remains available.

Unsaved company/GitHub changes require confirmation before dismissal. Unchanged
company Save is disabled. Failed loads disable stale actions until retry.
Keyboard tab navigation retains focus. Delayed MCP/environment navigation cannot
reopen an editor after closing Settings or selecting another destination.
Inherited company context is visible; redundant company filters are hidden in
scoped editors, while standalone editors retain their own selection controls.

## Verification

- Final dedicated hub browser run: **6/6 passed**, serial, no retries, including
  delayed navigation, company-scoped cards, stale GitHub drafts and retry states.
  Desktop and 390px screenshots were inspected: no horizontal overflow, Close
  visible, cards become one column, company tabs scroll horizontally.
- Earlier hub/company-scope/company-settings/GitHub/Google focused run: **18/18
  passed** before the additional environment-navigation regression.
- Updated conversation regression cases: **4/4 passed**. They use current Queue,
  inline tools, new-chat landing and `/interrupt` behavior, and assert no full
  worker-stop request. Old query-string fixture navigation was replaced with
  supported `#chat=` navigation.
- Dedicated local Linear consent/verification tests: **4/4 passed**; generic MCP
  tests: **4/4 passed**, both after test-controller network guards. The
  [configuration receipt](validation-2026-09-19-linear-browser-config.md)
  records the prior wrong-config external discovery/registration incident and
  prevention. These are synthetic accounts, not real-provider acceptance.
- The earlier 80-case general batch had 70 passes and 10 failures: four obsolete
  conversation assertions, four Linear cases using the wrong config, and two
  draft-navigation failures addressed by the separate new-chat command commit
  `ff3900a`. Final combined integration must rerun those draft assertions; this
  component does not claim the old 80-case batch was green.

No production deployment, worker restart, account migration or saved browser
profile mutation was performed for this UI change.
