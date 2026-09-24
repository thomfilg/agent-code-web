import { test, expect } from "@playwright/test";

const created = [];
test.afterEach(async ({ page, request }) => {
  await page.unrouteAll({ behavior: "wait" });
  for (const id of created.splice(0)) await request.delete(`/api/chats/${id}`);
});

async function fixture(page) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const { chat } = await (await page.request.post("/api/chats", { data: { agent: "mock", title: "Panel resize acceptance" } })).json();
  created.push(chat.id);
  const messages = [{ id: "resize-preview", role: "assistant", kind: "message", text: "```html\n<h1>Resize fixture</h1><p>One unchanged document.</p>\n```" }];
  await page.route(`**/api/chats/${chat.id}`, route => route.request().method() === "GET" ? route.fulfill({ json: { chat: { ...chat, messages } } }) : route.continue());
  await page.route(`**/api/chats/${chat.id}/events*`, route => route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }));
  const actions = [];
  page.on("request", request => {
    const pathname = new URL(request.url()).pathname;
    // Visibility heartbeats are expected; layout must not send prompts or
    // start/stop a browser, worker or native conversation.
    if (request.method() !== "GET" && pathname.startsWith(`/api/chats/${chat.id}/`) && !pathname.endsWith("/presence")) actions.push(pathname);
  });
  await page.goto(`/?fixture=${chat.id}#chat=${chat.id}`);
  await expect(page.locator("#chat-title")).toHaveText(chat.title);
  return actions;
}

const width = locator => locator.evaluate(element => element.getBoundingClientRect().width);
async function nearWidth(locator, expected) {
  await expect.poll(async () => Math.abs(await width(locator) - expected)).toBeLessThan(2);
}
async function withinViewport(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

test("sidebar pointer resize persists after reload and reset restores default without sending", async ({ page }) => {
  const actions = await fixture(page), sidebar = page.locator("#sidebar");
  const handle = page.getByRole("separator", { name: "Resize sidebar", exact: true });
  const original = await width(sidebar);
  await page.locator("#message-input").fill("Keep this unsent draft");
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, 220); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 90, 220, { steps: 8 }); await page.mouse.up();
  await nearWidth(sidebar, original + 90);
  await expect(handle).toHaveAttribute("aria-valuenow", String(Math.round(original + 90)));
  await expect(page.locator("#message-input")).toHaveValue("Keep this unsent draft");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("relay-panel-layout-v1")).sidebar)).toBeCloseTo(original + 90, 0);
  await withinViewport(page);
  await page.reload(); await expect(page.locator("#chat-title")).toHaveText("Panel resize acceptance");
  await nearWidth(sidebar, original + 90);
  await handle.dblclick(); await nearWidth(sidebar, original);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("relay-panel-layout-v1")).sidebar)).toBeUndefined();
  expect(actions).toEqual([]);
});

test("keyboard resizing shares space with conversation, clamps bounds and hides handles on mobile", async ({ page }) => {
  const actions = await fixture(page);
  await page.getByRole("button", { name: "Open HTML preview ↗" }).click();
  const panel = page.locator("#preview-panel"), conversation = page.locator("#conversation");
  const handle = page.getByRole("separator", { name: "Resize workspace panel", exact: true });
  await expect(handle).toBeVisible(); await expect(handle).toHaveAttribute("aria-controls", "conversation preview-panel");
  await expect(page.frameLocator("#preview-content iframe").locator("h1")).toHaveText("Resize fixture");
  const original = await width(panel), originalChat = await width(conversation);
  await page.locator("#message-input").fill("Draft survives layout changes");
  await handle.focus(); await page.keyboard.press("ArrowLeft");
  await nearWidth(panel, original + 20); await nearWidth(conversation, originalChat - 20);
  await page.keyboard.press("Home"); await nearWidth(panel, 280);
  await page.keyboard.press("End"); await nearWidth(panel, Number(await handle.getAttribute("aria-valuemax")));
  expect(await width(conversation)).toBeGreaterThanOrEqual(339);
  await withinViewport(page);
  await handle.dblclick(); await nearWidth(panel, original);
  const sidebar = page.getByRole("separator", { name: "Resize sidebar", exact: true });
  await sidebar.focus(); await page.keyboard.press("Home"); await nearWidth(page.locator("#sidebar"), 200);
  await page.keyboard.press("End"); await nearWidth(page.locator("#sidebar"), 460);
  await withinViewport(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#sidebar-resizer")).toBeHidden(); await expect(page.locator("#workspace-resizer")).toBeHidden();
  await withinViewport(page);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(handle).toBeVisible(); await nearWidth(page.locator("#sidebar"), 460);
  await expect(page.locator("#message-input")).toHaveValue("Draft survives layout changes");
  await expect(page.frameLocator("#preview-content iframe").locator("h1")).toHaveText("Resize fixture");
  expect(actions).toEqual([]);
});
