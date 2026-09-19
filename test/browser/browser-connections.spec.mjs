import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

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
  await page.route("**/api/companies", route => route.fulfill({ json: { companies: [{ id: "acme", name: "Acme" }] } }));
  await page.route("**/api/browser-connections*", route => route.fulfill({ json: { connections: paired ? [
    { id: "layout-profile", companyId: "acme", name: "Profile-" + "a".repeat(72), online: true, paired: true, sharedChatId: null },
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

async function companyFixture(page, { scoped = false } = {}) {
  // Mount the real settings component in its real markup without another app
  // controller/timer or any authenticated browser profile.
  const html = (await readFile(new URL("../../public/index.html", import.meta.url), "utf8")).replace('<script type="module" src="app.js"></script>', "");
  const f = { writes: [], profiles: [
    { id: "browser-acme", companyId: "acme", name: "Acme Chrome", paired: true, online: true },
    { id: "browser-other", companyId: "other", name: "Other Chrome", paired: true, online: true },
    { id: "browser-legacy", companyId: null, name: "Saved legacy Chrome", paired: true, online: true },
  ] };
  await page.route("http://127.0.0.1:8879/", route => route.fulfill({ contentType: "text/html", body: html }));
  await page.route("**/api/browser-account", route => route.fulfill({ json: { user: { id: "fixture-owner", username: "fixture" } } }));
  await page.route("**/api/companies", route => route.fulfill({ json: { companies: [{ id: "acme", name: "Acme" }, { id: "other", name: "Other company" }] } }));
  await page.route("**/api/browser-connections*", async route => {
    const method = route.request().method();
    if (method !== "GET") {
      f.writes.push({ method, body: route.request().postDataJSON() });
      if (f.pairGate && method === "POST") await f.pairGate.promise;
      return route.fulfill({ json: { code: "synthetic-pairing-code", expiresAt: Date.now() + 300000 } });
    }
    if (f.listGate && new URL(route.request().url()).searchParams.get("companyId") === "acme") await f.listGate.promise;
    return route.fulfill({ json: { connections: f.profiles } });
  });
  await page.route("**/api/browser-connections/browser-legacy", async route => {
    const body = route.request().postDataJSON(); f.writes.push({ method: route.request().method(), body });
    f.profiles[2].companyId = body.companyId;
    return route.fulfill({ json: { id: "browser-legacy", companyId: body.companyId } });
  });
  await page.goto("/");
  await page.evaluate(async scoped => {
    const { BrowserConnectionSettings } = await import("/browser-connections.js");
    window.fixtureBrowserSettings = new BrowserConnectionSettings({
      api: async (url, options) => { const response = await fetch(url, { ...options, headers: { "content-type": "application/json" } }); const body = await response.json(); if (!response.ok) throw Error(body.error); return body; },
      state: { config: { features: {} }, active: { repositories: [{ fullName: "some-owner/project", companyId: "acme" }] } },
      toast() {}, browser: { disconnect() {}, accessChanged() {} }, accountChanged: async () => {}, chatUpdated() {},
    });
    await window.fixtureBrowserSettings.open(scoped ? "acme" : null);
  }, scoped);
  return f;
}

test("company-scoped browser settings show a locked company label and require explicit legacy assignment", async ({ page }) => {
  const f = await companyFixture(page, { scoped: true });
  await expect(page.locator("#browser-company-name")).toHaveText("Company: Acme");
  await expect(page.locator("#browser-company-picker")).toBeHidden();
  await expect(page.locator("#browser-connection-list")).toContainText("Acme Chrome");
  await expect(page.locator("#browser-connection-list")).not.toContainText("Other Chrome");
  await expect(page.locator("#browser-connection-list")).not.toContainText("Saved legacy Chrome");
  expect(f.writes).toEqual([]);
  await page.locator("#browser-legacy-profiles summary").click();
  await expect(page.locator("#browser-legacy-list")).toContainText("Saved legacy Chrome");
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "Assign to Acme", exact: true }).click();
  expect(f.writes).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("company-browser-legacy-desktop.png") });
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Assign to Acme", exact: true }).click();
  await expect(page.locator("#browser-legacy-profiles")).toBeHidden();
  await expect(page.locator("#browser-connection-list")).toContainText("Saved legacy Chrome");
  expect(f.writes).toEqual([{ method: "PATCH", body: { companyId: "acme" } }]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page.locator("#browser-connections-dialog"));
  await page.screenshot({ path: test.info().outputPath("company-browser-mobile.png") });
});

test("company switches suppress late pairing codes and preserve the requested pairing company", async ({ page }) => {
  const f = await companyFixture(page); f.pairGate = Promise.withResolvers();
  await page.locator("#browser-pair-instructions summary").click();
  await page.locator("#browser-pair-form button").click();
  await expect.poll(() => f.writes.length).toBe(1);
  await page.locator("#browser-company").selectOption("other");
  await expect(page.locator("#browser-connection-list")).toContainText("Other Chrome");
  f.pairGate.resolve();
  await expect(page.locator("#browser-pair-form button")).toBeEnabled();
  await expect(page.locator("#browser-pair-result")).toBeHidden();
  await expect(page.locator("#browser-pair-code")).toHaveValue("");
  expect(f.writes).toEqual([{ method: "POST", body: { name: "My Chrome", companyId: "acme" } }]);
  await expect(page.locator("#browser-connection-list")).not.toContainText("Acme Chrome");
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
