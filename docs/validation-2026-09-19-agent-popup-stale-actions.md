# Child-agent popup: late receipts and draft identity

The popup previously cleared drafts by text equality alone. A user could submit
a child message, leave for New chat, return to the same child and retype the same
text. The first request's delayed receipt then erased the new draft.

Each user edit now advances that draft's revision. A completed request clears
only its unchanged submitted draft, including when viewing another child; it
does not erase a subsequently edited draft with identical text. No request is
replayed and the main conversation is not changed.

Panel requests also capture a monotonic chat-selection epoch. Responses from a
previous visit cannot replace current state after A → New chat → A. Snapshot
generation checks reject retired observer responses, including delayed history
pages: checking only the outer snapshot was insufficient because `select` could
still apply `result.page` after the snapshot itself had been rejected.

## Validation history

- First browser reproduction failed at navigation: changing the hash directly
  does not select an existing chat in this SPA. It did not reach the assertion.
- Using the real sidebar control reproduced the product failure: the newly
  retyped identical draft became empty when the first request completed.
- The first fix passed all 7 child-panel browser tests, zero retries (16.4 s),
  including the existing other-child draft preservation and no-main-write tests.
- Independent review identified the separate retired history-page gap described
  above. Its fix and an explicit delayed-page/replacement-observer regression
  were then added. The final browser run passed **8/8**, zero retries (16.0 s),
  including both new regressions and all six existing child-panel cases.

These are isolated browser fixtures. They neither recover the reported live
Claude queue nor claim native-provider/deployed acceptance. No environment,
Chrome profile, persisted conversation or queued message was modified.
