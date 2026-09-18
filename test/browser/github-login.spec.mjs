import { test, expect } from "@playwright/test";

test("GitHub native login immediately exposes GitHub-authorized repositories without company setup", async ({ page, request }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/"); await page.locator("#new-chat-button").click(); await page.locator("#connect-github-button").click();
  await expect(page.locator("#github-token")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Use this server’s gh login" })).toHaveCount(0);
  await expect(page.locator("#github-access-form, #github-companies")).toHaveCount(0);
  await expect(page.locator("#github-rename-form")).toBeHidden();
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
  await expect(page.locator("#github-account-list")).toContainText("Signed in as browser-fixture");
  await expect(page.locator("#github-rename-form")).toBeHidden();
  await expect(page.locator("#github-dialog")).not.toContainText("company access");
  expect((await (await request.get("/api/github/repositories")).json()).repositories.map(repo => repo.fullName)).toEqual(["Acme/api", "Acme/web", "Other/library"]);
  await page.getByRole("button", { name: "Close GitHub dialog", exact: true }).click();
  await expect(page.locator("#repository-results .repository-option")).toHaveCount(3);
  await expect(page.locator("#repository-results")).toContainText("Other/library");
  await page.locator("#new-chat-dialog").getByRole("button", { name: "Close", exact: true }).click();
  await page.locator("#github-button").click();
  await page.locator("#github-account-list").getByRole("button", { name: "Rename", exact: true }).click();
  await page.locator("#github-connection-name").fill("GitHub native test");
  await page.locator("#github-save-name").click(); await expect(page.locator("#github-dialog")).not.toBeVisible();
  await page.reload(); await page.locator("#github-button").click();
  const card = page.locator("#github-account-list section").filter({ hasText: "GitHub native test" });
  await expect(card).toContainText("Signed in as browser-fixture"); await expect(card).toContainText("GitHub account’s permissions");
  await expect(page.locator("#github-rename-form")).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/github-native-mobile.png" });
  page.once("dialog", dialog => dialog.accept()); await card.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(card).toHaveCount(0); expect(errors).toEqual([]);
});

test("legacy and multiple GitHub accounts have no company stage and rename sends only name and revision", async ({ page }) => {
  const connections = ["first", "second"].map((name, index) => ({ id: `github_${index}`, name, login: `fixture-${name}`, connected: true, companies: index ? ["legacy-restriction"] : [], allowUnassigned: false, revision: 4, repositoryAccess: "github" }));
  const writes = [];
  await page.route("**/api/github", async route => {
    await route.fulfill({ json: { connected: true, login: "2 connections", connections } });
  });
  await page.route("**/api/github/repositories*", route => route.fulfill({ json: { repositories: connections.map((connection, index) => ({ id: index + 1, fullName: `allowed-${index}/project`, defaultBranch: "main", githubConnectionId: connection.id, connectionName: connection.name })) } }));
  await page.route("**/api/github/connections/github_1", async route => {
    const body = route.request().postDataJSON(); writes.push(body); connections[1] = { ...connections[1], name: body.name, revision: 5 };
    await route.fulfill({ json: { connection: connections[1] } });
  });
  await page.goto("/"); await page.locator("#new-chat-button").click();
  await expect(page.locator("#repository-results")).toContainText("allowed-0/project"); await expect(page.locator("#repository-results")).toContainText("allowed-1/project");
  await expect(page.locator("#repository-results")).not.toContainText("no companies");
  await page.locator("#new-chat-dialog").getByRole("button", { name: "Close", exact: true }).click();
  await page.locator("#github-button").click();
  await expect(page.locator("#github-access-form, #github-companies")).toHaveCount(0); await expect(page.locator("#github-rename-form")).toBeHidden();
  await expect(page.getByRole("button", { name: /company access/i })).toHaveCount(0);
  await expect(page.locator("#github-account-list section")).toHaveCount(2);
  await page.locator("#github-account-list section").filter({ hasText: "fixture-second" }).getByRole("button", { name: "Rename", exact: true }).click();
  await expect(page.locator("#github-connection-name")).toHaveValue("second");
  await page.locator("#github-connection-name").fill("Second account renamed"); await page.locator("#github-save-name").click();
  await expect(page.locator("#github-dialog")).toBeHidden();
  expect(writes).toEqual([{ revision: 4, name: "Second account renamed" }]);
});

test("GitHub cancellation, reload and failure preserve a retryable account without another login form", async ({ page }) => {
  await page.goto("/"); await page.locator("#github-button").click(); await page.locator("#github-new").click();
  const pending = page.locator("#github-account-list section").filter({ hasText: "TEST-CODE" });
  await pending.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
  await expect(page.locator("#github-account-list")).toContainText("GitHub sign-in cancelled");
  await page.reload(); await page.locator("#github-button").click();
  const card = page.locator("#github-account-list section").filter({ hasText: "GitHub sign-in cancelled" });
  await expect(card.getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
  await expect(page.locator("#github-rename-form")).not.toBeVisible();
  page.once("dialog", dialog => dialog.accept()); await card.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(card).toHaveCount(0);
});
