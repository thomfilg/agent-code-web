import { test, expect } from "@playwright/test";

test("new conversation accepts navigation immediately and opens it when cached settings refresh", async ({ page }) => {
  const configEntered = Promise.withResolvers(), configReady = Promise.withResolvers();
  const preferencesEntered = Promise.withResolvers(), preferencesReady = Promise.withResolvers();
  const errors = []; let writes = 0;
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/config", async route => { configEntered.resolve(); await configReady.promise; await route.continue(); });
  await page.route("**/api/preferences", async route => {
    if (route.request().method() !== "GET") return route.continue();
    preferencesEntered.resolve(); await preferencesReady.promise;
    await route.fulfill({ json: { preferences: { repositories: [], agent: "mock" } } });
  });
  await page.route("**/api/github", route => route.fulfill({ json: { connected: true, login: "fixture", repositoryAccess: "github", connections: [{ id: "fixture", connected: true, revision: 1, repositoryAccess: "github" }] } }));
  await page.route("**/api/github/repositories*", route => route.fulfill({ json: { repositories: [{ id: 1, fullName: "Fixture/project", defaultBranch: "main", githubConnectionId: "fixture" }] } }));
  await page.route("**/api/chats", route => { if (route.request().method() === "POST") writes++; return route.continue(); });
  try {
    await page.goto("/"); await configEntered.promise;
    await expect(page.locator("#new-chat-button")).toBeEnabled();
    await page.keyboard.press("Control+k"); await expect(page.locator("#new-chat-page")).toBeHidden();
    configReady.resolve(); await preferencesEntered.promise;
    await expect(page.locator("#new-chat-button")).toBeEnabled();
    preferencesReady.resolve();
    await expect(page.locator("#new-chat-page")).toBeVisible();
    await expect(page.locator("#new-chat-fields")).toHaveJSProperty("disabled", false);
    await page.getByRole("button", { name: "Add repositories", exact: true }).click();
    await expect(page.locator("#repository-results").getByRole("checkbox")).toHaveCount(1);
    await expect(page.locator("#repository-results")).toContainText("Fixture/project");
    await expect(page.locator("#create-chat-error")).toBeEmpty();
    expect(errors).toEqual([]); expect(writes).toBe(0);
  } finally { configReady.resolve(); preferencesReady.resolve(); }
});
