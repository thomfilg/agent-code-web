import { test, expect } from "@playwright/test";

test("environments and MCPs retain company boundaries while GitHub uses its own account permissions", async ({ page, request }) => {
  const githubIds = [], mcpIds = [], environmentIds = [];
  const addCompanies = async (root, value) => {
    await page.locator(root).getByLabel("Add companies", { exact: true }).fill(value);
    await page.locator(root).getByRole("button", { name: "Add companies", exact: true }).click();
  };
  try {
    await page.goto("/");
    const login = await (await request.post("/api/github/device", { data: {} })).json(); githubIds.push(login.connection.id);
    await expect.poll(async () => (await (await request.get("/api/github")).json()).connections.find(connection => connection.id === login.connection.id)?.connected).toBe(true);
    const repositories = (await (await request.get("/api/github/repositories")).json()).repositories.filter(repo => repo.githubConnectionId === login.connection.id);
    expect(repositories.map(repo => repo.fullName)).toContain("Other/library");
    for (const [companies, secret] of [["12-apps, thomfilg", "future-fixture"], ["g2i", "g2i-fixture"]]) {
      await page.getByRole("button", { name: "MCP connections", exact: true }).click();
      await page.locator("#mcp-new").click(); await page.locator("#mcp-name").fill("linear-team");
      await addCompanies("#mcp-companies", companies); await page.locator("#mcp-url").fill("https://mcp.linear.app/mcp");
      await page.locator("#mcp-auth").selectOption("headers"); await page.locator("#mcp-headers").fill(JSON.stringify({ Authorization: `Bearer ${secret}` }));
      await page.getByRole("button", { name: "Save connection", exact: true }).click(); await expect(page.locator("#mcp-save-status")).toContainText("Saved");
      await expect(page.locator("#mcp-headers")).toHaveValue("");
      const { connections } = await (await request.get("/api/mcps")).json();
      mcpIds.push(connections.find(connection => connection.name === "linear-team" && connection.companies.includes(companies.split(",")[0])).id);
      await page.getByLabel("Close MCP connections", { exact: true }).click();
    }
    await page.getByRole("button", { name: "Environments", exact: true }).click(); await page.locator("#add-environment").click();
    await page.getByLabel("Environment name", { exact: true }).fill("Future company environment");
    await addCompanies("#environment-companies", "12-apps, thomfilg");
    await page.locator("#environment-mcp-options").getByRole("checkbox", { name: "linear-team · http · 12-apps, thomfilg", exact: true }).check();
    await expect(page.locator("#environment-mcp-options").getByRole("checkbox", { name: /linear-team · http · g2i/ })).toBeDisabled();
    await page.getByRole("button", { name: "Save environment", exact: true }).click(); await expect(page.locator("#environment-save-status")).toContainText("Saved securely");
    const { environments } = await (await request.get("/api/environments")).json(), saved = environments.find(environment => environment.name === "Future company environment");
    environmentIds.push(saved.id); expect(saved.companies).toEqual(["12-apps", "thomfilg"]); expect(saved.mcpIds).toEqual([mcpIds[0]]);
    // GitHub really permits this repository; the independent environment scope
    // must still reject its company before any worker/model is started.
    const denied = await request.post("/api/chats", { data: { agent: "mock", environmentId: saved.id, repositories: [{ fullName: "Other/library", githubConnectionId: login.connection.id }] } });
    expect(denied.status()).toBe(403);
    expect((await denied.json()).error).toMatch(/^Environment .* is not available for other/);
    await page.reload(); await page.getByRole("button", { name: "Environments", exact: true }).click();
    await page.locator("#environment-tabs").getByRole("button", { name: "Future company environment", exact: true }).click({ trial: true });
    page.once("dialog", dialog => dialog.accept()); await page.locator("#environment-tabs").getByRole("button", { name: "Future company environment", exact: true }).click();
    await expect(page.locator("#environment-companies").getByRole("checkbox", { name: "12-apps", exact: true })).toBeChecked();
    await expect(page.locator("#environment-companies").getByRole("checkbox", { name: "thomfilg", exact: true })).toBeChecked();
    await expect(page.locator("#environment-companies").getByRole("checkbox", { name: "g2i", exact: true })).not.toBeChecked();
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    for (const id of environmentIds) await request.delete(`/api/environments/${id}`);
    for (const id of mcpIds) await request.delete(`/api/mcps/${id}`);
    for (const id of githubIds) await request.delete(`/api/github/connections/${id}`);
  }
});

test("new company selectors cannot silently save global credentials to an old backend", async ({ page }) => {
  await page.route("**/api/config", async route => { const data = await (await route.fetch()).json(); delete data.features; await route.fulfill({ json: data }); });
  let writes = 0;
  await page.route("**/api/mcps", route => { if (route.request().method() === "POST") { writes++; return route.fulfill({ json: {} }); } return route.continue(); });
  await page.goto("/"); await page.getByRole("button", { name: "MCP connections", exact: true }).click();
  await page.locator("#mcp-new").click(); await page.locator("#mcp-name").fill("old-server-guard"); await page.locator("#mcp-url").fill("https://mcp.linear.app/mcp");
  await page.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(page.locator("#mcp-error")).toContainText("Restart Relay"); expect(writes).toBe(0);
});
