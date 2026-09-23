// Shared collapsed/expandable rendering policy for every chat surface that
// lists linked pull requests. Collapsed view must never exceed three rows
// (two PR rows + one toggle row) regardless of how many PRs are linked, so a
// repository with dozens of open PRs cannot push a chat's composer or dialog
// controls off-screen.
export const MAX_COLLAPSED_ROWS = 3;

// Pure so it is unit-testable without a DOM: decides which items are shown
// for a given expanded state and PR count.
export function collapsedView(items, expanded, maxCollapsedRows = MAX_COLLAPSED_ROWS) {
  const visibleWhenCollapsed = maxCollapsedRows - 1;
  const showToggle = items.length > maxCollapsedRows;
  const showAll = expanded || !showToggle;
  return {
    shown: showAll ? items : items.slice(0, visibleWhenCollapsed),
    hiddenCount: showAll ? 0 : items.length - visibleWhenCollapsed,
    showToggle,
    expanded: showAll,
  };
}

// DOM rendering shared by the composer's PR bars and the organize dialog's
// PR summary, so both surfaces get the same truncation, toggle affordance
// and scroll containment when expanded.
export function renderPullRequestList(root, items, renderItem, {
  expanded = false,
  onToggle,
  maxCollapsedRows = MAX_COLLAPSED_ROWS,
  moreLabel = count => `View ${count} more`,
  lessLabel = "Show less",
  emptyMessage = null,
  ariaLabel = "Pull requests",
} = {}) {
  // Re-rendering (a toggle click, or a live update while the toggle is
  // focused) replaces the toggle element; without this the browser drops
  // focus to <body>, breaking keyboard use of the very control just pressed.
  const toggleHadFocus = root.contains(document.activeElement) && document.activeElement.classList.contains("pr-list-toggle");
  root.replaceChildren();
  if (!items.length) { if (emptyMessage) root.append(emptyMessage()); return; }
  const view = collapsedView(items, expanded, maxCollapsedRows);
  const list = document.createElement("div");
  list.className = "pr-list-rows";
  list.setAttribute("role", "list");
  list.setAttribute("aria-label", ariaLabel);
  if (view.expanded && items.length > maxCollapsedRows) list.classList.add("pr-list-scroll");
  for (const item of view.shown) {
    const row = renderItem(item);
    row.setAttribute("role", "listitem");
    list.append(row);
  }
  root.append(list);
  if (view.showToggle) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "pr-list-toggle";
    toggle.setAttribute("aria-expanded", String(view.expanded));
    toggle.textContent = view.expanded ? lessLabel : moreLabel(view.hiddenCount);
    toggle.addEventListener("click", () => onToggle(!view.expanded));
    root.append(toggle);
    if (toggleHadFocus) toggle.focus();
  }
}
