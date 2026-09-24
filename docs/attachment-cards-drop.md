# Attachment cards and draft drops

MVP items 37 and 38 use one horizontally scrollable row of image thumbnails and
file cards above either composer. Draft and sent cards open the same preview.
Raster images support fit/actual size and expanded preview. Text files show their
name, byte size and line count in a scrollable, keyboard-focusable plain-text
preview; HTML and SVG attachments are never executed. Unsupported binary files
show metadata rather than interpreting their bytes.

Drops, paste and the file picker share validation: individual files only, up to
5 MB each, 10 files and 20 MB per message. Adding files never sends a message.
Existing text and other attachments are preserved. Text-only drag/paste keeps
the browser's normal behavior.

New-chat files remain in browser memory until an explicit first Send, including
file-only messages. No chat, worker, or upload is created by staging files. Draft
files are keyed by company; switching companies hides that company's files and
closes its preview. Switching back restores them in the same page session. This
is not durable draft-file storage across reloads.

First Send waits for pending file reads, creates one chat, moves its staged files
to that chat, then uploads and dispatches. Upload failure keeps the created chat's
text and files for retry without creating a duplicate chat. Navigating away while
creation/upload is pending retains that draft without sending it into the newly
selected conversation. Slash-command first messages use the existing command
dispatcher with the staged attachments.

Saved file contents still use the existing authenticated, owner/chat-scoped
attachment endpoint with `Cache-Control: no-store`. Thumbnails load lazily and a
bounded in-memory cache avoids duplicate preview requests. No new public file
endpoint or production/provider integration is introduced.

Validation is performed with disposable local fixtures only. Browser tests cover
draft/sent previews, literal unsafe markup, keyboard and mobile layout, invalid
drops, new-chat file-only/pending-reader sends, upload retry, company isolation,
navigation during creation and first `/plan` attachments. Existing chat-controls
tests cover attachment endpoint authentication, chat isolation and limits.

## Local validation receipt (2026-09-19)

- Focused Node tests: **13/13 passed** (`attachment-view` and `chat-controls`).
- Six browser files, serial with retries disabled: **35/37 passed**. All **12/12
  attachment cases**, **5/5 new-chat page**, **7/7 new-chat command** and **5/5
  project-preference** cases passed.
- The two remaining assertions concern global horizontal overflow in the native
  app picker and workspace-context mobile fixtures. Both reproduce in a separate
  clean worktree at base `f3819f1` without this feature (same two assertions fail).
  They remain failures, not a claim that the whole browser suite is green.
- Desktop 1440 px and mobile 390 px attachment-row/text-preview screenshots were
  visually inspected: cards stay in a single internally scrollable row, the
  composer remains visible, and the text preview is contained on mobile.

The first browser run had additional fixture failures: new cases omitted the
selected company's GitHub/repository setup and the directory-drop fixture patched
an ephemeral browser wrapper rather than its prototype. Corrected setup uses the
existing synthetic device-login/API fixture, a real registered company and an
explicit repository, without real provider calls. Old new-chat-page fixtures were
also updated from multi-company environments to the current single-company UI.
Their IME/Shift+Enter checks remain; the obsolete repo-less new-chat assertion now
checks company-scoped admission before selecting a repository. This does not
change backend compatibility or recovery of existing repository-less chats.

The first Node attempt needed the normal generated authentication build; after
`node scripts/build-auth.mjs`, both focused runs passed. These receipts validate
local UI and scoped upload behavior only, not production deployment.
