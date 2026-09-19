import { test, expect } from "@playwright/test";
const created = [];
test.setTimeout(60000);
test.use({ deviceScaleFactor: 2 });
test.afterEach(async ({ request }) => { for (const id of created.splice(0)) await request.delete(`/api/chats/${id}`); });
async function openTools(page) {
  if (!await page.locator("#browser-tools").evaluate(node => node.open)) await page.getByLabel("Browser tools", { exact: true }).click();
}

test("shared Chrome renders in the third column and accepts mouse and keyboard input with live updates", async ({ page, request }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const { chat } = await (await request.post("/api/chats", { data: { agent: "mock", title: "Browser visual test" } })).json(); created.push(chat.id);
  await page.goto(`/#chat=${chat.id}`);
  await page.getByLabel("Open shared Chrome", { exact: true }).click();
  await expect(page.locator("#browser-status")).toContainText("Live ·", { timeout: 20000 });
  await page.getByLabel("Browser address", { exact: true }).fill("http://localhost:8883");
  await page.locator("#browser-address-form").getByRole("button", { name: "Go", exact: true }).click();
  await expect(page.getByLabel("Browser tabs", { exact: true })).toContainText("Live development fixture");
  await expect(page.locator("#browser-open-direct")).toHaveAttribute("href", `http://${chat.id}.localhost:8883/`);
  const canvas = page.locator("#browser-canvas"); await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  const geometry = await page.evaluate(() => Object.fromEntries(["sidebar", "conversation", "browser-panel"].map(id => { const b = document.getElementById(id).getBoundingClientRect(); return [id, { left: b.left, right: b.right }]; })));
  expect(geometry.sidebar.right).toBeLessThanOrEqual(geometry.conversation.left);
  expect(geometry.conversation.right).toBeLessThanOrEqual(geometry["browser-panel"].left + 1);
  const color = () => canvas.evaluate(node => [...node.getContext("2d").getImageData(10, 10, 1, 1).data]);
  await expect(canvas).toHaveAttribute("width", "2560"); await expect(canvas).toHaveAttribute("height", "1600");
  await expect(canvas).toHaveAttribute("data-frame-format", "image/png");
  await expect.poll(color).toEqual([237, 244, 255, 255]);
  await canvas.hover({ position: { x: box.width * 60 / 1280, y: box.height * 120 / 800 } });
  await expect.poll(async () => (await (await request.get("http://127.0.0.1:8883/observed")).json()).hovered).toBe(true);
  await canvas.click({ position: { x: box.width * 60 / 1280, y: box.height * 120 / 800 } });
  await expect.poll(async () => (await (await request.get("http://127.0.0.1:8883/observed")).json()).clicks).toBe(1);
  await canvas.click({ position: { x: box.width * 60 / 1280, y: box.height * 180 / 800 } });
  await page.keyboard.type("Typed from my Chrome");
  await expect.poll(async () => (await (await request.get("http://127.0.0.1:8883/observed")).json()).text).toBe("Typed from my Chrome");
  await canvas.click({ position: { x: box.width * 500 / 1280, y: box.height * 500 / 800 } });
  await page.keyboard.press("Escape"); await expect(page.getByLabel("Browser address", { exact: true })).toBeFocused();
  await openTools(page); await page.locator("#browser-viewport").selectOption("390x844");
  await expect(canvas).toHaveAttribute("width", "780"); await expect(canvas).toHaveAttribute("height", "1688");
  await expect(canvas).toHaveAttribute("data-viewport-width", "390");
  await expect(canvas).toHaveAttribute("data-frame-format", "image/png");
  await page.getByLabel("Expand browser", { exact: true }).click();
  expect((await canvas.boundingBox()).width).toBe(390);
  await canvas.click({ position: { x: 60, y: 120 } });
  await expect.poll(async () => (await (await request.get("http://127.0.0.1:8883/observed")).json()).clicks).toBe(2);
  await page.screenshot({ path: "test-results/shared-browser-xs-sharp.png", fullPage: true });
  await page.getByLabel("Expand browser", { exact: true }).click();
  for (const [width, height] of [[320, 640], [640, 960], [834, 1112], [1920, 1080], [1280, 800]]) {
    await openTools(page);
    await page.locator("#browser-viewport").selectOption(`${width}x${height}`);
    await expect(canvas).toHaveAttribute("data-viewport-width", String(width));
    await expect(canvas).toHaveAttribute("width", String(width * 2));
    await expect(canvas).toHaveAttribute("height", String(height * 2));
  }
  await page.locator("#browser-viewport").selectOption("custom");
  await page.locator("#browser-width").fill("480"); await page.locator("#browser-height").fill("640");
  await page.getByRole("button", { name: "Apply size", exact: true }).click();
  await expect(canvas).toHaveAttribute("width", "960"); await expect(canvas).toHaveAttribute("height", "1280");
  await page.locator("#browser-viewport").selectOption("1280x800"); await expect(canvas).toHaveAttribute("width", "2560");
  await page.getByLabel("Browser tools", { exact: true }).press("Escape");
  await request.post("http://127.0.0.1:8883/refresh");
  await expect.poll(async () => (await (await request.get("http://127.0.0.1:8883/observed")).json()).live).toBe("Updated live");
  await page.screenshot({ path: "test-results/shared-browser-desktop.png", fullPage: true });
  await page.getByLabel("Expand browser", { exact: true }).click(); await expect(page.locator("#browser-panel")).toHaveClass(/expanded/);
  await page.getByLabel("Close browser panel", { exact: true }).click();
  await expect(page.locator("#browser-panel")).not.toBeVisible();
  expect((await (await request.get(`/api/chats/${chat.id}`)).json()).chat.messages).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Open shared Chrome", { exact: true }).click(); await expect(page.locator("#browser-status")).toContainText("Live ·");
  expect(await page.locator("#browser-panel").evaluate(node => node.getBoundingClientRect().right)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/shared-browser-mobile.png", fullPage: true });
  await openTools(page); await page.getByRole("button", { name: "Stop Chrome", exact: true }).click(); await expect(page.locator("#browser-status")).toContainText("Chrome stopped");
  expect(errors).toEqual([]);
});

test("the direct preview opens the app in a separate native browser tab with a chat-specific hostname", async ({ page, request, context }) => {
  const { chat } = await (await request.post("/api/chats", { data: { agent: "mock", title: "Direct preview fixture" } })).json(); created.push(chat.id);
  await page.goto(`/#chat=${chat.id}`); await page.getByLabel("Open shared Chrome", { exact: true }).click();
  await expect(page.locator("#browser-status")).toContainText("Live ·", { timeout: 20000 });
  await page.getByLabel("Browser address", { exact: true }).fill("http://localhost:8883/example/path?fixture=1#section");
  await openTools(page);
  const link = page.getByRole("link", { name: "Open directly ↗", exact: true });
  await expect(link).toHaveAttribute("href", `http://${chat.id}.localhost:8883/example/path?fixture=1#section`);
  const [direct] = await Promise.all([context.waitForEvent("page"), link.click()]);
  try {
    await expect(direct.getByRole("heading", { name: "Live development fixture" })).toBeVisible();
    expect(new URL(direct.url()).hostname).toBe(`${chat.id}.localhost`);
    expect(await direct.evaluate(() => window.opener === null)).toBe(true);
    await direct.getByRole("button", { name: "Clicks: 0", exact: true }).click();
    await expect(direct.getByRole("button", { name: "Clicks: 1", exact: true })).toBeVisible();
    expect((await (await request.get(`/api/chats/${chat.id}`)).json()).chat.messages).toEqual([]);
  } finally { await direct.close(); }
});

async function openFixture(page, request, title) {
  const { chat } = await (await request.post("/api/chats", { data: { agent: "mock", title } })).json(); created.push(chat.id);
  await page.goto(`/#chat=${chat.id}`);
  await expect(page.locator("#new-chat-button")).toBeEnabled({ timeout: 15000 });
  await expect(page.locator("#chat-title")).toHaveText(title);
  await page.getByLabel("Open shared Chrome", { exact: true }).click();
  await expect(page.locator("#browser-status")).toContainText("Live ·", { timeout: 20000 });
  await page.getByLabel("Browser address", { exact: true }).fill("http://localhost:8883");
  await page.locator("#browser-address-form").getByRole("button", { name: "Go", exact: true }).click();
  await expect(page.locator("#browser-tabs")).toContainText("Live development fixture");
  const canvas = page.locator("#browser-canvas"); await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute("data-viewport-width", "1280");
  return { chat, canvas, observed: async () => (await (await request.get("http://127.0.0.1:8883/observed")).json()) };
}

test("F5 and Ctrl+R reload only the focused remote page, never Relay", async ({ page, request }) => {
  const { canvas, observed } = await openFixture(page, request, "Remote reload fixture");
  await page.evaluate(() => { window.relayReloadSentinel = "still here"; });
  for (const shortcut of ["F5", "Control+r", "Control+Shift+r"]) {
    await canvas.focus(); const loads = (await observed()).loads;
    await page.keyboard.press(shortcut);
    await expect.poll(async () => (await observed()).loads).toBeGreaterThan(loads);
    expect(await page.evaluate(() => window.relayReloadSentinel)).toBe("still here");
  }
});

test("remote plain-text clipboard supports native shortcuts and toolbar without sending chat messages", async ({ page, request, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const { canvas, observed, chat } = await openFixture(page, request, "Remote clipboard fixture");
  const box = await canvas.boundingBox();
  await canvas.click({ position: { x: box.width * 80 / 1280, y: box.height * 180 / 800 } });
  await page.keyboard.type("Selected remote fixture");
  await page.keyboard.press("Control+a"); await page.keyboard.press("Control+c");
  await expect(page.locator("#browser-status")).toHaveText("Selected text copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Selected remote fixture");
  await expect.poll(async () => (await observed()).text).toBe("Selected remote fixture");
  await page.evaluate(() => navigator.clipboard.writeText("Pasted from this browser"));
  await page.keyboard.press("Control+v");
  await expect.poll(async () => (await observed()).text).toBe("Pasted from this browser");
  await page.keyboard.press("Control+a");
  await openTools(page);
  await page.getByRole("button", { name: "Copy text", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("Pasted from this browser");
  await page.evaluate(() => navigator.clipboard.writeText("Toolbar paste fixture"));
  await page.getByRole("button", { name: "Paste text", exact: true }).click();
  await expect.poll(async () => (await observed()).text).toBe("Toolbar paste fixture");
  await expect(canvas).toBeFocused();
  expect((await (await request.get(`/api/chats/${chat.id}`)).json()).chat.messages).toEqual([]);
  expect(errors).toEqual([]);
});

test("clipboard denial and oversized paste are visible failures, not silent truncation", async ({ page, request }) => {
  const { canvas, observed } = await openFixture(page, request, "Clipboard failure fixture");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: () => Promise.reject(new DOMException("denied", "NotAllowedError")), write: () => Promise.reject(new DOMException("denied", "NotAllowedError")) } });
  });
  await openTools(page);
  await page.getByRole("button", { name: "Paste text", exact: true }).click();
  await expect(page.locator("#browser-status")).toContainText("Clipboard access denied");
  const previous = (await observed()).text;
  await canvas.evaluate(node => {
    const data = new DataTransfer(); data.setData("text/plain", "x".repeat(30001));
    node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(page.locator("#browser-status")).toContainText("Nothing was pasted");
  expect((await observed()).text).toBe(previous);
});

test("compact Chrome header keeps navigation visible and tools accessible on desktop and mobile", async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const { canvas, observed } = await openFixture(page, request, "Compact Chrome header fixture");
  const tools = page.locator("#browser-tools"), summary = page.getByLabel("Browser tools", { exact: true });
  const headerHeight = () => page.evaluate(() => document.querySelector("#browser-surface").getBoundingClientRect().top - document.querySelector("#browser-panel").getBoundingClientRect().top);
  await expect(tools).not.toHaveAttribute("open", "");
  expect(await headerHeight()).toBeLessThan(150);
  await expect(page.locator("#browser-viewport")).toBeHidden();
  await expect(page.getByLabel("Browser tabs", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Browser address", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("chrome-desktop-compact.png"), animations: "disabled" });
  await summary.focus(); await page.keyboard.press("Enter");
  await expect(page.locator("#browser-viewport")).toBeVisible();
  await expect(page.locator("#browser-copy-text")).toBeVisible();
  await expect(page.locator("#browser-paste-text")).toBeVisible();
  await expect(page.locator("#browser-open-direct")).toBeVisible();
  await page.locator("#browser-viewport").focus(); await page.keyboard.press("Escape");
  await expect(tools).not.toHaveAttribute("open", ""); await expect(summary).toBeFocused();
  await openTools(page); await page.getByLabel("Browser address", { exact: true }).click();
  await expect(tools).not.toHaveAttribute("open", "");
  const loads = (await observed()).loads;
  await page.getByLabel("Reload browser page", { exact: true }).click();
  await expect.poll(async () => (await observed()).loads).toBeGreaterThan(loads);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await headerHeight()).toBeLessThan(165);
  await expect(canvas).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("chrome-mobile-compact.png"), animations: "disabled" });
  await openTools(page); await page.locator("#browser-viewport").selectOption("custom");
  await expect(page.locator("#browser-width")).toBeFocused();
  await expect(page.locator("#browser-size-form")).toBeVisible();
  const popover = await page.locator(".browser-tools-popover").boundingBox();
  expect(popover.x).toBeGreaterThanOrEqual(0); expect(popover.x + popover.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("chrome-mobile-tools.png"), animations: "disabled" });
  await page.getByLabel("Close browser panel", { exact: true }).click();
  await page.getByLabel("Open shared Chrome", { exact: true }).click();
  await expect(tools).not.toHaveAttribute("open", "");
});
