import { test, expect } from "@playwright/test";

async function fixture(page) {
  const repo = (fullName, companyId, branch = "dev") => ({ fullName, companyId, branch, defaultBranch: "main", githubConnectionId: `github-${companyId}` });
  const repositories = [repo("g2i-ai/macrosoft", "g2i"), repo("12-apps/future-pay", "personal"), repo("12-apps/shared-packages", "personal", "main")];
  const snapshots = {
    g2i: { environmentId: "env-g2i", agent: "codex", agentAccountId: "account-work", model: "fixture-gpt", effort: "high", repositories: repositories.slice(0, 1) },
    personal: { environmentId: "env-personal", agent: "codex", agentAccountId: "account-personal", model: "gpt-5.6-sol", effort: "low", repositories: repositories.slice(1) },
  };
  const chats = Object.entries(snapshots).map(([company, snapshot]) => ({ ...snapshot, id: `chat-${company}`, title: `${company} latest task`, status: "stopped", updatedAt: "2026-09-19T12:00:00Z", createdAt: "2026-09-19T11:00:00Z", messages: [{ role: "user", text: "Never copy this task" }], attachments: [{ name: "private-attachment.txt" }] }));
  const f = { snapshots: structuredClone(snapshots), preferences: structuredClone(snapshots.g2i), calls: [], restores: [], warnings: [], hold: null, models: [], holdModel: null };
  await page.route("**/api/config", async route => { const response = await route.fetch(), config = await response.json(); config.features.agentAccounts = true; config.agents = [{ id: "codex", enabled: true, label: "Codex" }]; await route.fulfill({ json: config }); });
  await page.route("**/api/companies", route => route.fulfill({ json: { companies: [{ id: "g2i", name: "g2i" }, { id: "personal", name: "thomfilg + 12-apps" }] } }));
  await page.route("**/api/agent-accounts", route => route.fulfill({ json: { accounts: ["work", "personal"].map(name => ({ id: `account-${name}`, name, provider: "codex", status: "connected" })) } }));
  await page.route("**/api/models?*", async route => {
    const account = new URL(route.request().url()).searchParams.get("account"); f.models.push(account);
    if (f.holdModel?.account === account) await f.holdModel.promise;
    await route.fulfill({ json: { source: "fixture", models: ["fixture-gpt", "gpt-5.6-sol"].map(id => ({ id, label: id, efforts: ["low", "medium", "high"] })) } });
  });
  await page.route("**/api/github", route => route.fulfill({ json: { connected: true, login: "fixture", connections: ["g2i", "personal"].map(companyId => ({ id: `github-${companyId}`, companyId, connected: true })) } }));
  await page.route("**/api/github/repositories*", route => route.fulfill({ json: { repositories } }));
  await page.route("**/api/github/branches?*", route => route.fulfill({ json: { branches: ["main", "dev"] } }));
  await page.route("**/api/environments", route => route.fulfill({ json: { environments: ["g2i", "personal", "personal-alt"].map(name => ({ id: `env-${name}`, name, companies: [name === "personal-alt" ? "personal" : name], allowUnassigned: false, archived: false })), software: [] } }));
  await page.route("**/api/preferences", route => {
    if (route.request().method() === "PATCH") {
      f.preferences = route.request().postDataJSON();
      const company = f.preferences.repositories[0]?.companyId || f.preferences.environmentId.replace("env-", "");
      f.snapshots[company] = structuredClone(f.preferences);
    }
    return route.fulfill({ json: { preferences: f.preferences, selectionMemory: true } });
  });
  await page.route("**/api/preferences/restore?*", async route => {
    const url = new URL(route.request().url()), company = url.searchParams.get("company"); f.restores.push(company);
    const result = { selection: structuredClone(f.snapshots[company]), found: true, companyId: company, warnings: f.warnings };
    if (f.hold?.company === company) await f.hold.promise;
    await route.fulfill({ json: result });
  });
  await page.route("**/api/sidebar", route => route.fulfill({ json: { chats, groups: [], preferences: { sort: "updated_desc", collapsed: [] } } }));
  await page.route("**/api/chats", route => {
    if (route.request().method() !== "POST") return route.continue();
    f.calls.push(route.request().postDataJSON()); return route.fulfill({ status: 503, json: { error: "Unexpected chat creation" } });
  });
  page.on("request", request => { if (/\/(?:wake|messages)$/.test(new URL(request.url()).pathname)) f.calls.push(request.url()); });
  await page.goto("/#new"); await expect(page.locator("#new-chat-fields")).toHaveJSProperty("disabled", false);
  await expect(page.locator("#new-agent-account")).toHaveValue("account-work");
  return f;
}

test("the selected repository opens its picker and the new-chat send control stays inside the compact input", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "Change repository g2i-ai/macrosoft" }).click();
  await expect(page.locator("#repository-picker .repository-picker-dropdown")).toHaveAttribute("open", "");
  await expect(page.locator("#repo-search")).toBeFocused();
  await expect(page.locator("#new-chat-form .composer-input-row #create-chat-button")).toBeVisible();
  await expect(page.locator("#new-chat-form .composer-input-row #create-chat-button")).toHaveCSS("position", "absolute");
});

test("a slow project restore does not trap repository selection", async ({ page }) => {
  const f = await fixture(page), gate = Promise.withResolvers();
  f.hold = { company: "personal", promise: gate.promise };
  try {
    await page.getByRole("combobox", { name: "Environment", exact: true }).selectOption("env-personal");
    await expect.poll(() => f.restores.includes("personal")).toBe(true);
    await page.getByRole("button", { name: "Add repositories" }).click();
    await page.locator("#repository-results .repository-option").filter({ hasText: "12-apps/future-pay" }).locator("input").check();
    await expect(page.getByRole("button", { name: "Change repository 12-apps/future-pay" })).toBeVisible();
    gate.resolve();
    await expect(page.getByRole("button", { name: "Change repository 12-apps/future-pay" })).toBeVisible();
  } finally { gate.resolve(); }
});

test("company switching restores full repository/branch/account/model selection and keeps the user's unsent draft across switches", async ({ page }) => {
  const f = await fixture(page), env = page.getByRole("combobox", { name: "Environment", exact: true });
  await expect(page.getByLabel("Branch for g2i-ai/macrosoft", { exact: true })).toHaveValue("dev");
  await page.locator("#initial-prompt").fill("Keep my unsent task");
  await env.selectOption("env-personal");
  await expect(page.locator("#selected-repositories .repository-chip")).toHaveCount(2);
  await expect(page.getByLabel("Branch for 12-apps/future-pay", { exact: true })).toHaveValue("dev");
  await expect(page.getByLabel("Branch for 12-apps/shared-packages", { exact: true })).toHaveValue("main");
  await expect(page.locator("#new-agent-account")).toHaveValue("account-personal");
  await expect(page.locator("#new-model-controls .model-select")).toHaveValue("gpt-5.6-sol");
  await expect(page.locator("#new-model-controls .effort-select")).toHaveValue("low");
  await page.getByLabel("Branch for 12-apps/future-pay", { exact: true }).focus();
  await page.getByLabel("Branch for 12-apps/future-pay", { exact: true }).selectOption("main");
  await expect.poll(() => f.snapshots.personal.repositories[0].branch).toBe("main");
  await env.selectOption("env-g2i");
  await expect(page.getByLabel("Branch for g2i-ai/macrosoft", { exact: true })).toHaveValue("dev");
  await expect(page.locator("#new-agent-account")).toHaveValue("account-work");
  await expect(page.locator("#new-model-controls .effort-select")).toHaveValue("high");
  await expect(page.locator("#initial-prompt")).toHaveValue("Keep my unsent task");
  await env.selectOption("env-personal"); await expect(page.getByLabel("Branch for 12-apps/future-pay", { exact: true })).toHaveValue("main");
  await page.reload(); await expect(page.getByLabel("Branch for 12-apps/future-pay", { exact: true })).toHaveValue("main");
  expect(f.calls).toEqual([]);
});

test("switching to a second environment waits for the saved model and never persists or sends a loading default", async ({ page }) => {
  const f = await fixture(page), gate = Promise.withResolvers(), env = page.getByRole("combobox", { name: "Environment", exact: true });
  f.holdModel = { account: "account-personal", promise: gate.promise };
  try {
    await env.selectOption("env-personal"); await expect.poll(() => f.models.includes("account-personal")).toBe(true);
    await env.selectOption("env-personal-alt");
    await page.locator("#initial-prompt").fill("Do not send before model selection finishes");
    await expect(page.locator("#create-chat-button")).toBeDisabled();
    expect(f.snapshots.personal.model).toBe("gpt-5.6-sol"); expect(f.calls).toEqual([]);
    gate.resolve();
    await expect(page.locator("#new-model-controls .model-select")).toHaveValue("gpt-5.6-sol");
    await expect(page.locator("#new-model-controls .effort-select")).toHaveValue("low");
    await expect(env).toHaveValue("env-personal-alt");
    await expect.poll(() => f.preferences.environmentId).toBe("env-personal-alt");
    expect(f.preferences.model).toBe("gpt-5.6-sol"); expect(f.preferences.effort).toBe("low"); expect(f.calls).toEqual([]);
  } finally { gate.resolve(); }
});

test("a stale model catalog completion cannot publish another company's restore warnings", async ({ page }) => {
  const f = await fixture(page), gate = Promise.withResolvers(), env = page.getByRole("combobox", { name: "Environment", exact: true });
  f.holdModel = { account: "account-personal", promise: gate.promise }; f.warnings = ["Old company warning"];
  try {
    await env.selectOption("env-personal"); await expect.poll(() => f.models.includes("account-personal")).toBe(true);
    f.warnings = []; await env.selectOption("env-g2i"); gate.resolve();
    await expect(page.locator("#new-model-controls .model-select")).toHaveValue("fixture-gpt");
    await expect(page.locator("#new-agent-account")).toHaveValue("account-work");
    await expect(page.locator("#create-chat-error")).toHaveText("");
    await expect(env).toHaveValue("env-g2i"); expect(f.calls).toEqual([]);
  } finally { gate.resolve(); }
});

test("project + is hover/focus accessible, seeds #new without copying chat messages, and remains visible on mobile", async ({ page }, testInfo) => {
  const f = await fixture(page);
  const add = page.getByRole("button", { name: "New chat in 12-apps/future-pay", exact: true });
  await add.locator("..").hover(); await expect(add).toHaveCSS("opacity", "1");
  await page.screenshot({ path: testInfo.outputPath("project-plus-desktop.png"), animations: "disabled" });
  await add.focus(); await expect(add).toHaveCSS("opacity", "1"); await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#new$/);
  await expect(page.locator("#new-agent-account")).toHaveValue("account-personal");
  await expect(page.locator("#initial-prompt")).toHaveValue("");
  await expect(page.locator("#new-chat-page")).not.toContainText("Never copy this task");
  await expect(page.locator("#new-chat-page")).not.toContainText("private-attachment.txt");
  await page.setViewportSize({ width: 390, height: 844 }); await page.locator("#open-sidebar").click();
  const mobileAdd = page.getByRole("button", { name: "New chat in g2i-ai/macrosoft", exact: true });
  await expect(mobileAdd).toHaveCSS("opacity", "1");
  await page.screenshot({ path: testInfo.outputPath("project-plus-mobile.png"), animations: "disabled" });
  await mobileAdd.click(); await expect(page.locator("#new-agent-account")).toHaveValue("account-work");
  expect(f.calls).toEqual([]);
});

test("late restore cannot overwrite a newer company switch; unavailable saved options fail closed", async ({ page }) => {
  const f = await fixture(page), gate = Promise.withResolvers(), env = page.getByRole("combobox", { name: "Environment", exact: true });
  f.hold = { company: "personal", promise: gate.promise };
  await env.selectOption("env-personal"); await expect.poll(() => f.restores.at(-1)).toBe("personal");
  await expect(page.locator("#create-chat-button")).toBeDisabled();
  await env.selectOption("env-g2i"); gate.resolve();
  await expect(env).toHaveValue("env-g2i"); await expect(page.getByLabel("Branch for g2i-ai/macrosoft", { exact: true })).toHaveValue("dev");
  f.hold = null; f.snapshots.personal.repositories = []; f.snapshots.personal.agent = null; f.snapshots.personal.agentAccountId = null;
  f.warnings = ["Saved repositories or branches are no longer available. Choose them again."];
  await env.selectOption("env-personal"); await expect(page.locator("#create-chat-error")).toContainText("no longer available");
  await expect(page.locator("#selected-repositories .repository-chip")).toHaveCount(0);
  await expect(page.locator("#new-agent-account")).toHaveValue(""); await expect(page.locator("#create-chat-button")).toBeDisabled();
  expect(f.calls).toEqual([]);
});
