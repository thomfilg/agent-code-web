# Browser settings layout — 2026-09-19

The inner Browser connections card previously requested 650px inside a generic
490px dialog. Set the width on the outer dialog and let its card fill it; wrap
long profile labels and action rows instead of clipping them.

Validation: `taskset -c 0,1 nice -n 10 npx playwright test test/browser/browser-connections.spec.mjs --workers=1 --retries=0`
passed 3/3, without retries. Synthetic signed-in fixtures cover expanded pairing
instructions and long profile names at 1280px and 390px. Tests assert no horizontal
overflow, no unnecessary desktop vertical scrolling, visible close controls,
no browser-access mutations and no page errors. Desktop/mobile screenshots were
visually inspected. Existing logged-out consent behavior remains covered.

This changes presentation only: no credentials, profiles, permissions, live
connections or running workers were changed. Not deployed by this validation.
