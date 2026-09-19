import { test, expect } from "@playwright/test";

const created = [];
test.setTimeout(60000);
test.afterEach(async ({ request }) => { for (const id of created.splice(0)) await request.delete(`/api/chats/${id}`); });
async function chatFixture(page, request, title) {
  const { chat } = await (await request.post("/api/chats", { data: { agent: "mock", title } })).json(); created.push(chat.id);
  await page.goto(`/#chat=${chat.id}`);
  await expect(page.locator("#chat-title")).toHaveText(title, { timeout: 15000 });
  return chat;
}

test("wake gives immediate feedback, preserves the draft and sends no agent input", async ({ page, request }) => {
  const errors = [], inputs = []; page.on("pageerror", error => errors.push(error.message));
  page.on("request", req => { if (req.method() === "POST" && /\/api\/chats\/[^/]+\/(messages|queue)$/.test(new URL(req.url()).pathname)) inputs.push(req.url()); });
  await page.setViewportSize({ width: 1440, height: 900 });
  const chat = await chatFixture(page, request, "Wake without a prompt"), release = Promise.withResolvers(); let calls = 0;
  await page.route(`**/api/chats/${chat.id}/wake`, async route => { calls++; await release.promise; await route.continue(); });
  const wake = page.getByRole("button", { name: "Wake environment", exact: true });
  await expect(wake).toBeEnabled(); await page.locator("#message-input").fill("Keep this unsent draft");
  await wake.click(); await expect(page.locator("#wake-worker")).toHaveText("Waking…");
  await expect(page.locator("#wake-worker")).toBeDisabled(); await expect(page.locator("#wake-worker")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#send-button")).toBeDisabled(); await expect(page.locator("#message-input")).toBeEnabled();
  await page.locator("#composer").evaluate(form => form.requestSubmit()); expect(inputs).toEqual([]);
  await page.locator("#wake-worker").evaluate(button => button.click()); expect(calls).toBe(1);
  await page.screenshot({ path: "test-results/runtime-wake-starting-desktop.png" });
  release.resolve(); await expect(page.locator("#runtime-status")).toHaveText("Ready");
  await expect(page.locator("#runtime-detail")).toContainText("no message sent");
  await expect(page.locator("#message-input")).toHaveValue("Keep this unsent draft");
  expect(inputs).toEqual([]); expect((await (await request.get(`/api/chats/${chat.id}`)).json()).chat.messages).toEqual([]);
  await page.setViewportSize({ width: 320, height: 740 });
  if (await page.locator("#sidebar").evaluate(node => node.classList.contains("open"))) await page.locator("#close-sidebar").click();
  await expect.poll(() => page.locator("#sidebar").evaluate(node => node.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: "test-results/runtime-wake-ready-mobile.png" });
  expect(await page.locator("#runtime-banner").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("wake reconnects an open shared browser after Stop without an agent turn", async ({ page, request }) => {
  const chat = await chatFixture(page, request, "Wake an open browser");
  await page.getByLabel("Open shared Chrome", { exact: true }).click();
  await expect(page.locator("#browser-status")).toContainText("Live ·", { timeout: 20000 });
  await request.post(`/api/chats/${chat.id}/stop`, { data: {} });
  await expect(page.locator("#browser-connect")).toBeVisible();
  await expect(page.locator("#wake-worker")).toBeEnabled();
  await page.locator("#wake-worker").click();
  await expect(page.locator("#runtime-status")).toHaveText("Ready");
  await expect(page.locator("#browser-status")).toContainText("Live ·", { timeout: 20000 });
  await expect(page.locator("#browser-canvas")).toBeVisible();
  expect((await (await request.get(`/api/chats/${chat.id}`)).json()).chat.messages).toEqual([]);
});

test("failed wake can be retried and a late reply cannot replace another chat", async ({ page, request }) => {
  const chat = await chatFixture(page, request, "Wake retry fixture");
  await page.route(`**/api/chats/${chat.id}/wake`, route => route.fulfill({ status: 503, json: { error: "Fixture wake unavailable" } }));
  await page.locator("#wake-worker").click(); await expect(page.getByText("Fixture wake unavailable", { exact: true })).toBeVisible();
  await expect(page.locator("#wake-worker")).toBeEnabled();
  await page.unroute(`**/api/chats/${chat.id}/wake`);
  const release = Promise.withResolvers();
  await page.route(`**/api/chats/${chat.id}/wake`, async route => { await release.promise; await route.fulfill({ status: 202, json: { chat: { ...chat, status: "starting", revision: 999 }, accepted: true } }); });
  await page.locator("#wake-worker").click(); await expect(page.locator("#wake-worker")).toHaveText("Waking…");
  await page.getByRole("button", { name: "Open Existing alpha", exact: true }).click();
  await expect(page.locator("#chat-title")).toHaveText("Existing alpha");
  release.resolve(); await expect(page.locator("#wake-worker")).toHaveText("Wake environment");
  await expect(page.locator("#chat-title")).toHaveText("Existing alpha");
});

test("delete immediately shows progress, prevents repeats and keeps a failed deletion visible", async ({ page, request }) => {
  const chat = await chatFixture(page, request, "Delayed deletion"), release = Promise.withResolvers(); let deletes = 0;
  await page.route(`**/api/chats/${chat.id}`, async route => {
    if (route.request().method() !== "DELETE") return route.continue();
    deletes++; await release.promise; await route.fulfill({ status: 503, json: { error: "Worker stop failed; chat retained" } });
  });
  page.on("dialog", dialog => dialog.accept());
  await page.getByLabel("Chat settings", { exact: true }).click();
  await page.locator("#delete-button").click();
  await expect(page.locator("#runtime-detail")).toContainText("Deleting chat");
  await expect(page.locator("#delete-button")).toBeDisabled(); await expect(page.locator("#wake-worker")).toBeDisabled();
  const row = page.locator(`.chat-row[data-chat-id="${chat.id}"]`);
  await expect(row).toHaveAttribute("aria-busy", "true"); await expect(row).toContainText("Deleting…");
  await page.locator("#delete-button").evaluate(button => button.click()); expect(deletes).toBe(1);
  release.resolve(); await expect(page.getByText("Worker stop failed; chat retained", { exact: true })).toBeVisible();
  await expect(page.locator("#delete-button")).toBeEnabled(); await expect(row).toHaveAttribute("aria-busy", "false");
  expect((await request.get(`/api/chats/${chat.id}`)).status()).toBe(200);
  await page.unroute(`**/api/chats/${chat.id}`); await page.getByLabel("Chat settings", { exact: true }).click(); await page.locator("#delete-button").click();
  await expect(page.locator(`.chat-row[data-chat-id="${chat.id}"]`)).toHaveCount(0);
  expect((await request.get(`/api/chats/${chat.id}`)).status()).toBe(404);
});
