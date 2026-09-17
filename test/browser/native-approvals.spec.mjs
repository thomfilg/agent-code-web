import { test, expect } from "@playwright/test";

const chats = new WeakMap();
test.afterEach(async ({ page }) => { for (const id of chats.get(page) || []) await page.request.delete(`/api/chats/${id}`); });
async function setup(page) {
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "codex", title: `Approval review ${Date.now()}` } })).json(); chats.set(page, [chat.id]);
  const snapshot = { ...chat, revision: 999999, status: "running", agentSessionId: "native-approval-fixture", messages: [] };
  await page.route(`**/api/chats/${chat.id}`, route => route.request().method() === "GET" ? route.fulfill({ json: { chat: snapshot } }) : route.fallback());
  await page.route(`**/api/chats/${chat.id}/events*`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  const catalog = { threadId: snapshot.agentSessionId, reviews: [{ id: "review-1", revision: "revision-1", state: "available", createdAt: Date.now(),
    action: JSON.stringify({ type: "command", command: "printf '<img src=x onerror=alert(1)>'", cwd: "/private/workspace" }, null, 2), rationale: "Risk reviewed; user authorization was insufficient.", risk: "low", authorization: "low" }] }, changes = [], sent = [];
  await page.route(`**/api/chats/${chat.id}/approvals`, route => route.fulfill({ json: catalog }));
  await page.route(`**/api/chats/${chat.id}/approvals/retry`, route => { changes.push(route.request().postDataJSON()); catalog.reviews[0].state = "queued"; return route.fulfill({ status: 202, json: { id: "review-1", state: "queued", queuePaused: true } }); });
  for (const tail of ["messages", "queue", "stop"]) await page.route(`**/api/chats/${chat.id}/${tail}`, route => { sent.push(tail); return route.fulfill({ json: { chat: snapshot } }); });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  return { chat, snapshot, catalog, changes, sent };
}
async function open(page) {
  await page.locator("#message-input").fill("/approve"); await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(page.locator("#controls-title")).toHaveText("Approve a denied action");
  await expect(page.locator(".native-approval-card")).toBeVisible();
}

test("busy-chat approval requires explicit confirmation, renders literal metadata and preserves drafts/files", async ({ page }) => {
  const f = await setup(page);
  await page.locator("#attachment-input").setInputFiles({ name: "draft.txt", mimeType: "text/plain", buffer: Buffer.from("Private draft file") });
  await expect(page.locator("#attachment-chips")).toContainText("draft.txt"); await open(page);
  await expect(page.locator(".native-approval-card pre")).toContainText("<img src=x onerror=alert(1)>"); await expect(page.locator(".native-approval-card img")).toHaveCount(0);
  await expect(page.locator("#controls-content")).toContainText("does not wake the worker");
  await page.getByRole("button", { name: "Review retry", exact: true }).click(); expect(f.changes).toEqual([]);
  await expect(page.locator(".native-approval-confirm")).toContainText("may execute the reviewed command");
  await page.getByRole("button", { name: "Cancel retry", exact: true }).click(); expect(f.changes).toEqual([]);
  await expect(page.getByRole("button", { name: "Review retry", exact: true })).toBeFocused();
  await page.locator("#message-input").evaluate(input => { input.value = "Keep my unrelated draft"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.getByRole("button", { name: "Review retry", exact: true }).click(); await page.screenshot({ path: "test-results/native-approval-confirm.png" });
  await page.getByRole("button", { name: "Confirm approval & queue retry", exact: true }).click();
  await expect(page.locator("#controls-content [role=status]")).toContainText("Resume the paused message queue");
  expect(f.changes).toEqual([{ id: "review-1", revision: "revision-1", threadId: f.catalog.threadId, confirm: true }]);
  await expect(page.locator("#message-input")).toHaveValue("Keep my unrelated draft"); await expect(page.locator("#attachment-chips")).toContainText("draft.txt"); expect(f.sent).toEqual([]);
});

test("mobile review supports empty history and uncertain results without horizontal overflow or automatic retries", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); const f = await setup(page); await open(page);
  await page.getByRole("button", { name: "Review retry", exact: true }).click();
  await expect(page.locator(".native-approval-confirm")).toBeVisible();
  expect(await page.locator("#controls-dialog").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: "test-results/native-approval-mobile.png" });
  await page.route(`**/api/chats/${f.chat.id}/approvals/retry`, route => route.fulfill({ status: 409, json: { error: "Approval response lost; inspect recorded status" } }));
  await page.getByRole("button", { name: "Confirm approval & queue retry", exact: true }).click();
  await expect(page.locator("#controls-content [role=status]")).toContainText("Approval response lost"); await expect(page.getByRole("button", { name: "Review retry", exact: true })).toBeDisabled();
  f.catalog.reviews[0].state = "uncertain"; await page.getByRole("button", { name: "Refresh denied actions", exact: true }).click();
  await expect(page.locator(".native-approval-card")).toContainText("not automatically repeat"); await expect(page.locator(".native-approval-card button")).toHaveCount(0);
  f.catalog.reviews = []; await page.getByRole("button", { name: "Refresh denied actions", exact: true }).click();
  await expect(page.locator("#controls-content [role=status]")).toContainText("No retained automatic-review denials"); expect(f.changes).toEqual([]); expect(f.sent).toEqual([]);
});

test("late approval discovery cannot clear a newer draft or replace a newer dialog", async ({ page }) => {
  const f = await setup(page), entered = Promise.withResolvers(), release = Promise.withResolvers(); let first = true;
  await page.route(`**/api/chats/${f.chat.id}/approvals`, async route => { if (first) { first = false; entered.resolve(); await release.promise; } return route.fulfill({ json: f.catalog }); });
  await page.locator("#message-input").fill("/approve"); await page.getByRole("button", { name: "Queue", exact: true }).click(); await entered.promise;
  await page.locator("#controls-dialog").evaluate(dialog => dialog.close()); await open(page);
  await page.locator("#message-input").evaluate(input => { input.value = "Newer draft"; }); release.resolve();
  await page.getByRole("button", { name: "Review retry", exact: true }).click();
  await expect(page.locator(".native-approval-confirm")).toBeVisible(); await expect(page.locator("#message-input")).toHaveValue("Newer draft"); expect(f.changes).toEqual([]); expect(f.sent).toEqual([]);
});

test("late confirmed retry reports its original chat without overwriting a reopened panel", async ({ page }) => {
  const f = await setup(page), entered = Promise.withResolvers(), release = Promise.withResolvers();
  await page.route(`**/api/chats/${f.chat.id}/approvals/retry`, async route => { entered.resolve(); await release.promise; return route.fulfill({ json: { id: "review-1", state: "queued", queuePaused: false } }); });
  await open(page); await page.getByRole("button", { name: "Review retry", exact: true }).click(); await page.getByRole("button", { name: "Confirm approval & queue retry", exact: true }).click(); await entered.promise;
  await page.locator("#controls-dialog").evaluate(dialog => dialog.close()); f.catalog.reviews[0].state = "completed"; await open(page);
  await page.locator("#message-input").evaluate(input => { input.value = "New draft after confirmation"; }); release.resolve();
  await expect(page.locator("#toasts")).toContainText(`${f.chat.title}: Retry queued`); await expect(page.locator(".native-approval-card")).toContainText("Retry turn completed");
  await expect(page.locator("#message-input")).toHaveValue("New draft after confirmation"); expect(f.sent).toEqual([]);
});
