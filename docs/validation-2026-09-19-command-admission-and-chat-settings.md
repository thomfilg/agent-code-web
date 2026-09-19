# Command admission and grouped chat settings — September 19, 2026

## Result

- `/status` opens the existing detailed usage panel in the browser and sends no
  message or queue request.
- `/qualquerporra` is rejected as an unknown command before transcript, queue,
  worker or model state changes. The draft is restored after the API error.
- The same server-side catalog admission runs for immediate sends and queue
  insertion. Codex skills retain structured skill dispatch; reported Claude
  commands and aliases retain their literal native prefix and arguments.
- New-chat preflight uses the same explicit unknown-command language. Session-only
  commands remain disabled until a chat exists.
- Filesystem prose beginning with an absolute path such as `/tmp/project` is not
  misclassified as a slash command.

The chat header now leaves the frequent signed-Chrome, Browser, Open app and
Agents controls visible. The former repository, changes, link and overflow icons
are consolidated into a labelled **Chat settings** menu with Workspace,
Conversation, Appearance & input, Worker and Danger zone sections. Repository
details expand in place. The menu remains contained at 390 px.

## Focused evidence

- Node command suites: 19/19 across `commands`, `claude-commands` and
  `new-chat-commands`.
- Browser checks: the new `/status`/unknown-command case, grouped-header case and
  updated repository/change interactions pass. The 169-case related browser run
  passed 167 immediately; the two old interactions that still clicked newly
  nested actions directly were updated and passed on rerun. The separate native
  header test passes at 320, 390, 430 and 480 px.
- Syntax checks pass for the changed runtime and browser modules.

The first broad Node pass exposed a real same-tick fork race caused by awaiting
validation even for ordinary text. Admission now remains synchronous for normal
messages and built-in actions; only catalog-backed slash names yield. The exact
fork race plus the command suites pass 29/29. The final full suite ran 1,601
cases: 1,596 passed, four were intentionally skipped, and one unrelated HTTP
test hit a transient `ECONNRESET`; its complete file passed 9/9 immediately on
isolated rerun.

Full regression and deployed acceptance remain required before publication is
claimed.
