import { test, expect } from "@playwright/test";

test("environment boundaries remain independent; company MCPs need no second selection", async ({ page, request }) => {
  const response = await request.post("/api/mcps", { data: { name: "company-boundary", companyId: "acme", type: "http", url: "https://example.test/mcp", authMode: "none" } });
  expect(response.ok()).toBe(true); const { connection } = await response.json(); let environment;
  try {
    await page.goto("/"); await page.locator("#environments-button").click(); await page.locator("#add-environment").click();
    await page.getByLabel("Environment name", { exact: true }).fill("Registered company environment");
    await page.locator("#environment-companies").getByRole("checkbox", { name: "acme", exact: true }).check();
    await expect(page.locator("#environment-companies").getByLabel("Add companies", { exact: true })).toHaveCount(0);
    await expect(page.locator("#environment-mcp-options")).toContainText("company-boundary · acme");
    await expect(page.locator("#environment-mcp-options input")).toHaveCount(0);
    await page.getByRole("button", { name: "Save environment", exact: true }).click();
    await expect(page.locator("#environment-save-status")).toContainText("Saved securely");
    environment = (await (await request.get("/api/environments")).json()).environments.find(item => item.name === "Registered company environment");
    expect(environment.companies).toEqual(["acme"]); expect(environment.mcpIds).toEqual([]);
    await page.locator("#environment-companies").getByRole("button", { name: "Manage companies", exact: true }).click();
    await expect(page.locator("#companies-page")).toBeVisible();
  } finally {
    if (environment) await request.delete(`/api/environments/${environment.id}`);
    await request.delete(`/api/mcps/${connection.id}`);
  }
});

test("registered company settings cannot silently save to an older backend", async ({ page }) => {
  await page.route("**/api/config", async route => { const data = await (await route.fetch()).json(); delete data.features.companyRegistry; await route.fulfill({ json: data }); });
  let writes = 0;
  await page.route("**/api/mcps", route => { if (route.request().method() === "POST") { writes++; return route.fulfill({ json: {} }); } return route.continue(); });
  await page.goto("/"); await page.locator("#mcps-button").click(); await page.locator("#mcp-new").click();
  await page.locator("#mcp-name").fill("old-server-guard"); await page.locator("#mcp-url").fill("https://mcp.linear.app/mcp");
  await page.locator("#mcp-save").click(); await expect(page.locator("#mcp-error")).toContainText("Restart Relay"); expect(writes).toBe(0);
});
