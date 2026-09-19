# Native chat mobile header — 2026-09-19

The native-app picker and workspace-context browser tests both failed horizontal
containment on an unchanged `f3819f1` baseline. A diagnostic run on `d63d95f`
reproduced both: at a 390 px viewport the native chat header's action strip
extended to 410 px. The modal and attachment cards were not the source.

The existing phone header wrapping rule applied only at 380 px and below. It
now applies through 480 px: the title has its own row, and actions wrap as
needed. Nothing is hidden or clipped to suppress the overflow assertion.
This intentionally does not change desktop layout or the shared-browser header.

Validation of the final source: **9/9 browser tests passed**, no retries, 19.9
seconds (session `12004`, `/tmp/relay-mobile-overflow-final.log`). This includes
the complete native-app picker and workspace-context files, retaining draft,
late-result, queue and error behavior assertions. The new test covers 320, 390,
430 and 480 px; every named header action and the title must be fully in the
viewport (`ratio: 1`), the title keeps useful width, and the page cannot scroll
horizontally. The two original failing assertions pass without modification.

The earlier diagnostic run failed 2/2 as expected. An initial fixed-source run
passed 9/9; independent review then requested full-intersection assertions,
which were strengthened and re-run in the final receipt above. Desktop source
is unchanged; 320/390 px screenshots were visually inspected. On narrow phones
the controls can occupy multiple rows so all remain reachable.

This is local regression acceptance, not a production deployment. Existing
attachment PR baseline failures are resolved by this separate patch only when
both changes are integrated and validated together.
