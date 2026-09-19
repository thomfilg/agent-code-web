# Linear browser acceptance: isolated configuration

## Cause of the four failures

The general browser batch ran `linear-mcp.spec.mjs` with `playwright.config.mjs`.
That starts the generic controller on port 8879, not the dedicated controller on
8894 and synthetic Linear OAuth/MCP service on 8895. All four failures included
a refused connection to the absent local consent service.

This was more than a selector mismatch: the generic controller has no synthetic
Linear fetch redirect. Its OAuth setup therefore used the real provider's
discovery/registration endpoints before the browser intercepted the authorization
navigation and attempted to load the missing local consent service. The log
shows authorization URLs containing client identifiers; combined with the code
path and lack of a preconfigured client in this test, this supports completed
discovery and successful dynamic client registration. The registration response
and provider-side retained registration state were not independently inspected.
The log does not show user approval, an authorization code, a token exchange, or
access to a real workspace. No real consent was retried and no speculative
provider cleanup was attempted. No client identifiers, tokens, or parameterized
authorization URLs are reproduced here.

## Prevention

- The general browser config excludes this dedicated-provider spec.
- A spec-level `beforeAll` requires the dedicated base URL before opening any
  page or making a setup mutation, protecting against accidental alternate
  configs that include the spec.
- Both test controllers also enforce their own MCP network boundary, independent
  of spec selection. The generic fixture permits only HTTP loopback targets.
  The Linear fixture permits only its local service or the exact advertised
  Linear origin, which it rewrites to that service. Other origins and URL
  credentials are rejected; redirects are not followed. The separate fake
  GitHub transport is unchanged.
- `npm run test:linear:browser` explicitly selects `playwright.linear.config.mjs`.
  Its existing controller redirects Linear discovery, registration, token and
  MCP fetches to the local synthetic service; browser consent is also local.

## Verification

`taskset -c 0,1 nice -n 10 npx playwright test --config playwright.linear.config.mjs --workers=1`

Result: **4/4 passed**, serial, no retries, 59 seconds. The current company
settings navigation passed without changing product code or relaxing consent,
company ownership, `list_teams` verification, cancellation, stale-edit or scope
assertions. The 360px consent screenshot was inspected and stayed within the
dialog width.

These results use synthetic local accounts and services. They do not constitute
new deployed or real-provider acceptance.

After adding the controller-side network guards, the same dedicated suite passed
again (**4/4**, 53.8 seconds) and the general fixture's four focused MCP cases
passed (**4/4**, 21.1 seconds), both serial with no retries. A transport-spy check
of the actual wrapper functions covered three permitted/four denied general
targets and two permitted/four denied Linear targets: denied targets never
reached the fetch delegate, every permitted Linear request targeted its local
fixture, and redirect following was disabled. General-config discovery lists
zero Linear tests; dedicated-config discovery lists all four.
