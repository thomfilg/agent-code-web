import { test, expect } from "@playwright/test";

async function create(page, name) {
  await page.goto("/");
  if (page.viewportSize().width < 700) await page.getByRole("button", { name: "Open chats", exact: true }).click();
  await page.getByRole("button", { name: "MCP connections", exact: true }).click();
  await page.locator("#mcp-company-filter").selectOption("12-apps");
  await page.locator("#mcp-presets").getByRole("button", { name: /^Linear/ }).click();
  if (await page.locator("#mcp-delete").isVisible()) await page.locator("#mcp-add-another").click();
  await page.locator("#mcp-name").fill(name);
  await expect(page.locator("#mcp-company")).toHaveValue("12-apps");
  await expect(page.getByRole("combobox", { name: "Linear permissions", exact: true })).toHaveValue("read");
  await page.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(page.locator("#mcp-save-status")).toContainText("not signed in yet");
  await expect(page.locator("#mcp-connection-status")).toContainText("Sign-in required");
}

async function routeConsent(context) {
  await context.route("https://mcp.linear.app/authorize?*", async route => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `http://127.0.0.1:8895${url.pathname}${url.search}` });
    // Consent-page links are local fixture URLs; no real Linear request/consent.
    await route.fulfill({ response, body: (await response.text()).replaceAll('href="/approve?', 'href="http://127.0.0.1:8895/approve?').replaceAll('href="/deny?', 'href="http://127.0.0.1:8895/deny?') });
  });
}

test("Linear consent shows its company, defaults to read and verifies without a second environment selection", async ({ page, context }) => {
  await routeConsent(context); await create(page, "linear-browser-read");
  const popupPromise = page.waitForEvent("popup"); await page.getByRole("button", { name: "Connect with OAuth", exact: true }).click();
  const popup = await popupPromise;
  await expect(page.locator("#mcp-sign-in-status")).toContainText("linear-browser-read · 12-apps");
  await expect(page.locator("#mcp-sign-in-status")).toContainText("Waiting for your approval");
  await popup.getByRole("link", { name: "Approve access" }).click();
  await expect(popup.getByRole("heading", { name: "MCP connected" })).toBeVisible();
  await expect(page.locator("#mcp-connection-status")).toContainText("Connected · 1 tools");
  await page.getByLabel("Close MCP connections").click();
  await page.getByRole("button", { name: "Environments", exact: true }).click();
  await page.locator("#environment-companies").getByRole("checkbox", { name: "12-apps", exact: true }).check();
  await expect(page.locator("#environment-mcp-options")).toContainText("linear-browser-read · 12-apps");
  await expect(page.locator("#environment-mcp-options input")).toHaveCount(0);
  await page.getByRole("button", { name: "Save environment", exact: true }).click();
  const { connections } = await (await page.request.get("/api/mcps")).json();
  const connection = connections.find(c => c.name === "linear-browser-read");
  expect(connection.health.workspaceRead.tool).toBe("list_teams"); expect(connection.oauthScopes).toBe("read");
  const { environments } = await (await page.request.get("/api/environments")).json();
  expect(environments.every(environment => environment.mcpIds.length === 0)).toBe(true);
  expect(connection.companyId).toBe("12-apps");
  await popup.close();
});

test("denied consent is reported immediately in the connection, and retry can be cancelled", async ({ page, context }) => {
  await routeConsent(context); await create(page, "linear-browser-denial");
  const popupPromise = page.waitForEvent("popup"); await page.getByRole("button", { name: "Connect with OAuth", exact: true }).click();
  const popup = await popupPromise; await popup.getByRole("link", { name: "Decline access" }).click();
  await expect(page.locator("#mcp-sign-in-status")).toContainText("authorization was declined");
  await expect(page.getByRole("button", { name: "Connect with OAuth", exact: true })).toBeEnabled();
  await popup.close();
  const retryPromise = page.waitForEvent("popup"); await page.getByRole("button", { name: "Connect with OAuth", exact: true }).click();
  const retry = await retryPromise;
  await page.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
  await expect(page.locator("#mcp-sign-in-status")).toContainText("Sign-in cancelled");
  await expect(page.locator("#mcp-connection-status")).toContainText("Sign-in required");
  // Cross-origin isolation may sever the popup handle. Even if the provider
  // tab remains open, its old consent cannot authenticate the cancelled flow.
  if (!retry.isClosed()) {
    await retry.getByRole("link", { name: "Approve access" }).click();
    await expect(retry.getByRole("heading", { name: "Unable to connect" })).toBeVisible();
    await retry.close();
  }
  const { connections } = await (await page.request.get("/api/mcps")).json();
  expect(connections.find(connection => connection.name === "linear-browser-denial").oauthConnected).toBe(false);
});

test("blocked popup has a usable sign-in link and mobile permissions include an explicit write option", async ({ page, context }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await routeConsent(context); await create(page, "linear-browser-fallback");
  await page.getByRole("combobox", { name: "Linear permissions", exact: true }).selectOption("read write");
  await page.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(page.locator("#mcp-save-status")).toContainText("Saved");
  await page.evaluate(() => { window.open = () => null; });
  await page.getByRole("button", { name: "Connect with OAuth", exact: true }).click();
  const link = page.getByRole("link", { name: "Open sign-in window", exact: true });
  await expect(link).toBeVisible();
  expect(new URL(await link.getAttribute("href")).searchParams.get("scope")).toBe("read write");
  expect(await page.locator("#mcp-dialog").evaluate(node => node.scrollWidth <= node.clientWidth + 2)).toBe(true);
  await page.screenshot({ path: "test-results/linear-oauth-mobile.png", fullPage: true });
  const popupPromise = page.waitForEvent("popup"); await link.click();
  const popup = await popupPromise; await popup.getByRole("link", { name: "Approve access" }).click();
  await expect(page.locator("#mcp-connection-status")).toContainText("Connected · 1 tools");
  await popup.close();
});

test("saving another tab's edit during reconnect cannot be presented as completed consent", async ({ page, context }) => {
  await routeConsent(context); await create(page, "linear-browser-edit-race");
  const firstPopup = page.waitForEvent("popup"); await page.getByRole("button", { name: "Connect with OAuth", exact: true }).click();
  const first = await firstPopup; await first.getByRole("link", { name: "Approve access" }).click();
  await expect(page.locator("#mcp-connection-status")).toContainText("Connected · 1 tools"); await first.close();
  const secondPopup = page.waitForEvent("popup"); await page.locator("#mcp-connect").click();
  const second = await secondPopup;
  await expect(page.locator("#mcp-sign-in-status")).toContainText("Waiting for your approval");
  const { connections } = await (await page.request.get("/api/mcps")).json();
  const connection = connections.find(c => c.name === "linear-browser-edit-race");
  const response = await page.request.patch(`/api/mcps/${connection.id}`, { data: { ...connection, name: "linear-browser-edited" } });
  expect(response.ok()).toBe(true);
  await expect(page.locator("#mcp-sign-in-status")).toContainText("Connection settings changed");
  await expect(page.locator("#mcp-connection-status")).not.toContainText("Connected · 1 tools");
  await expect(page.locator("#mcp-connect")).toBeEnabled();
  await second.getByRole("link", { name: "Approve access" }).click();
  await expect(second.getByRole("heading", { name: "Unable to connect" })).toBeVisible(); await second.close();
});
