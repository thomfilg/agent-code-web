import { test, expect } from "@playwright/test";
const created = [];
test.afterEach(async ({ request }) => { for (const id of created.splice(0)) await request.delete(`/api/chats/${id}`); });

function makePRs(count, { repository = "Acme/api" } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    repository, number: i + 1, url: `https://github.com/${repository}/pull/${i + 1}`,
    title: `Fixture PR ${i + 1}`, state: "open", merged: false, headRef: `feature/pr-${i + 1}`, baseRef: "main",
    additions: 10 + i, deletions: i, changedFiles: 1 + (i % 3), conflicts: false, autoMerge: false,
    checks: "passing", checksStale: false, ci: { passed: 3, skipped: 0, inProgress: 0, failed: 0, total: 3 },
    verifiedAt: new Date().toISOString(),
  }));
}

async function openFixture(page, extra = {}) {
  await page.route("**/api/chats/chat_*/commands", route => route.fulfill({ json: { commands: [{ name: "usage" }] } }));
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "mock", title: `PR list ${Date.now()}` } })).json();
  created.push(chat.id);
  await page.route("**/api/sidebar", async route => { const response = await route.fetch(), data = await response.json(); data.chats = data.chats.map(item => item.id === chat.id ? { ...item, ...extra } : item); await route.fulfill({ response, json: data }); });
  await page.route(`**/api/chats/${chat.id}/events*`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  await page.route(`**/api/chats/${chat.id}`, route => route.request().method() === "GET" ? route.fulfill({ json: { chat: { ...chat, ...extra, messages: [] } } }) : route.continue());
  await page.addInitScript(() => { const Native = window.EventSource; window.relaySources = []; window.EventSource = class extends Native { constructor(...args) { super(...args); window.relaySources.push(this); } }; });
  await page.goto(`/?chat=${chat.id}`);
  const openSidebar = page.locator("#open-sidebar");
  if (await openSidebar.isVisible()) await openSidebar.click();
  await page.getByRole("button", { name: `Open ${chat.title}`, exact: true }).click();
  return chat;
}

function emitChatUpdated(page, chat) {
  return page.evaluate(chat => {
    const source = window.relaySources.find(s => s.url.includes(`/chats/${chat.id}/events`));
    source.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "chat_updated", chat }) }));
  }, chat);
}

for (const count of [0, 1, 3, 4, 82]) {
  test(`composer PR bars for ${count} linked PRs never exceed three collapsed rows`, async ({ page }) => {
    const chat = await openFixture(page, { pullRequests: makePRs(count) });
    const bars = page.locator("#pull-request-bars .pull-request-bar");
    const toggle = page.locator("#pull-request-bars .pr-list-toggle");
    if (count <= 3) {
      await expect(bars).toHaveCount(count);
      await expect(toggle).toHaveCount(0);
    } else {
      await expect(bars).toHaveCount(2);
      await expect(toggle).toHaveCount(1);
      await expect(toggle).toHaveText(`View ${count - 2} more`);
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
    }
    if (count > 0) {
      await expect(bars.first().getByRole("link", { name: "⑂ #1" })).toBeVisible();
      await expect(bars.first()).toContainText("feature/pr-1");
      await expect(bars.first().getByRole("button", { name: "View changes for PR 1" })).toBeVisible();
    }
  });
}

test("expanding and collapsing the composer PR list preserves keyboard access and never pushes the composer out of view", async ({ page }) => {
  const chat = await openFixture(page, { pullRequests: makePRs(82) });
  const toggle = page.locator("#pull-request-bars .pr-list-toggle");
  const input = page.getByLabel("Message", { exact: true });
  await expect(input).toBeInViewport();
  await toggle.focus();
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#pull-request-bars .pull-request-bar")).toHaveCount(82);
  await expect(toggle).toHaveText("Show less");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  // Expanded rows must scroll within a bounded region rather than growing the
  // page, so the message composer stays reachable without extra scrolling.
  await expect(input).toBeInViewport();
  const overflow = await page.locator("#pull-request-bars .pr-list-rows").evaluate(node => node.scrollHeight > node.clientHeight);
  expect(overflow).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.locator("#pull-request-bars .pull-request-bar")).toHaveCount(2);
  await expect(toggle).toHaveText("View 80 more");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("composer PR list stays within three collapsed rows and keeps the composer reachable on a phone-width viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const chat = await openFixture(page, { pullRequests: makePRs(82) });
  await expect(page.locator("#pull-request-bars .pull-request-bar")).toHaveCount(2);
  const toggle = page.locator("#pull-request-bars .pr-list-toggle");
  await expect(toggle).toHaveText("View 80 more");
  await expect(page.getByLabel("Message", { exact: true })).toBeInViewport();
  await toggle.click();
  await expect(page.locator("#pull-request-bars .pull-request-bar")).toHaveCount(82);
  await expect(page.getByLabel("Message", { exact: true })).toBeInViewport();
});

test("a live chat_updated event refreshes PR rows without resetting the user's expanded choice", async ({ page }) => {
  const chat = await openFixture(page, { pullRequests: makePRs(3) });
  await expect(page.locator("#pull-request-bars .pull-request-bar")).toHaveCount(3);
  await expect(page.locator("#pull-request-bars .pr-list-toggle")).toHaveCount(0);
  const grown = { ...chat, pullRequests: makePRs(5), revision: 1000, updatedAt: new Date().toISOString() };
  await emitChatUpdated(page, grown);
  const bars = page.locator("#pull-request-bars .pull-request-bar");
  const toggle = page.locator("#pull-request-bars .pr-list-toggle");
  await expect(bars).toHaveCount(2);
  await expect(toggle).toHaveText("View 3 more");
  await toggle.click();
  await expect(bars).toHaveCount(5);
  const updatedChecks = { ...grown, pullRequests: makePRs(5).map((pr, i) => i === 0 ? { ...pr, checks: "failing", conflicts: true } : pr), revision: 1001, updatedAt: new Date(Date.now() + 1000).toISOString() };
  await emitChatUpdated(page, updatedChecks);
  await expect(bars).toHaveCount(5);
  await expect(toggle).toHaveText("Show less");
  await expect(bars.first().locator(".ci-menu > summary")).toHaveText("Conflict");
});

for (const count of [0, 1, 3, 4, 82]) {
  test(`organize dialog PR summary for ${count} linked PRs never exceeds three collapsed rows`, async ({ page }) => {
    const chat = await openFixture(page, { pullRequests: makePRs(count) });
    await page.getByRole("button", { name: `Organize ${chat.title}`, exact: true }).click();
    const rows = page.locator("#organize-pull-requests .pr-summary-row");
    const toggle = page.locator("#organize-pull-requests .pr-list-toggle");
    if (count <= 3) {
      await expect(rows).toHaveCount(count);
      await expect(toggle).toHaveCount(0);
    } else {
      await expect(rows).toHaveCount(2);
      await expect(toggle).toHaveCount(1);
      await expect(toggle).toHaveText(`View ${count - 2} more`);
    }
    if (count > 0) {
      await expect(rows.first()).toContainText("#1 · Open");
      await expect(rows.first()).toContainText("feature/pr-1");
      await expect(rows.first()).toContainText("+10");
    }
  });
}

test("expanding the organize dialog PR summary shows every PR and the dialog stays scrollable, not composer-blocking", async ({ page }) => {
  const chat = await openFixture(page, { pullRequests: makePRs(82) });
  await page.getByRole("button", { name: `Organize ${chat.title}`, exact: true }).click();
  const toggle = page.locator("#organize-pull-requests .pr-list-toggle");
  await expect(toggle).toHaveText("View 80 more");
  await toggle.focus(); await expect(toggle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#organize-pull-requests .pr-summary-row")).toHaveCount(82);
  await expect(toggle).toHaveText("Show less");
  await expect(page.locator("#organize-dialog")).toBeVisible();
  // The expanded list scrolls within its own bounded region; the dialog's
  // native modal scrolling keeps the rest of the form reachable, not
  // permanently hidden below an ever-growing list.
  const deleteButton = page.locator("#organize-delete-chat");
  await deleteButton.scrollIntoViewIfNeeded();
  await expect(deleteButton).toBeVisible();
});
