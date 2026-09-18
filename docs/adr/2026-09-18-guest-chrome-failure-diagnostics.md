# Preserve safe guest Chrome acceptance diagnostics

Status: implemented and locally exercised; another real AWS attempt is required.

The first EC2 guest fixture failed while the UI still displayed Connecting. Its
cleanup exception then replaced the original UI failure. The installed official
Playwright MCP 0.0.81 documents a 5-second default action timeout, and the fixture
used a bare locator `waitFor()` for the first Live status. Production browser
startup already permits 30 seconds, and the remote fixture starts separate SSH
processes for the Chrome version check and browser worker. A premature UI wait
is therefore a supported hypothesis, **not a confirmed AWS root cause**.

The initial Live wait now explicitly permits 45 seconds, within the existing
60-second MCP call limit. No Chrome sandbox flag, production browser source,
worker image audit or isolation boundary is changed.

Failures produce a fixed JSON receipt: accepted=false, allowlisted phase and
category, strict observation/cleanup booleans, bounded numeric exit codes and
allowlisted sandbox counts/booleans. Raw exceptions, MCP responses, native stderr,
paths, account data and tokens are never returned. A bounded in-memory stderr
tail is classified into fixed sandbox/missing/permission/pipe/timeout/exited
categories, then discarded. Production browser ready/failure events are observed
without modifying their worker source or launch behavior. Unknown failures stay
unknown/failed; diagnostic collection cannot replace the primary error.

Cleanup first awaits the application's browser/startup shutdown. It then waits
up to eight seconds for the **unchanged complete zero-process audit**, accounting
for renderers/crash handlers that exit shortly after Chrome's root process.
Incomplete `/proc` visibility or a remaining Chrome still fails closed; the
marked fixture directory is never removed on uncertain evidence. Exact local
transport children are terminated and their exit/close is confirmed boundedly:
a successful signal request alone is not reported as workersStopped. Every
owned child is attempted even if another child remains unconfirmed. Cleanup
failures add independent flags but do not hide the original UI/worker phase.

The external supervisor must still retire the exact dedicated EC2 worker and
its disk after every attempt. These receipts do not prove AWS retirement or
deployed Google authentication.

Validation: the existing eight offline guest tests and seven new diagnostic
tests pass. The official local Playwright MCP UI acceptance also passed all six
viewport presets, sharp pixels, same tab/document, mouse/keyboard, SSE updates,
renderer sandbox and Chrome stop/cleanup. Root and GitHub-agent independent
reviews checked fixed diagnostic boundaries and unchanged strict audit; the
latter identified the signal-versus-exit receipt gap, now covered by regression.
No AWS calls or model turns were made by this implementation agent.
