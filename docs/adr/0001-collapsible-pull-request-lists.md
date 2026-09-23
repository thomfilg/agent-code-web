# ADR 0001: Collapsed, shared rendering for linked pull request lists

## Status

Accepted

## Context

Every chat tracks the GitHub pull requests linked to it (`chat.pullRequests`,
populated by `PullRequestMonitor` in `src/pull-requests.mjs`) and renders them
in two places:

- The composer's PR bars (`#pull-request-bars`, built by
  `ChatControls.pullRequests()` in `public/chat-controls.js`), shown directly
  above the message composer.
- The organize dialog's automatic-status summary (`#organize-pull-requests`,
  built by `ChatSidebar.renderChatStatus()` in `public/chat-sidebar.js`).

Both surfaces rendered one row per linked PR with no upper bound. A
repository with a large number of open PRs (a stale bot-authored branch
sweep, a monorepo with dozens of concurrent PRs, etc.) could link that many
PRs to a single chat. Because `.pull-request-bars` sat in a normal-flow block
above the composer inside a fixed-height flex column (`.main { height: 100vh
}` → `.conversation { flex: 1 }` → `.composer-wrap { flex: none }`), an
unbounded PR list grew the composer wrapper without bound, starving
`.conversation` down to zero height and pushing the message input past the
bottom of the viewport with no scroll affordance to reach it again. The same
unbounded-rows problem existed in the organize dialog's PR summary, though
there the native `<dialog>` element's default `overflow: auto` made it less
severe (scrollable rather than fully unreachable).

## Decision

Collapsed pull-request lists are capped at **three rows total** everywhere
they render, regardless of how many PRs are linked: at most two PR rows plus
one "View N more" toggle row. Lists with three or fewer PRs render every row
with no toggle, since that already respects the three-row cap.

This policy lives in one shared module, `public/pull-request-list.js`:

- `collapsedView(items, expanded, maxCollapsedRows = 3)` is a pure function
  (no DOM) that decides which items are visible and whether a toggle is
  needed. It is unit-tested directly (`test/pull-request-list.test.mjs`) for
  0, 1, 3, 4 and 82 items, and for a custom `maxCollapsedRows`.
- `renderPullRequestList(root, items, renderItem, options)` is the DOM
  renderer both surfaces call. It renders each item with the caller-supplied
  `renderItem` (so `ChatControls` keeps its rich PR bars — CI menu,
  auto-merge checkbox, changes button — and `ChatSidebar` keeps its compact
  summary rows), appends a keyboard-accessible `<button>` toggle
  (`aria-expanded`, text "View N more" / "Show less") when needed, and
  restores focus to the recreated toggle after a re-render if it was focused
  before (so a keyboard user's Enter/Space press on the toggle is not lost
  when the DOM is rebuilt for the same interaction or a concurrent live
  update).
- When expanded, the row list gets a bounded, independently scrollable
  region (`.pr-list-rows.pr-list-scroll`, `max-height: min(220px, 30vh)`,
  smaller on narrow viewports) instead of growing unbounded. This keeps the
  composer reachable without extra page scrolling, and keeps the organize
  dialog's remaining controls reachable via the dialog's own native modal
  scrolling — expanding never makes anything *irretrievably* off-screen, on
  desktop or phone widths.
- Expand/collapse state is kept per chat (`Set<chatId>`) in the owning
  component (`ChatControls.expandedPRs`, `ChatSidebar.expandedPRs`), matching
  the existing pattern used for hidden PR bars (`ChatControls.hiddenPRs`).
  Re-rendering on a live `chat_updated` event (new PR data, changed CI
  status) does not reset a user's expanded choice, because the expanded flag
  lives outside the re-rendered DOM.

Per-PR information required by product (PR number, repository/branch, merge
or CI state, diff counts) stays visible in every visible row on both
surfaces — the organize dialog's summary row was extended with branch and
diff-count columns to match, since it previously only showed the PR number
and a "checks pending" suffix.

## Consequences

- Any future surface that lists linked PRs reuses
  `renderPullRequestList`/`collapsedView` instead of writing its own
  truncation logic, keeping the three-row policy consistent across the app.
- The pure collapse/expand decision is unit-testable without a browser;
  DOM behavior (rendering, keyboard access, live updates, responsive
  layout) is covered by Playwright specs in `test/browser/pull-requests.spec.mjs`.
- The 3-row cap (2 visible + 1 toggle) is a product policy constant
  (`MAX_COLLAPSED_ROWS` in `public/pull-request-list.js`); changing it later
  only requires updating that one value and its tests.
