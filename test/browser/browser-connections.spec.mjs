import { test, expect } from "@playwright/test";

async function expectNoHorizontalOverflow(dialog) {
  const dimensions = await dialog.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth,
    card: element.querySelector(".browser-connections-card").getBoundingClientRect().width }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1);
  expect(dimensions.card).toBeLessThanOrEqual(dimensions.width + 1);
  await expect(dialog.getByLabel("Close browser connections", { exact: true })).toBeInViewport();
}

for (const paired of [false, true]) test(`signed-in browser settings wrap ${paired ? "long profile names" : "pairing instructions"} without clipping or unnecessary scrolling`, async ({ page }, testInfo) => {
  const mutations = [], errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (/\/(browser-connections|browser\/access)(?:\/|$)/.test(new URL(request.url()).pathname) && request.method() !== "GET") mutations.push(request.method()); });
  await page.route("**/api/browser-account", route => route.fulfill({ json: { user: { id: "layout-fixture", username: "browser-layout@example.test" }, method: "google" } }));
  await page.route("**/api/browser-connections", route => route.fulfill({ json: { connections: paired ? [
    { id: "layout-profile", name: "Profile-" + "a".repeat(72), online: true, paired: true, sharedChatId: null },
  ] : [] } }));
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.goto("/");
  await page.locator("#browser-connections-button").click();
  const dialog = page.locator("#browser-connections-dialog");
  await expect(dialog).toContainText("Signed in as browser-layout@example.test");
  if (paired) await expect(dialog.locator(".browser-connection-row")).toContainText("Connected · agent access off");
  else await expect(dialog.locator("#browser-pair-instructions")).toHaveAttribute("open", "");
  await expectNoHorizontalOverflow(dialog);
  expect(await dialog.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.evaluate(element => { element.scrollTop = 0; });
  await expectNoHorizontalOverflow(dialog);
  const bounds = await dialog.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("mobile.png") });
  await dialog.getByLabel("Close browser connections", { exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(mutations).toEqual([]); expect(errors).toEqual([]);
});

test("signed-in Chrome stays off without consent and connection setup fits desktop and phone", async ({ page, request }) => {
  const { chat } = await (await request.post("/api/chats", { data: { agent: "mock", title: "Chrome permission UI" } })).json();
  try {
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`/#chat=${chat.id}`);
    await expect(page.getByRole("switch", { name: "Use my signed-in Chrome" })).not.toBeChecked();
    await page.locator(".signed-chrome-toggle").click();
    await expect(page.locator("#browser-connections-dialog")).toBeVisible();
    await expect(page.getByLabel("Account password", { exact: true })).toHaveAttribute("type", "password");
    await expect(page.locator("#browser-connections-dialog")).toContainText("not your Google password");
    await expect(page.locator("#signed-chrome-toggle")).not.toBeChecked();
    await expectNoHorizontalOverflow(page.locator("#browser-connections-dialog"));
    await page.screenshot({ path: "test-results/chrome-connections-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const dialog = await page.locator("#browser-connections-dialog").boundingBox();
    expect(dialog.x).toBeGreaterThanOrEqual(0); expect(dialog.x + dialog.width).toBeLessThanOrEqual(390);
    await expectNoHorizontalOverflow(page.locator("#browser-connections-dialog"));
    await expect(page.getByLabel("Close browser connections", { exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/chrome-connections-mobile.png", fullPage: true });
    await page.getByLabel("Close browser connections", { exact: true }).click();
    expect((await (await request.get(`/api/chats/${chat.id}/browser/access`)).json()).enabled).toBe(false);
    expect((await (await request.get(`/api/chats/${chat.id}/browser`)).json()).running).toBe(false);
    expect(errors).toEqual([]);
  } finally { await request.delete(`/api/chats/${chat.id}`); }
});
