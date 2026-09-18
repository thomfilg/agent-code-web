import { test, expect } from "@playwright/test";

async function create(page, name) {
  await page.goto("/");
  if (page.viewportSize().width < 700) await page.getByRole("button", { name: "Open chats", exact: true }).click();
  await page.getByRole("button", { name: "MCP connections", exact: true }).click();
  await page.locator("#mcp-catalog").evaluate(node => { node.open = true; });
  await page.locator("#mcp-presets").getByRole("button", { name: /^Linear/ }).click();
  await page.locator("#mcp-name").fill(name);
  await page.locator("#mcp-companies").getByLabel("Add companies", { exact: true }).fill("12-apps");
  await page.locator("#mcp-companies").getByRole("button", { name: "Add companies", exact: true }).click();
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

test("Linear consent shows its company, defaults to read, verifies a workspace read, and selects into an environment", async ({ page, context }) => {
  await routeConsent(context); await create(page, "linear-browser-read");
  const popupPromise = page.waitForEvent("popup"); await page.getByRole("button", { name: "Connect with OAuth", exact: true }).click();
  const popup = await popupPromise;
  await expect(page.locator("#mcp-sign-in-status")).toContainText("linear-browser-read · 12-apps");
  await expect(page.locator("#mcp-sign-in-status")).toContainText("Waiting for your approval");
  await popup.getByRole("link", { name: "Approve access" }).click();
  await expect(popup.getByRole("heading", { name: "MCP connected" })).toBeVisible();
  await expect(page.locator("#mcp-connection-status")).toContainText("Authenticated workspace read verified");
  await expect(page.locator("#mcp-connection-status")).toContainText("Connected · 1 tools");
  await page.getByLabel("Close MCP connections").click();
  await page.getByRole("button", { name: "Environments", exact: true }).click();
  await page.locator("#environment-companies").getByLabel("Add companies", { exact: true }).fill("12-apps");
  await page.locator("#environment-companies").getByRole("button", { name: "Add companies", exact: true }).click();
  await page.locator("#environment-mcp-options").getByRole("checkbox", { name: "linear-browser-read · http · 12-apps", exact: true }).check();
  await page.getByRole("button", { name: "Save environment", exact: true }).click();
  const { connections } = await (await page.request.get("/api/mcps")).json();
  const connection = connections.find(c => c.name === "linear-browser-read");
  expect(connection.health.workspaceRead.tool).toBe("list_teams"); expect(connection.oauthScopes).toBe("read");
  const { environments } = await (await page.request.get("/api/environments")).json();
  expect(environments.some(environment => environment.mcpIds.includes(connection.id))).toBe(true);
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
  await expect(page.locator("#mcp-save-status")).toContainText("Saved configuration");
  await page.evaluate(() => { window.open = () => null; });
  await page.getByRole("button", { name: "Connect with OAuth", exact: true }).click();
  const link = page.getByRole("link", { name: "Open sign-in window", exact: true });
  await expect(link).toBeVisible();
  expect(new URL(await link.getAttribute("href")).searchParams.get("scope")).toBe("read write");
  expect(await page.locator("#mcp-dialog").evaluate(node => node.scrollWidth <= node.clientWidth + 2)).toBe(true);
  await page.screenshot({ path: "test-results/linear-oauth-mobile.png", fullPage: true });
  const popupPromise = page.waitForEvent("popup"); await link.click();
  const popup = await popupPromise; await popup.getByRole("link", { name: "Approve access" }).click();
  await expect(page.locator("#mcp-connection-status")).toContainText("Authenticated workspace read verified");
  await popup.close();
});
