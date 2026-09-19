import { test, expect } from "@playwright/test";

async function fixture(page, { empty = false, shared = false } = {}) {
  const repository = (fullName, companyId) => ({ fullName, companyId, githubConnectionId: `github-${companyId}`, defaultBranch: "main", branch: "dev" });
  const repositories = [repository("12-apps/future-pay", "personal"), repository("thomfilg/tools", "personal"), repository("g2i-ai/clickdown", "g2i")];
  const environment = (id, name, companies, extra = {}) => ({ id, name, companies, allowUnassigned: false, archived: false, backend: "local", revision: 1, software: [], variables: [], variablesEnabled: true, ...extra });
  const f = {
    repositories,
    environments: [environment("env-personal", "thomfilg + 12-apps", ["personal"]), environment("env-g2i", "g2i", ["g2i"]), environment("env-personal-alt", "Personal staging", ["personal"]), environment("env-archived", "Archived", ["g2i"], { archived: true })],
    preferences: { agent: "mock", environmentId: empty ? "env-g2i" : "env-personal", repositories: empty ? [] : repositories.slice(0, 2) },
    creates: [], writes: [],
  };
  if (shared) Object.assign(f.environments[0], { companies: ["personal", "g2i"], allowUnassigned: true, variables: [{ key: "PRIVATE_TOKEN", secret: true, enabled: true, hasValue: true }], setupScript: "echo ready" });
  await page.route("**/api/companies", route => route.fulfill({ json: { companies: [{ id: "personal", name: "thomfilg + 12-apps" }, { id: "g2i", name: "g2i" }] } }));
  await page.route("**/api/github", route => route.fulfill({ json: { connected: true, login: "fixture", connections: ["personal", "g2i"].map(companyId => ({ id: `github-${companyId}`, companyId, connected: true })) } }));
  await page.route("**/api/github/repositories*", route => route.fulfill({ json: { repositories } }));
  await page.route("**/api/github/branches?*", route => route.fulfill({ json: { branches: ["main", "dev"] } }));
  await page.route("**/api/environments", route => {
    if (route.request().method() === "POST") {
      const saved = { ...route.request().postDataJSON(), id: "env-new" }; f.writes.push(saved); f.environments.push(saved);
      return route.fulfill({ json: { environment: saved } });
    }
    return route.fulfill({ json: { environments: f.environments, software: [{ id: "node", name: "Node.js", version: "22", description: "JavaScript runtime" }] } });
  });
  await page.route("**/api/environments/*", route => {
    const saved = route.request().postDataJSON(); f.writes.push(saved);
    if (f.failSave) return route.fulfill({ status: 503, json: { error: "Fixture save failed. Your changes are kept." } });
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
  await expect(page.locator("#save-environment")).toBeDisabled();
  await page.locator("#environment-company-filter").selectOption("g2i");
  await expect(page.locator("#environment-editor-select option")).toHaveText(["g2i", "Archived · Archived"]);
  await page.locator("#environment-name").fill("g2i updated");
  await page.getByRole("button", { name: "Save environment", exact: true }).click();
  await expect(page.locator("#environments-dialog")).not.toBeVisible();
  await expect(page.getByRole("combobox", { name: "Environment", exact: true })).toHaveValue("env-g2i");
  await expect(page.locator("#selected-repositories .repository-chip")).toHaveCount(0);
  await expect(page.locator("#initial-prompt")).toHaveValue("Keep the task after environment settings");
  await expect(page.locator("#create-chat-button")).toBeDisabled();
  expect(f.writes).toHaveLength(1); expect(f.writes[0].companies).toEqual(["g2i"]); expect(f.creates).toEqual([]);
});

test("environment cards retain edits across editors, protect switches and close only after a successful save", async ({ page }) => {
  const f = await fixture(page, { shared: true });
  await page.locator("#environment-settings").click();
  const save = page.locator("#save-environment");
  await expect(save).toBeDisabled();
  await expect(page.locator("#environment-summary-cards button")).toHaveCount(3);
  await page.screenshot({ path: test.info().outputPath("environment-cards-desktop.png") });
  await expect(page.locator("#environment-editor-select option")).toHaveText(["thomfilg + 12-apps", "Personal staging"]);
  await page.locator('[data-environment-section="software"]').click();
  await page.locator("#software-options input").check();
  await expect(save).toBeEnabled();
  await page.locator("#environment-editor-back").click();
  await page.locator('[data-environment-section="setup"]').click();
  await page.locator("#environment-setup-script").fill("echo updated");
  await page.locator("#environment-editor-back").click();
  await page.locator('[data-environment-section="variables"]').click();
  await expect(page.locator("#environment-setup-editor")).toBeHidden();
  await expect(page.locator("#environment-software-editor")).toBeHidden();
  await page.getByRole("button", { name: "Add variable", exact: false }).click();
  await page.getByRole("textbox", { name: "Variable 2 name", exact: true }).fill("PUBLIC_VALUE");
  await page.getByLabel("Variable 2 value", { exact: true }).fill("fixture-value");
  await page.getByLabel("Variable 2 visibility", { exact: true }).selectOption("public");
  await page.locator("#environment-editor-back").click();
  await expect(page.locator("#environment-software-summary")).toHaveText("1 selected");
  await expect(page.locator("#environment-variables-summary")).toHaveText("2 variables");
  await expect(page.locator("#environment-summary-cards")).not.toContainText("fixture-value");
  page.once("dialog", dialog => dialog.dismiss());
  await page.locator("#environment-company-filter").selectOption("g2i");
  await expect(page.locator("#environment-company-filter")).toHaveValue("personal");
  page.once("dialog", dialog => dialog.dismiss());
  await page.locator("#environment-editor-select").selectOption("env-personal-alt");
  await expect(page.locator("#environment-editor-select")).toHaveValue("env-personal");
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "Close environments", exact: true }).click();
  await expect(page.locator("#environments-dialog")).toBeVisible();
  f.failSave = true; await save.click();
  await expect(page.locator("#environment-error")).toContainText("Your changes are kept");
  await expect(save).toBeEnabled();
  await page.locator('[data-environment-section="setup"]').click();
  await expect(page.locator("#environment-setup-script")).toHaveValue("echo updated");
  f.failSave = false; await save.click();
  await expect(page.locator("#environments-dialog")).not.toBeVisible();
  expect(f.writes).toHaveLength(2);
  expect(f.writes[1].companies).toEqual(["personal", "g2i"]);
  expect(f.writes[1].allowUnassigned).toBe(true);
  expect(f.writes[1].variables[0]).toEqual({ key: "PRIVATE_TOKEN", secret: true, enabled: true, hasValue: true });
  expect(f.writes[1].variables[1].value).toBe("fixture-value");
});

test("unchanged and reverted environment edits never save; narrow editors keep Save in view", async ({ page }) => {
  const f = await fixture(page);
  await page.setViewportSize({ width: 390, height: 740 });
  await page.locator("#environment-settings").click();
  await expect(page.locator("#save-environment")).toBeDisabled();
  await page.locator("#environment-name").fill("Changed");
  await expect(page.locator("#save-environment")).toBeEnabled();
  await page.locator("#environment-name").fill("thomfilg + 12-apps");
  await expect(page.locator("#save-environment")).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath("environment-cards-390.png") });
  await page.locator('[data-environment-section="variables"]').click();
  for (let i = 0; i < 8; i++) await page.locator("#add-variable").click();
  await expect(page.locator("#save-environment")).toBeInViewport();
  expect(await page.locator("#environments-dialog").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("environment-variables-390.png") });
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(page.locator("#save-environment")).toBeInViewport();
  expect(await page.locator("#environments-dialog").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("environment-variables-320.png") });
  expect(f.writes).toEqual([]);
});

test("adding an environment grants only the explicitly selected company", async ({ page }) => {
  const f = await fixture(page, { shared: true });
  await page.locator("#environment-settings").click();
  await page.locator("#environment-company-filter").selectOption("g2i");
  await page.locator("#add-environment").click();
  await expect(page.locator("#save-environment")).toBeDisabled();
  await page.locator("#environment-name").fill("g2i sandbox");
  await page.locator("#save-environment").click();
  await expect(page.locator("#environments-dialog")).not.toBeVisible();
  expect(f.writes).toHaveLength(1); expect(f.writes[0].companies).toEqual(["g2i"]);
  expect(f.writes[0].allowUnassigned).toBe(false); expect(f.writes[0].variables).toEqual([]);
});
