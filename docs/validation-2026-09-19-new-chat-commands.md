# Commands in the inline new-chat composer

The draft composer uses the same SlashComposer renderer, keyboard navigation and
ARIA behavior as an existing chat. Its cache includes the selected provider and
account; stale account results and dismissed menu responses cannot reopen it.

`GET /api/new-chat/commands` returns Relay controls and, when already available,
the selected Claude account's cached native command metadata. It does not create
a chat, acquire a worker, query a model catalog, start a CLI, or read another
account/host's native inventory. Native commands/skills and session-only controls
show an explanatory unavailable state before a chat exists.

On explicit send, supported first commands are preflighted before chat creation,
then use the existing active-chat dispatcher. Bare `/goal` opens the same goal
panel without sending a literal prompt or waking a worker. `/goal <objective>`
uses the ordinary message route and its existing native goal parser. Unknown or
session-only commands never silently become first prompts. Failed sends retain
the draft in the created chat; navigation away does not execute its command in
another chat or create another conversation.

Validation uses synthetic accounts, API routes and local browser fixtures only;
no real provider session, model prompt, credential, worker or cloud operation.
Focused checks cover provider/account separation, keyboard insertion versus send,
disabled commands, no duplicate creation, explicit goal dispatch, slow discovery,
and the 320px menu layout. Existing active-chat picker tests are included because
the picker implementation is shared.

Local results on 2026-09-19:

- Node: 10/10 (`new-chat-commands.test.mjs`, `commands.test.mjs`).
- Playwright: 10/10, serial, no retries: six draft-command cases, three existing
  active-chat picker cases, and normal inline first-message creation.
- Desktop and 320px screenshots inspected; no picker overflow.
- A gated navigation test exposed and now covers a pre-existing draft ordering
  bug: MessageHistory selection must happen before restoring a retained draft,
  so it cannot overwrite the draft or save it under the previous conversation.

These are local synthetic acceptance results, not deployed/provider validation.
