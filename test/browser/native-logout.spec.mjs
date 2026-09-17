import { test, expect } from "@playwright/test";

const chats = new WeakMap();
test.afterEach(async ({ page }) => { for (const id of chats.get(page) || []) await page.request.delete(`/api/chats/${id}`); });
async function setup(page) {
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "codex", title: `Native sign-out ${Date.now()}` } })).json(); chats.set(page, [chat.id]);
  const snapshot = { ...chat, revision: 999999, status: "running", agentSessionId: "native-logout-fixture", messages: [] };
  await page.route(`**/api/chats/${chat.id}`, route => route.request().method() === "GET" ? route.fulfill({ json: { chat: snapshot } }) : route.fallback());
  await page.route(`**/api/chats/${chat.id}/events*`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  const reviews = [], calls = { inspect: 0, confirm: [], inputs: [] }, account = { type: "chatgpt", email: "<img src=x onerror=alert(1)>@fixture.invalid" };
  const info = { privateProfile: true, gateway: true, canLogout: true, busy: false, storage: "file", account, credentialPresent: true };
  await page.route(`**/api/chats/${chat.id}/logout`, route => route.fulfill({ json: { reviews } }));
  await page.route(`**/api/chats/${chat.id}/logout/inspect`, route => {
    calls.inspect++;
    const review = info.canLogout ? { id: `review-${calls.inspect}`, revision: `revision-${calls.inspect}`, threadId: snapshot.agentSessionId, account: info.account, storage: info.storage, gateway: true, state: "reviewed", createdAt: Date.now(), expiresAt: Date.now() + 300000 } : null;
    if (review) reviews.unshift(review); return route.fulfill({ json: { ...info, review } });
  });
  await page.route(`**/api/chats/${chat.id}/logout/confirm`, route => {
    const input = route.request().postDataJSON(); calls.confirm.push(input); const item = reviews.find(item => item.id === input.id); item.state = "completed"; return route.fulfill({ json: item });
  });
  for (const tail of ["messages", "queue", "stop"]) await page.route(`**/api/chats/${chat.id}/${tail}`, route => { calls.inputs.push(tail); return route.fulfill({ json: { chat: snapshot } }); });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  return { chat, snapshot, info, reviews, calls };
}
async function open(page) {
  await page.locator("#message-input").fill("/logout"); await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(page.locator("#controls-title")).toHaveText("Sign out of native Codex");
  await expect(page.locator("#controls-content [role=status]")).toContainText("Saved status refreshed");
}
async function inspect(page) {
  await page.getByRole("button", { name: "Inspect native account", exact: true }).click();
  await expect(page.locator("#controls-content [role=status]")).toContainText("Review the account");
}

test("sign-out requires native review and confirmation, displays literal account text and preserves draft/files", async ({ page }) => {
  const f = await setup(page);
  await page.locator("#attachment-input").setInputFiles({ name: "keep.txt", mimeType: "text/plain", buffer: Buffer.from("Keep this attachment") });
  await expect(page.locator("#attachment-chips")).toContainText("keep.txt"); await open(page); expect(f.calls.inspect).toBe(0); expect(f.calls.confirm).toEqual([]);
  await inspect(page); await expect(page.locator(".native-logout-confirm")).toContainText(f.info.account.email); await expect(page.locator(".native-logout-confirm img")).toHaveCount(0);
  await expect(page.locator(".native-logout-confirm")).toContainText("Queued messages will be paused");
  await page.getByRole("button", { name: "Cancel sign-out", exact: true }).click(); await expect(page.locator(".native-logout-confirm")).toBeHidden(); expect(f.calls.confirm).toEqual([]);
  await inspect(page); await page.locator("#message-input").evaluate(input => { input.value = "My unrelated draft"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.screenshot({ path: "test-results/native-logout-confirm.png" });
  await page.getByRole("button", { name: "Clear native credentials", exact: true }).click();
  await expect(page.locator("#controls-content [role=status]")).toContainText("cleared and verified");
  await expect(page.locator("#controls-content [role=status]")).toContainText("gateway access and your Relay login are unchanged");
  expect(f.calls.confirm).toEqual([{ id: "review-2", revision: "revision-2", threadId: f.snapshot.agentSessionId, confirm: true }]);
  await expect(page.locator("#message-input")).toHaveValue("My unrelated draft"); await expect(page.locator("#attachment-chips")).toContainText("keep.txt"); expect(f.calls.inputs).toEqual([]);
});

test("shared/empty accounts cannot sign out and busy workers require a fresh idle inspection", async ({ page }) => {
  const f = await setup(page); f.info.busy = true; await open(page); await inspect(page);
  await expect(page.getByRole("button", { name: "Clear native credentials", exact: true })).toBeDisabled();
  await expect(page.locator(".native-logout-details")).toContainText("Wait for the chat");
  f.info.busy = false; await inspect(page); await expect(page.getByRole("button", { name: "Clear native credentials", exact: true })).toBeEnabled();
  f.info.canLogout = false; f.info.reason = "No stored native credentials are available to clear.";
  await page.getByRole("button", { name: "Inspect native account", exact: true }).click(); await expect(page.locator(".native-logout-details")).toContainText(f.info.reason); await expect(page.locator(".native-logout-confirm")).toBeHidden();
  f.info.privateProfile = false; f.info.reason = "Shared host sign-out is locked until company/profile isolation is complete.";
  await page.getByRole("button", { name: "Inspect native account", exact: true }).click(); await expect(page.locator(".native-logout-details")).toContainText("Shared host"); expect(f.calls.confirm).toEqual([]); expect(f.calls.inputs).toEqual([]);
});

test("mobile confirmation fits and unknown results cannot automatically repeat credential removal", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); const f = await setup(page); await open(page); await inspect(page);
  expect(await page.locator("#controls-dialog").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.getByRole("button", { name: "Clear native credentials", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/native-logout-mobile.png" }); let attempts = 0;
  await page.route(`**/api/chats/${f.chat.id}/logout/confirm`, route => { attempts++; f.reviews[0].state = "uncertain"; return route.fulfill({ status: 502, json: { error: "Connection lost" } }); });
  await page.getByRole("button", { name: "Clear native credentials", exact: true }).click(); await expect(page.locator("#controls-content [role=status]")).toContainText("will not be retried");
  await expect(page.locator(".native-logout-confirm")).toBeHidden(); await page.getByRole("button", { name: "Refresh saved status", exact: true }).click();
  await expect(page.locator(".native-logout-history")).toContainText("outcome uncertain"); expect(attempts).toBe(1); expect(f.calls.inputs).toEqual([]);
});

test("late discovery or sign-out acknowledgement cannot overwrite a newer panel/draft", async ({ page }) => {
  const f = await setup(page), entered = Promise.withResolvers(), release = Promise.withResolvers(); let first = true;
  await page.route(`**/api/chats/${f.chat.id}/logout/inspect`, async route => {
    if (!first) return route.fallback(); first = false; entered.resolve(); await release.promise; return route.fulfill({ json: { ...f.info, account: { type: "apiKey" }, canLogout: false, review: null, reason: "Old result" } });
  });
  await open(page); await page.getByRole("button", { name: "Inspect native account", exact: true }).click(); await entered.promise;
  await page.locator("#controls-dialog").evaluate(dialog => dialog.close()); await open(page); await inspect(page); release.resolve();
  await expect(page.locator(".native-logout-confirm")).toContainText(f.info.account.email);
  const confirming = Promise.withResolvers(), confirmed = Promise.withResolvers();
  await page.route(`**/api/chats/${f.chat.id}/logout/confirm`, async route => { confirming.resolve(); await confirmed.promise; return route.fulfill({ json: { ...f.reviews[0], state: "completed" } }); });
  await page.getByRole("button", { name: "Clear native credentials", exact: true }).click(); await confirming.promise;
  await page.locator("#controls-dialog").evaluate(dialog => dialog.close()); await open(page);
  await page.locator("#message-input").evaluate(input => { input.value = "New draft"; }); confirmed.resolve();
  await expect(page.locator("#toasts")).toContainText(`${f.chat.title}: Native credentials cleared`);
  await expect(page.locator("#controls-content [role=status]")).toContainText("Saved status refreshed"); await expect(page.locator("#message-input")).toHaveValue("New draft"); expect(f.calls.inputs).toEqual([]);
});
