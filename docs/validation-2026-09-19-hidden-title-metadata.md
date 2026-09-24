# Hidden title metadata: live and persisted responses

The parser now recognizes reserved standalone `<relay-title>…</relay-title>`
lines throughout an assistant response, including after commentary/tool output.
Live streaming and completed-response extraction use the same parser. Disabling
automatic naming no longer disables filtering: manual names stay locked, while
metadata remains hidden in live deltas, final messages and background responses.
The existing runtime's latest `autoTitle` check remains authoritative if the
user renames a chat while a turn is running.

This is not arbitrary tag removal. Inline prose, quoted lines, indented code,
backtick/tilde fenced code and multiline inline-code spans retain literal tags
and cannot supply a title. Fence context survives a tool-boundary flush. Tags
must form a complete standalone line; malformed or oversized candidates remain
literal. Candidate and line-context buffers are bounded at 1,000 characters;
ordinary prose is emitted immediately rather than waiting for a whole line.

Validation covers arbitrary chunk splits and case, automatic/manual chats,
late metadata, a manual rename during a commentary/tool turn, completed-only
and background results, quoted examples, long code-fence info lines, and bounded
malformed prefixes. No real provider session, account, worker or deployment is
used by these tests.

Local result: **54/54 Node cases passed**, serial on two CPUs, covering
`title-metadata`, `chat-titles`, `settings`, `workflow`, `side-chats`,
`imported-chats` and `agent-threads`. The new split-boundary coverage caught a
CRLF candidate issue during development; the final complete focused run passed
after retaining the trailing CR until its LF arrives. No provider/model calls or
production actions were needed.
