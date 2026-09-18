import { test, expect } from "@playwright/test";

test("GitHub native login stays account-scoped with immediate progress, no token form, explicit companies and persisted identity", async ({ page, request }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/"); await page.locator("#github-button").click();
  await expect(page.locator("#github-token")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Use this server’s gh login" })).toHaveCount(0);
  await expect(page.locator("#github-access-form")).not.toBeVisible();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route("**/api/github/device", async route => { await held; await route.continue(); });
  await page.locator("#github-new").click();
  await expect(page.locator("#github-new")).toHaveText("Connecting to GitHub…"); await expect(page.locator("#github-new")).toBeDisabled();
  release();
  await expect(page.locator("#github-account-list")).toContainText("Waiting for your GitHub authorization");
  const pending = page.locator("#github-account-list section").filter({ hasText: "TEST-CODE" });
  await expect(pending.getByRole("link", { name: "Open GitHub sign-in" })).toHaveAttribute("href", "https://github.com/login/device");
  await expect(pending.getByRole("button", { name: "Cancel sign-in" })).toBeVisible();
  await expect(page.locator("#github-access-form")).toBeVisible();
  await expect(page.locator("#github-account-list")).toContainText("Signed in as browser-fixture");
  await expect(page.locator("#github-account-list")).toContainText("No companies are enabled yet");
  await expect(page.locator("#github-companies input[type=checkbox]:checked")).toHaveCount(0);
  expect((await (await request.get("/api/github/repositories")).json()).repositories).toEqual([]);
  await page.reload(); await page.locator("#github-button").click();
  await expect(page.locator("#github-access-form")).toBeVisible();
  await expect(page.locator("#github-companies input[type=checkbox]:checked")).toHaveCount(0);
  expect((await (await request.get("/api/github")).json()).connections.find(connection => connection.connected).companies).toEqual([]);
  await page.locator("#github-connection-name").fill("GitHub native test");
  await page.locator("#github-companies summary").click();
  await page.locator("#github-companies").getByLabel("Add companies", { exact: true }).fill("acme");
  await page.locator("#github-companies").getByRole("button", { name: "Add companies", exact: true }).click();
  await page.locator("#github-save-scope").click(); await expect(page.locator("#github-dialog")).not.toBeVisible();
  expect((await (await request.get("/api/github/repositories")).json()).repositories.map(repo => repo.fullName)).toEqual(["Acme/api", "Acme/web"]);
  await page.reload(); await page.locator("#github-button").click();
  const card = page.locator("#github-account-list section").filter({ hasText: "GitHub native test" });
  await expect(card).toContainText("Signed in as browser-fixture"); await expect(card).toContainText("acme");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/github-native-mobile.png" });
  page.once("dialog", dialog => dialog.accept()); await card.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(card).toHaveCount(0); expect(errors).toEqual([]);
});

test("incomplete GitHub setup offers existing agent companies without granting or choosing among accounts", async ({ page }) => {
  const connections = ["first", "second"].map((name, index) => ({ id: `github_${index}`, name, login: `fixture-${name}`, connected: true, companies: [], allowUnassigned: false, revision: 4 }));
  let writes = 0;
  await page.route("**/api/config", async route => {
    const response = await route.fetch(), config = await response.json();
    await route.fulfill({ response, json: { ...config, features: { ...config.features, agentAccounts: true } } });
  });
  await page.route("**/api/agent-accounts", route => route.fulfill({ json: { accounts: [{ id: "fixture-agent", provider: "codex", name: "Existing scoped account", status: "connected", companies: ["12-apps", "thomfilg"], allowUnassigned: false }] } }));
  await page.route("**/api/github", async route => {
    if (route.request().method() !== "GET") { writes++; return route.fulfill({ status: 400, json: { error: "Unexpected mutation" } }); }
    await route.fulfill({ json: { connected: true, login: "2 connections", connections } });
  });
  await page.goto("/"); await page.locator("#github-button").click();
  await expect(page.locator("#github-access-form")).toBeHidden();
  await expect(page.getByRole("button", { name: "Set up company access", exact: true })).toHaveCount(2);
  await page.locator("#github-account-list section").filter({ hasText: "fixture-second" }).getByRole("button", { name: "Set up company access", exact: true }).click();
  await expect(page.locator("#github-connection-name")).toHaveValue("second");
  await expect(page.locator("#github-companies").getByRole("checkbox", { name: "thomfilg", exact: true })).toBeVisible();
  await expect(page.locator("#github-companies").getByRole("checkbox", { name: "12-apps", exact: true })).toBeVisible();
  await expect(page.locator("#github-companies input[type=checkbox]:checked")).toHaveCount(0);
  await page.locator("#github-connection-name").fill("Unsaved second name");
  await page.getByRole("button", { name: "Close GitHub dialog", exact: true }).click();
  await page.locator("#github-button").click();
  await expect(page.locator("#github-connection-name")).toHaveValue("Unsaved second name");
  await expect(page.locator("#github-companies input[type=checkbox]:checked")).toHaveCount(0);
  expect(writes).toBe(0); expect(connections.every(connection => connection.companies.length === 0)).toBe(true);
});

test("GitHub cancellation, reload and failure preserve a retryable account without another login form", async ({ page }) => {
  await page.goto("/"); await page.locator("#github-button").click(); await page.locator("#github-new").click();
  const pending = page.locator("#github-account-list section").filter({ hasText: "TEST-CODE" });
  await pending.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
  await expect(page.locator("#github-account-list")).toContainText("GitHub sign-in cancelled");
  await page.reload(); await page.locator("#github-button").click();
  const card = page.locator("#github-account-list section").filter({ hasText: "GitHub sign-in cancelled" });
  await expect(card.getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
  await expect(page.locator("#github-access-form")).not.toBeVisible();
  page.once("dialog", dialog => dialog.accept()); await card.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(card).toHaveCount(0);
});
