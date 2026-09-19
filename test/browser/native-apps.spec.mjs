import { test, expect } from "@playwright/test";

const chats = new WeakMap();
test.afterEach(async ({ page }) => { for (const id of chats.get(page) || []) await page.request.delete(`/api/chats/${id}`); });
async function setup(page) {
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "codex", title: `App picker ${Date.now()}` } })).json();
  chats.set(page, [...chats.get(page) || [], chat.id]);
  const snapshot = { ...chat, revision: 999999, status: "running", agentSessionId: "native-apps-fixture", messages: [] };
  const sent = [], calls = [];
  await page.route(`**/api/chats/${chat.id}`, route => route.request().method() === "GET" ? route.fulfill({ json: { chat: snapshot } }) : route.fallback());
  await page.route(`**/api/chats/${chat.id}/events`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  const catalog = { threadId: snapshot.agentSessionId, apps: [
    { id: "app_fixture", name: "Fixture App", description: "An existing native connection", token: "$fixture-app", accessible: true, enabled: true, callable: true },
    { id: "app_policy", name: "Policy App", description: "Not allowed by current policy", token: "$policy-app", accessible: true, enabled: true, callable: false },
    { id: "app_unlinked", name: "Unlinked App", description: "Not connected", token: "$unlinked-app", accessible: false, enabled: false, callable: false },
  ], truncated: false };
  await page.route(`**/api/chats/${chat.id}/apps`, route => { calls.push("list"); return route.fulfill({ json: catalog }); });
  const selection = { token: "$fixture-app", attachment: { id: "file_12345678-1234-1234-1234-123456789abc", chatId: chat.id, name: "Fixture App", size: 0, mime: "application/x-relay-app-reference", appReference: { id: "app_fixture", name: "Fixture App", token: "$fixture-app", threadId: snapshot.agentSessionId, company: null, ownerId: null } } };
  await page.route(`**/api/chats/${chat.id}/apps/select`, route => { calls.push(route.request().postDataJSON()); return route.fulfill({ json: selection }); });
  for (const endpoint of ["queue", "messages"]) await page.route(`**/api/chats/${chat.id}/${endpoint}`, route => { sent.push({ endpoint, ...route.request().postDataJSON() }); return route.fulfill({ status: 202, json: { chat: snapshot } }); });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  return { chat, sent, calls, catalog, selection };
}
async function open(page) {
  await page.getByLabel("Message", { exact: true }).fill("/apps");
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(page.locator("#controls-title")).toHaveText("Codex apps");
}

test("native app picker searches, explains unavailable states and stages a reference without sending", async ({ page }) => {
  const { sent, calls } = await setup(page); await open(page);
  await expect(page.getByRole("button", { name: "Use Fixture App", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Use Policy App", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Use Unlinked App", exact: true })).toBeDisabled();
  await expect(page.locator("#controls-content")).toContainText("Not callable under this session’s policy");
  await page.screenshot({ path: "test-results/native-apps-picker.png" });
  await page.getByLabel("Find a native app").fill("fixture");
  await expect(page.locator(".native-app-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Refresh apps", exact: true }).click();
  await expect.poll(() => calls.filter(call => call === "list").length).toBe(2);
  await page.getByRole("button", { name: "Use Fixture App", exact: true }).click();
  await expect(page.locator("#controls-dialog")).not.toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("$fixture-app ");
  await expect(page.locator("#attachment-chips")).toContainText("Fixture App");
  expect(sent).toEqual([]); expect(calls.at(-1)).toEqual({ appId: "app_fixture", threadId: "native-apps-fixture" });
  await page.getByRole("button", { name: "Preview Fixture App", exact: true }).click();
  await expect(page.locator("#controls-content")).toContainText("not a copy of account credentials");
  await page.locator("#controls-dialog").press("Escape");
  await page.getByLabel("Message", { exact: true }).fill("Use $fixture-app to find my assigned issues");
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ endpoint: "queue", text: "Use $fixture-app to find my assigned issues", attachments: ["file_12345678-1234-1234-1234-123456789abc"] });
  await expect(page.locator("#attachment-chips")).toBeEmpty();
});

test("app selection errors preserve the draft and can be retried; the picker fits a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { chat, sent, selection } = await setup(page); let attempts = 0;
  await page.route(`**/api/chats/${chat.id}/apps/select`, route => ++attempts === 1
    ? route.fulfill({ status: 409, json: { error: "This app was disconnected; reconnect it before retrying." } }) : route.fulfill({ json: selection }));
  await open(page);
  await expect(page.getByRole("button", { name: "Use Fixture App", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
  await page.getByLabel("Message", { exact: true }).evaluate(input => { input.value = "Retained draft"; input.setSelectionRange(input.value.length, input.value.length); });
  await page.getByRole("button", { name: "Use Fixture App", exact: true }).click();
  await expect(page.locator("#controls-content")).toContainText("This app was disconnected");
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Retained draft");
  await expect(page.locator("#attachment-chips")).toBeEmpty(); expect(sent).toEqual([]);
  await page.getByRole("button", { name: "Use Fixture App", exact: true }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Retained draft $fixture-app ");
});

test("native chat header keeps its title and every action inside phone widths", async ({ page }, testInfo) => {
  await setup(page);
  for (const width of [320, 390, 430, 480]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator("#chat-title")).toBeInViewport({ ratio: 1 });
    for (const label of ["Open chats", "Open shared Chrome", "Open app preview", "Open side chat", "Open agent threads"]) await expect(page.getByRole("button", { name: label, exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.getByLabel("Chat settings", { exact: true })).toBeInViewport({ ratio: 1 });
    await page.getByLabel("Chat settings", { exact: true }).click();
    for (const label of ["View changes", "Copy private chat link"]) await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const title = await page.locator("#chat-title").boundingBox(); expect(title.width).toBeGreaterThan(100);
    if ([320, 390].includes(width)) await page.screenshot({ path: testInfo.outputPath(`native-chat-header-${width}.png`) });
  }
});

test("a delayed app selection cannot attach to or overwrite a different chat", async ({ page }) => {
  const { chat, selection, sent } = await setup(page), entered = Promise.withResolvers(), release = Promise.withResolvers();
  await page.route(`**/api/chats/${chat.id}/apps/select`, async route => { entered.resolve(); await release.promise; await route.fulfill({ json: selection }); });
  await open(page); await page.getByRole("button", { name: "Use Fixture App", exact: true }).click(); await entered.promise;
  await page.locator("#controls-dialog").press("Escape");
  await page.locator("#message-input").evaluate(input => { input.value = "Original chat draft"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  const { chat: other } = await (await page.request.post("/api/chats", { data: { agent: "codex", title: "Other app picker chat" } })).json();
  chats.set(page, [...chats.get(page), other.id]);
  await page.getByRole("button", { name: `Open ${other.title}`, exact: true }).click();
  await expect(page.locator("#chat-title")).toHaveText(other.title);
  await page.getByLabel("Message", { exact: true }).fill("Different chat draft");
  const response = page.waitForResponse(result => result.url().endsWith(`/api/chats/${chat.id}/apps/select`));
  release.resolve(); await response;
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Different chat draft");
  await expect(page.locator("#attachment-chips")).toBeEmpty(); expect(sent).toEqual([]);
  await page.getByRole("button", { name: `Open ${chat.title}`, exact: true }).click();
  await expect(page.locator("#attachment-chips")).not.toContainText("Uploading");
  await expect(page.locator("#attachment-chips")).toBeEmpty();
});
