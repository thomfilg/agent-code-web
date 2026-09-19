# Saved prompts: scope and insertion contract (MVP 39)

The library belongs to the signed-in Relay user, or the existing shared server
identity when private sign-in is not configured. It is not an agent account or a
company connection. The explicit “All my projects” choice makes the owner's own
prompt text reusable across their projects; it grants no repository, credential,
MCP, browser or worker access. Selected-project keys combine the company ID and
case-normalized primary repository, never a repository name alone.

Project choices come from the owner's visible chats and previously validated
project selections, intersected with their registered companies. Opening or
editing the library does not discover providers, authenticate accounts, create
chats, start workers or send model input. Existing orphaned project bindings can
be edited or removed; new unknown project bindings are rejected, never widened
silently to all projects.

Storage is one encrypted `saved-prompts` record per owner in the existing record
store. A narrow transaction locks that record and compares its expected revision
before committing. It does not use or alter native-session or worker-admission
transactions. Stale writes return 409, preserving the editor for explicit reload
and retry. Authentication is checked across asynchronous reads and writes.

Limits are 100 prompts, 20,000 characters per prompt, 50 selected projects per
prompt, and 500,000 encoded bytes per library. Prompt content is plain text and
is never interpreted as HTML in the picker/editor. Clicking a prompt inserts its
text at the composer's cursor without replacing surrounding draft text or files.
There is no automatic send. Company/chat changes dismiss a pending picker so a
late response cannot insert into a different conversation.

## Local validation — 2026-09-19

The isolated feature worktree starts at `d63d95f`, with attachment cards
`32fe486`, mobile header correction `43a01d1`, and the test-only workspace
selection-readiness correction `0adcf3a` as separate prerequisites. It does not
change production state or use personal profiles or real providers.

- `node --test --test-concurrency=1 test/saved-prompts.test.mjs`: **5/5 passed**,
  including actual disposable PostgreSQL encryption/reopen, independent CAS,
  revoked-write rollback and deferred COMMIT rejection; HTTP owner/origin
  isolation and zero worker starts; validation and project boundaries.
- Final `playwright test test/browser/saved-prompts.spec.mjs
  test/browser/controls.spec.mjs --workers=1 --retries=0`: **11/11 passed**.
  Eight saved-prompt cases exercise literal CRUD, insertion without sending,
  existing/local attachments and text preservation, project availability,
  drag/keyboard reorder, delete, stale 409/editor reload, delayed PATCH/GET
  fencing, message-length behavior and desktop/390px keyboard-accessible layout.
- The preceding five-file compatibility run passed **31/32**: all 12 attachment,
  four native-app and five workspace-context cases passed, plus eight saved-prompt
  cases and two controls cases. The sole failure exposed a real extra mobile
  footer row: composer height became 150px. The final scoped 32px empty-textarea
  minimum restores the compact layout; all three controls cases passed in the
  final 11-case run. The other 21 compatibility cases were not rerun after that
  CSS-only correction, so this is not a claim of a final 32/32 run.

All runs used two pinned CPUs, niceness 10, one test worker and zero retries.
The first Node run was 4/5, with a disposable PostgreSQL administrator-close
error; the fixture now explicitly closes PostgreSQL before directory teardown,
and the final run passed. The first new-browser run was 6/8 because two test
locators omitted the visible New chat shortcut; their actions/assertions were
preserved and the locators corrected before the passing run.

Final desktop, mobile picker and mobile editor screenshots were visually
inspected from `test-results/saved-prompts-desktop-and--7d3a9-ntrols-and-fit-the-viewport/`.
This is local component acceptance, not deployment or authenticated production
acceptance. The full combined application suite remains the integration gate.
