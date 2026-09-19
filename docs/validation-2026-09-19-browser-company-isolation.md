# Browser company isolation: local acceptance

Changes stay within browser settings, browser connections, their server routes,
and the shared-browser cached-state check. No company migration, real browser
profile, live credential, model prompt, cloud resource or deployment was touched.

API/WS coverage includes owner-only and company-filtered listings, unknown company
and multi-company admission rejection, immutable company assignment, legacy
profiles preserved until explicit assignment, no registry fallback, and company,
owner or archive changes during authorization. Active grants recheck command
results, pushed frames and cached personal state independently.

UI coverage uses synthetic accounts and the actual component/markup. It checks
the locked company label, foreign-company exclusion, a separate unassigned-profile
section, explicit confirmed assignment, and suppression of pairing codes delivered
after switching companies. Desktop and 390px screenshots were manually inspected.

Validation (CPU 0–1, nice 10, serial):

- `node --test --test-concurrency=1 test/browser-connections.test.mjs`: 12 passed.
- `playwright test test/browser/browser-connections.spec.mjs --workers=1`: 5 passed.
- `node --test --test-concurrency=1 test/personal-chrome.test.mjs`: 1 passed
  (31.6s). This existing fixture uses its own disposable Chrome profile and local
  test website. It verifies consent, revocation, login/profile continuity after
  Chrome and Relay restart, and no automatic grant restoration.

The first UI run exposed an outdated layout fixture (an Acme profile with a
different default company). Its synthetic registry was made explicit; product
company filtering was not weakened. These results are local acceptance, not
evidence of deployed production acceptance.
