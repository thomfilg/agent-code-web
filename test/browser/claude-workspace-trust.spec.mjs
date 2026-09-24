import { test, expect } from "@playwright/test";

const created = new WeakMap();
test.afterEach(async ({ page }) => { for (const id of created.get(page) || []) await page.request.delete(`/api/chats/${id}`); });
async function fixture(page) {
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "claude", title: `Trust review ${Date.now()}` } })).json(); created.set(page, [chat.id]);
  const f = { chat, calls: [], prompts: [], stops: [], errors: [], result: { state: "needs_trust", directory: "/private/worker/project with spaces/ação", trustRoot: null, reviewId: "review-fixture", expiresAt: Date.now() + 300000 } };
  page.on("pageerror", error => f.errors.push(error.message));
  await page.route(`**/api/chats/${chat.id}/workspace-trust/*`, async route => {
    const action = route.request().url().split("/").pop(); f.calls.push({ action, input: route.request().postDataJSON() }); f.entered?.resolve(); await f.hold;
    if (f.failure) return route.fulfill({ status: 409, json: { error: f.failure } });
    return route.fulfill({ json: action === "inspect" ? f.result : { ...f.result, state: "trusted", reviewId: null, expiresAt: null } });
  });
  for (const tail of ["queue", "messages"]) await page.route(`**/api/chats/${chat.id}/${tail}`, route => { f.prompts.push(route.request().postDataJSON()); return route.fulfill({ json: {} }); });
  await page.route(`**/api/chats/${chat.id}/stop`, route => { f.stops.push(true); return route.fulfill({ json: { chat } }); });
  await page.goto(`/#chat=${chat.id}`); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  return f;
}
async function open(page) {
  await page.getByLabel("Chat settings", { exact: true }).click(); await page.locator("#workspace-trust-button").click();
  await expect(page.locator("#controls-title")).toHaveText("Claude workspace trust");
}
const inspect = page => page.getByRole("button", { name: "Inspect workspace trust", exact: true }).click();
const checkbox = page => page.getByRole("checkbox", { name: /I trust the workspace shown above/ });
const confirm = page => page.getByRole("button", { name: "Trust this workspace", exact: true });

for (const width of [1280, 320]) test(`explicit Claude workspace trust at ${width}px preserves drafts/files and never sends a prompt or restarts work`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 }); const f = await fixture(page);
  await page.getByLabel("Message", { exact: true }).fill("Keep this unsent draft — ação");
  await page.locator("#attachment-input").setInputFiles({ name: "trust-context.txt", mimeType: "text/plain", buffer: Buffer.from("Keep this file") });
  await expect(page.locator("#attachment-chips")).toContainText("trust-context.txt");
  await open(page); expect(f.calls).toEqual([]); await inspect(page); await expect(confirm(page)).toBeDisabled();
  await expect(page.locator("#controls-content")).toContainText(f.result.directory); await expect(page.locator("#controls-content")).toContainText("hooks and other project code");
  await checkbox(page).check(); await expect(confirm(page)).toBeEnabled();
  expect(await page.locator("#controls-dialog").evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: `test-results/claude-workspace-trust-${width}.png` });
  await page.getByRole("button", { name: "Cancel workspace trust", exact: true }).click(); expect(f.calls.map(call => call.action)).toEqual(["inspect"]);
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keep this unsent draft — ação");
  await open(page); await inspect(page); await expect(checkbox(page)).not.toBeChecked(); await checkbox(page).check(); await confirm(page).click();
  await expect(page.locator("#controls-content [role=status]")).toContainText("Native workspace trust is saved");
  expect(f.calls.at(-1)).toEqual({ action: "confirm", input: { reviewId: "review-fixture", confirm: true } }); await expect(checkbox(page)).toHaveCount(0);
  expect(f.prompts).toEqual([]); expect(f.stops).toEqual([]); expect(f.errors).toEqual([]);
  await page.locator("#controls-dialog").press("Escape"); await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keep this unsent draft — ação");
  await expect(page.locator("#attachment-chips")).toContainText("trust-context.txt");
});

test("trust expiry, shared-host refusal and stale confirmation require a new review without automatic retry", async ({ page }) => {
  const f = await fixture(page); f.failure = "Shared host profiles remain locked; no worker was started.";
  await open(page); await inspect(page); await expect(page.locator("#controls-content [role=status]")).toContainText("Shared host profiles remain locked"); await expect(confirm(page)).toHaveCount(0);
  f.failure = null; f.result.expiresAt = Date.now() - 1; await inspect(page);
  await expect(page.locator("#controls-content [role=status]")).toContainText("review expired"); await expect(confirm(page)).toHaveCount(0);
  f.result.expiresAt = Date.now() + 300000; await inspect(page); await checkbox(page).check();
  f.failure = "Workspace trust confirmation is stale."; await confirm(page).click();
  await expect(page.locator("#controls-content [role=status]")).toContainText("confirmation is stale"); await expect(confirm(page)).toHaveCount(0);
  expect(f.calls.filter(call => call.action === "confirm")).toHaveLength(1); expect(f.prompts).toEqual([]); expect(f.stops).toEqual([]); expect(f.errors).toEqual([]);
});

test("a delayed trust review cannot appear in another chat or confer consent after closing", async ({ page }) => {
  const f = await fixture(page), release = Promise.withResolvers(); f.hold = release.promise; f.entered = Promise.withResolvers();
  await open(page); await inspect(page); await f.entered.promise; await page.locator("#controls-dialog").press("Escape");
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "mock", title: "Other trust chat" } })).json(); created.get(page).push(chat.id);
  await page.getByRole("button", { name: `Open ${chat.title}`, exact: true }).click(); await expect(page.locator("#chat-title")).toHaveText(chat.title);
  await page.getByLabel("Message", { exact: true }).fill("Another private draft");
  const response = page.waitForResponse(result => result.url().endsWith(`/api/chats/${f.chat.id}/workspace-trust/inspect`)); release.resolve(); await response;
  await expect(page.locator("#controls-dialog")).not.toBeVisible(); await expect(page.locator("#workspace-trust-button")).toBeHidden();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Another private draft"); expect(f.calls.map(call => call.action)).toEqual(["inspect"]); expect(f.errors).toEqual([]);
});

test("closing a submitted trust confirmation does not claim cancellation or retry it", async ({ page }) => {
  const f = await fixture(page); await open(page); await inspect(page); await checkbox(page).check();
  const release = Promise.withResolvers(); f.hold = release.promise; f.entered = Promise.withResolvers();
  await confirm(page).click(); await f.entered.promise;
  await expect(page.locator("#controls-content [role=status]")).toContainText("does not cancel or undo");
  await expect(page.getByRole("button", { name: "Cancel workspace trust", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Close review", exact: true }).click();
  await page.getByLabel("Message", { exact: true }).fill("Unsent after confirmation");
  const response = page.waitForResponse(result => result.url().endsWith(`/api/chats/${f.chat.id}/workspace-trust/confirm`)); release.resolve(); await response;
  await expect(page.locator("#controls-dialog")).not.toBeVisible(); await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Unsent after confirmation");
  expect(f.calls.filter(call => call.action === "confirm")).toHaveLength(1); expect(f.prompts).toEqual([]); expect(f.stops).toEqual([]); expect(f.errors).toEqual([]);
});
