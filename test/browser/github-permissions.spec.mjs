import { test, expect } from "@playwright/test";

test("GitHub login makes workflow access an explicit permission choice", async ({ page }) => {
  let requestBody, connection;
  await page.route("**/api/github", route => route.fulfill({ json: { connections: connection ? [connection] : [], connected: false, oauthAvailable: true } }));
  await page.route("**/api/github/device", async route => {
    requestBody = route.request().postDataJSON();
    connection = { id: "github_00000000-0000-0000-0000-000000000001", name: "New GitHub account", companyId: requestBody.companyId, revision: 1, connected: false, requestedPermissions: requestBody.permissions, grantedPermissions: [], permissionsVerified: false, signIn: { id: "flow-1", state: "starting", permissions: requestBody.permissions } };
    await route.fulfill({ json: { id: "flow-1", connection } });
  });
  await page.goto("/");
  await page.evaluate(() => window.dispatchEvent(new Event("relay-open-github")));
  await expect(page.locator("#github-dialog")).toBeVisible();
  await page.locator("#github-new").click();
  await expect(page.locator("#github-permission-form")).toBeVisible();
  await expect(page.getByText("Repositories and pull requests", { exact: true })).toBeVisible();
  await expect(page.locator("#github-permission-form input").first()).toBeDisabled();
  await page.locator("#github-permission-workflows").check();
  await page.getByRole("button", { name: "Continue to GitHub", exact: true }).click();
  await expect.poll(() => requestBody?.permissions).toEqual(["repositories", "workflows"]);
  await expect(page.locator("#github-account-list")).toContainText("Requested: repositories · workflows");
});
