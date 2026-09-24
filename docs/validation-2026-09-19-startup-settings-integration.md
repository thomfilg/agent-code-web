# Startup and settings integration — 2026-09-19

Application/test source: `fe6cd6f`. This combines parallel EC2/repository startup,
persisted stage timings, the company-filtered environment card editor and the
Browser connections modal sizing correction. The previously staged MCP result
visibility correction is also present. No deployment was performed.

## Clean integrated verification

```
AGENT_TEST_NATIVE_GITHUB=1 RELAY_GUEST_UI_TEST=1 \
  taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 test/*.test.mjs
```

**1,314 passed**, zero failed, cancelled or skipped; 282,877ms. Optional installed
native CLI / disposable Chrome checks were enabled. This does not establish
authenticated selected-product-account production acceptance.

```
taskset -c 0,1 nice -n 10 npx playwright test \
  test/browser/environment-selection.spec.mjs \
  test/browser/browser-connections.spec.mjs \
  test/browser/startup-progress.spec.mjs \
  test/browser/working-status.spec.mjs --workers=1 --retries=0
```

**15 passed**, no retries; 22.1s. Includes company/environment selection, three
cards and one editor, dirty/reverted Save state, fixed Save in narrow long forms,
error-preserved drafts, success-close, old grants/protected-value preservation,
new-environment company isolation, browser-modal wrapping, parallel stage clocks,
reload/frozen timings, deletion precedence and Stop/Escape regressions.

Desktop/mobile component screenshots were visually reviewed, including long
profile names, pairing instructions, environment overview and a long variables
editor. The variable table may scroll locally on narrow screens; the modal does
not overflow horizontally and Save remains visible.

## Scope and publication

- Settings UX is included in MVP. Cache/pre-prepared environment work remains
  explicitly post-MVP; no credentials or workspaces are copied for reuse.
- User-reported successful Linear issue retrieval and `/btw` are recorded in the
  separate acceptance receipt; no private ticket content is included.
- No live worker, Chrome profile, login, cloud resource or company grant was
  changed by this integration. No measured production latency gain is claimed.
- Production remains the last verified published source `d9c0ce6`; the older
  staged image from `94860e7` does not include this startup/settings work.
- Existing unrelated working-tree changes remain uncommitted. The overlapping
  pre-integration work was retained in local stash `d0b38699e81a296680acc49a68b0e3c5b74af9a0`
  and restored with conflict resolution; no unrelated work was discarded.
