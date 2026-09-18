import { test, expect } from "@playwright/test";

async function fixture(page, { empty = false } = {}) {
  const repository = (fullName, companyId) => ({ fullName, companyId, githubConnectionId: `github-${companyId}`, defaultBranch: "main", branch: "dev" });
  const repositories = [repository("12-apps/future-pay", "personal"), repository("thomfilg/tools", "personal"), repository("g2i-ai/clickdown", "g2i")];
  const environment = (id, name, companies, extra = {}) => ({ id, name, companies, allowUnassigned: false, archived: false, backend: "local", revision: 1, software: [], variables: [], variablesEnabled: true, ...extra });
  const f = {
    repositories,
    environments: [environment("env-personal", "thomfilg + 12-apps", ["personal"]), environment("env-g2i", "g2i", ["g2i"]), environment("env-personal-alt", "Personal staging", ["personal"]), environment("env-archived", "Archived", ["g2i"], { archived: true })],
    preferences: { agent: "mock", environmentId: empty ? "env-g2i" : "env-personal", repositories: empty ? [] : repositories.slice(0, 2) },
    creates: [], writes: [],
  };
  await page.route("**/api/companies", route => route.fulfill({ json: { companies: [{ id: "personal", name: "thomfilg + 12-apps" }, { id: "g2i", name: "g2i" }] } }));
  await page.route("**/api/github", route => route.fulfill({ json: { connected: true, login: "fixture", connections: ["personal", "g2i"].map(companyId => ({ id: `github-${companyId}`, companyId, connected: true })) } }));
  await page.route("**/api/github/repositories*", route => route.fulfill({ json: { repositories } }));
  await page.route("**/api/github/branches?*", route => route.fulfill({ json: { branches: ["main", "dev"] } }));
  await page.route("**/api/environments", route => route.fulfill({ json: { environments: f.environments, software: [] } }));
  await page.route("**/api/environments/*", route => {
    const saved = route.request().postDataJSON(); f.writes.push(saved);
    f.environments = f.environments.map(env => env.id === saved.id ? saved : env);
    return route.fulfill({ json: { environment: saved } });
  });
  await page.route("**/api/preferences", route => {
    if (route.request().method() === "PATCH") f.preferences = route.request().postDataJSON();
    return route.fulfill({ json: { preferences: f.preferences } });
  });
  await page.route("**/api/chats", route => {
    if (route.request().method() !== "POST") return route.continue();
    f.creates.push(route.request().postDataJSON());
    return route.fulfill({ status: 503, json: { error: "Fixture stops before creating a worker" } });
  });
  await page.goto("/"); await expect(page.locator("#new-chat-fields")).toHaveJSProperty("disabled", false);
  return f;
}

test("remembered repositories do not hide another company's environment; switching keeps the prompt and scopes the draft", async ({ page }) => {
  const f = await fixture(page);
  const select = page.getByRole("combobox", { name: "Environment", exact: true });
  await expect(select.locator("option")).toHaveText(["thomfilg + 12-apps", "g2i", "Personal staging"]);
  await expect(select).toHaveValue("env-personal");
  await page.locator("#initial-prompt").fill("Keep this task while I change companies");
  await select.selectOption("env-g2i");
  await expect(page.locator("#selected-repositories .repository-chip")).toHaveCount(0);
  await expect(page.locator("#initial-prompt")).toHaveValue("Keep this task while I change companies");
  await expect(page.locator("#create-chat-button")).toBeDisabled();
  await expect(page.locator("#environment-selection-hint")).toContainText("g2i");
  await expect.poll(() => f.preferences.environmentId).toBe("env-g2i");
  expect(f.preferences.repositories).toEqual([]); expect(f.creates).toEqual([]); expect(f.writes).toEqual([]);
  await page.getByRole("button", { name: "Add repositories", exact: true }).click();
  await expect(page.locator("#repository-results .repository-option")).toHaveCount(1);
  await page.locator("#repository-results").getByRole("checkbox", { name: /g2i-ai\/clickdown/ }).check();
  await page.getByRole("button", { name: "Add repositories", exact: true }).click();
  await expect(select).toHaveValue("env-g2i"); await expect(page.locator("#create-chat-button")).toBeEnabled();
  await expect(page.locator("#environment-selection-hint")).toBeHidden();
  await page.locator("#initial-prompt").press("Enter");
  await expect(page.locator("#create-chat-error")).toHaveText("Fixture stops before creating a worker");
  expect(f.creates).toHaveLength(1); expect(f.creates[0].environmentId).toBe("env-g2i");
  expect(f.creates[0].repositories.map(repo => repo.fullName)).toEqual(["g2i-ai/clickdown"]);
  await expect(page.locator("#initial-prompt")).toHaveValue("Keep this task while I change companies");
  await expect.poll(() => f.preferences.repositories[0]?.fullName).toBe("g2i-ai/clickdown");
  await page.reload(); await expect(page.locator("#new-chat-fields")).toHaveJSProperty("disabled", false);
  await expect(select).toHaveValue("env-g2i"); await expect(select.locator("option")).toHaveCount(3);
  await expect(page.locator("#selected-repositories")).toContainText("clickdown");
});

test("a scoped environment stays selectable without repositories and the empty draft choice survives reload", async ({ page }) => {
  const f = await fixture(page, { empty: true });
  const select = page.getByRole("combobox", { name: "Environment", exact: true });
  await expect(select).toHaveValue("env-g2i"); await expect(select.locator("option")).toHaveCount(3);
  await page.locator("#initial-prompt").fill("Not a valid unassigned chat");
  await expect(page.locator("#create-chat-button")).toBeDisabled();
  await page.locator("#new-chat-form").dispatchEvent("submit");
  await expect(page.locator("#create-chat-error")).toContainText("Choose a repository");
  expect(f.creates).toEqual([]);
  await select.selectOption("env-personal"); await expect.poll(() => f.preferences.environmentId).toBe("env-personal");
  await page.reload(); await expect(page.locator("#new-chat-fields")).toHaveJSProperty("disabled", false);
  await expect(select).toHaveValue("env-personal"); await expect(page.locator("#create-chat-button")).toBeDisabled();
  await select.selectOption("env-g2i");
  await page.getByRole("button", { name: "Add repositories", exact: true }).click();
  await expect(page.locator("#repository-results .repository-option")).toHaveCount(1);
});

test("switching environments for the same company keeps repositories from different GitHub owners and their branches", async ({ page }) => {
  const f = await fixture(page);
  await page.getByRole("combobox", { name: "Environment", exact: true }).selectOption("env-personal-alt");
  await expect(page.locator("#selected-repositories .repository-chip")).toHaveCount(2);
  for (const name of ["12-apps/future-pay", "thomfilg/tools"]) await expect(page.getByRole("combobox", { name: `Branch for ${name}`, exact: true })).toHaveValue("dev");
  await expect(page.locator("#create-chat-button")).toBeEnabled();
  await expect.poll(() => f.preferences.environmentId).toBe("env-personal-alt");
  expect(f.preferences.repositories.map(repo => repo.companyId)).toEqual(["personal", "personal"]);
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.locator("#new-chat-page").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("environment-switch-mobile.png"), fullPage: true });
});

test("saving a different company environment selects it with the same draft isolation as the dropdown", async ({ page }) => {
  const f = await fixture(page);
  await page.locator("#initial-prompt").fill("Keep the task after environment settings");
  await page.locator("#environment-settings").click();
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#environment-tabs").getByRole("button", { name: "g2i", exact: true }).click();
  await page.getByRole("button", { name: "Save environment", exact: true }).click();
  await expect(page.locator("#environment-save-status")).toHaveText("Saved securely");
  await page.getByRole("button", { name: "Close environments", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Environment", exact: true })).toHaveValue("env-g2i");
  await expect(page.locator("#selected-repositories .repository-chip")).toHaveCount(0);
  await expect(page.locator("#initial-prompt")).toHaveValue("Keep the task after environment settings");
  await expect(page.locator("#create-chat-button")).toBeDisabled();
  expect(f.writes).toHaveLength(1); expect(f.writes[0].companies).toEqual(["g2i"]); expect(f.creates).toEqual([]);
});
