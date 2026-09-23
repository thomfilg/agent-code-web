import assert from "node:assert/strict";
import test from "node:test";
import { collapsedView, MAX_COLLAPSED_ROWS } from "../public/pull-request-list.js";

const items = count => Array.from({ length: count }, (_, i) => ({ number: i + 1 }));

test("collapsed view never exceeds three rows worth of content regardless of PR count", () => {
  for (const count of [0, 1, 3, 4, 82]) {
    const view = collapsedView(items(count), false);
    const rows = view.shown.length + (view.showToggle ? 1 : 0);
    assert.ok(rows <= MAX_COLLAPSED_ROWS, `expected <= ${MAX_COLLAPSED_ROWS} rows for ${count} PRs, got ${rows}`);
  }
});

test("0, 1 and exactly MAX_COLLAPSED_ROWS items show everything with no toggle", () => {
  for (const count of [0, 1, 3]) {
    const view = collapsedView(items(count), false);
    assert.equal(view.shown.length, count);
    assert.equal(view.showToggle, false);
    assert.equal(view.hiddenCount, 0);
    assert.equal(view.expanded, true);
  }
});

test("4 items collapse to two shown plus a toggle for the remaining two", () => {
  const view = collapsedView(items(4), false);
  assert.equal(view.shown.length, 2);
  assert.deepEqual(view.shown.map(item => item.number), [1, 2]);
  assert.equal(view.showToggle, true);
  assert.equal(view.hiddenCount, 2);
  assert.equal(view.expanded, false);
});

test("82 items collapse to two shown plus a toggle reporting 80 more", () => {
  const view = collapsedView(items(82), false);
  assert.equal(view.shown.length, 2);
  assert.equal(view.showToggle, true);
  assert.equal(view.hiddenCount, 80);
});

test("expanding shows every item and still reports the toggle so it can collapse again", () => {
  const view = collapsedView(items(82), true);
  assert.equal(view.shown.length, 82);
  assert.equal(view.showToggle, true);
  assert.equal(view.hiddenCount, 0);
  assert.equal(view.expanded, true);
});

test("expanding a count at or under the threshold is a no-op with no toggle either way", () => {
  assert.equal(collapsedView(items(3), true).showToggle, false);
  assert.equal(collapsedView(items(3), false).showToggle, false);
});

test("a custom maxCollapsedRows still yields exactly one fewer visible row than the cap", () => {
  const view = collapsedView(items(10), false, 5);
  assert.equal(view.shown.length, 4);
  assert.equal(view.hiddenCount, 6);
});
