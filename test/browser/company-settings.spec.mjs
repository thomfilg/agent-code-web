import { test, expect } from "@playwright/test";

async function ready(page) {
  await page.goto("/"); await expect(page.locator("#new-chat-fields")).toHaveJSProperty("disabled", false);
}

test("Companies is a separate page with durable registration, stable identifiers and draft preservation", async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await ready(page); await page.locator("#initial-prompt").fill("Keep this draft");
  await page.getByRole("button", { name: "Companies", exact: true }).click();
  await expect(page.locator("#companies-page")).toBeVisible(); await expect(page.locator("dialog[open]")).toHaveCount(0);
  await page.locator("#company-new").click(); await page.getByLabel("Company name", { exact: true }).fill("Browser Company");
  await page.getByLabel("Company identifier").fill("browser-company");
  await page.getByRole("button", { name: "Save company", exact: true }).click();
  const card = page.locator('[data-company-id="browser-company"]'); await expect(card).toContainText("Browser Company");
  await expect(card).toContainText("0 MCP connections"); await expect(card).toContainText("GitHub: not assigned");
  await page.getByRole("button", { name: "Edit Browser Company", exact: true }).click();
  await expect(page.locator("#company-id")).toHaveAttribute("readonly", "");
  await page.getByLabel("Company name", { exact: true }).fill("Browser Company renamed"); await page.getByRole("button", { name: "Save company", exact: true }).click();
  await expect(card).toContainText("Browser Company renamed");
  await page.locator("#new-chat-button").click(); await expect(page.locator("#initial-prompt")).toHaveValue("Keep this draft");
  await page.locator("#companies-button").click(); await page.reload(); await expect(card).toContainText("Browser Company renamed");
  expect(errors).toEqual([]);
});

test("MCP overview filters registered companies and opens only the selected connection's settings", async ({ page, request }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const ids = [];
  for (const [companyId, name] of [["acme", "linear-overview-acme"], ["other", "linear-overview-other"]]) {
    const response = await request.post("/api/mcps", { data: { name, companyId, type: "http", url: "https://mcp.linear.app/mcp", authMode: "oauth", oauthScopes: "read" } });
    expect(response.ok()).toBe(true); ids.push((await response.json()).connection.id);
  }
  await page.route("**/api/mcps", async route => {
    const response = await route.fetch(), payload = await response.json();
    if (route.request().method() === "GET") payload.connections = payload.connections.map(connection => connection.id === ids[0] ? { ...connection, oauthConnected: true, health: { status: "connected", toolCount: 79 } } : connection);
    await route.fulfill({ response, json: payload });
  });
  try {
    await ready(page); await page.locator("#mcps-button").click(); await page.locator("#mcp-company-filter").selectOption("acme");
    await expect(page.locator("#mcp-presets button")).toHaveCount(7); await expect(page.locator("#mcp-detail")).toBeHidden();
    const linear = page.locator('[data-preset="linear"]'); await expect(linear).toContainText("Connected");
    await expect(page.locator('[data-preset="figma"]')).toContainText("Not connected");
    await linear.click(); await expect(page.locator("#mcp-overview")).toBeHidden();
    await expect(page.locator("#mcp-name")).toHaveValue("linear-overview-acme"); await expect(page.locator("#mcp-company")).toHaveValue("acme");
    await expect(page.locator("#mcp-advanced")).not.toHaveAttribute("open", ""); await expect(page.locator("#mcp-url")).toBeHidden();
    await expect(page.locator("#mcp-availability")).toContainText("acme chats");
    await expect(page.locator("#mcp-detail")).not.toContainText("linear-overview-other");
    await page.screenshot({ path: test.info().outputPath("mcp-detail.png"), fullPage: true });
    await page.locator("#mcp-back").click(); await page.locator("#mcp-company-filter").selectOption("other");
    await expect(linear).toContainText("Sign-in required"); await linear.click();
    await expect(page.locator("#mcp-name")).toHaveValue("linear-overview-other");
    await page.locator("#mcp-back").click(); await page.locator("#mcp-company-filter").selectOption("g2i");
    await linear.click(); await expect(page.locator("#mcp-name")).toHaveValue("linear");
    await expect(page.locator("#mcp-company")).toHaveValue("g2i"); await expect(page.locator("#mcp-company-review")).toBeHidden();
    expect(errors).toEqual([]);
  } finally { for (const id of ids) await request.delete(`/api/mcps/${id}`); }
});

test("GitHub card uses the company's one native connection, not a second token form", async ({ page, request }) => {
  await ready(page); await page.locator("#mcps-button").click(); await page.locator("#mcp-company-filter").selectOption("acme");
  await page.locator('[data-preset="github"]').click(); await expect(page.locator("#mcp-dialog")).toBeHidden();
  await expect(page.locator("#github-company-filter")).toHaveValue("acme");
  await page.locator("#github-new").click(); await expect(page.locator("#github-account-list")).toContainText("TEST-CODE");
  await expect(page.locator("#github-account-list")).toContainText("Signed in as browser-fixture");
  await expect(page.locator("#github-new")).toBeDisabled(); await expect(page.locator("#github-new")).toHaveText("One GitHub connection per company");
  expect((await request.post("/api/github/device", { data: { companyId: "acme" } })).status()).toBe(409);
  await expect(page.locator("#github-token")).toHaveCount(0);
  const { connections } = await (await request.get("/api/github")).json(), account = connections.find(connection => connection.companyId === "acme");
  await request.delete(`/api/github/connections/${account.id}`);
});

test("legacy MCP needs an explicit company assignment; cards and details fit a small screen", async ({ page }) => {
  const writes = [], connection = { id: "mcp_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "legacy-linear", companyId: null, companies: ["acme", "other"], scopeNeedsReview: true, type: "http", url: "https://mcp.linear.app/mcp", authMode: "oauth", oauthScopes: "read", oauthConnected: true, health: { status: "connected", toolCount: 79 }, revision: 1 };
  await page.route("**/api/mcps", route => route.fulfill({ json: { connections: [connection] } }));
  await page.route(`**/api/mcps/${connection.id}`, route => { const input = route.request().postDataJSON(); writes.push(input); Object.assign(connection, input, { companies: [input.companyId], revision: 2 }); return route.fulfill({ json: { connection } }); });
  await page.setViewportSize({ width: 360, height: 780 }); await ready(page); await page.getByRole("button", { name: "Open chats", exact: true }).click();
  await page.locator("#mcps-button").click(); await page.locator("#mcp-company-filter").selectOption("acme");
  await expect(page.locator('[data-preset="linear"]')).toContainText("Choose a company");
  await page.screenshot({ path: test.info().outputPath("mcp-cards-mobile.png"), fullPage: true });
  expect(await page.locator("#mcp-dialog").evaluate(node => node.scrollWidth <= node.clientWidth + 2)).toBe(true);
  await page.locator('[data-preset="linear"]').click(); await expect(page.locator("#mcp-company")).toHaveValue("");
  await expect(page.locator("#mcp-company-review")).toBeVisible(); await expect(page.locator("#mcp-connect")).toBeDisabled();
  await page.locator("#mcp-company").selectOption("acme"); await page.locator("#mcp-save").click();
  await expect(page.locator("#mcp-save-status")).toContainText("Saved"); expect(writes).toHaveLength(1);
  expect(writes[0].companyId).toBe("acme"); expect(writes[0].companies).toBeUndefined(); expect(writes[0].oauth).toBeUndefined();
  await page.locator("#mcp-back").click(); await page.locator("#mcp-manage-companies").click();
  await expect(page.locator("#mcp-dialog")).toBeHidden(); await expect(page.locator("#companies-page")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
