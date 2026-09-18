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
  await expect(page.locator("#github-companies input[type=checkbox]:checked")).toHaveCount(0);
  await page.locator("#github-connection-name").fill("GitHub native test");
  await page.locator("#github-companies summary").click();
  await page.locator("#github-companies").getByLabel("Add companies", { exact: true }).fill("acme");
  await page.locator("#github-companies").getByRole("button", { name: "Add companies", exact: true }).click();
  await page.locator("#github-save-scope").click(); await expect(page.locator("#github-dialog")).not.toBeVisible();
  await page.reload(); await page.locator("#github-button").click();
  const card = page.locator("#github-account-list section").filter({ hasText: "GitHub native test" });
  await expect(card).toContainText("Signed in as browser-fixture"); await expect(card).toContainText("acme");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/github-native-mobile.png" });
  page.once("dialog", dialog => dialog.accept()); await card.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(card).toHaveCount(0); expect(errors).toEqual([]);
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
