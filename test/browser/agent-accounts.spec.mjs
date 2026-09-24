import { test as base, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createAgentWebServer } from "../../src/server.mjs";
import { testConfig } from "../helpers.mjs";
import { googleOidcFixture, googleTestEnv } from "../fixtures/google-oidc.mjs";
import { codexAccountFixture } from "../fixtures/codex-account.mjs";
import { CodexAccountError } from "../../src/codex-account-client.mjs";
import { claudeAccountFixture } from "../fixtures/claude-account.mjs";

const test = base.extend({
  relay: async ({}, use) => {
    const root = await mkdtemp("/tmp/relay-accounts-browser-"), google = googleOidcFixture(), codex = codexAccountFixture(), claude = claudeAccountFixture();
    const app = await createAgentWebServer({ config: testConfig(root, { ...googleTestEnv, CODEX_BIN: path.resolve("test/fixtures/fake-codex.mjs"), AGENT_ENABLE_MOCK: "0", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" }),
      googleAuthOptions: { fetchImpl: google.fetch }, agentAccountsOptions: { clientFactory: provider => provider === "claude" ? claude.factory() : codex.factory() } });
    try {
      const { url } = await app.start(); app.config.google.origin = url; await app.googleAuth.initialize();
      await use({ app, url, google, codex, claude });
    } finally { await app.stop(); await rm(root, { recursive: true, force: true }); }
  },
});
async function login(page, relay) {
  await page.route("https://accounts.google.com/**", async route => {
    const url = relay.google.approve(route.request().url()).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
    await route.fulfill({ contentType: "text/html", body: `<a href="${url}">Continue fixture sign-in</a>` });
  });
  await page.goto(relay.url); await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.getByRole("link", { name: "Continue fixture sign-in" }).click();
  await expect(page.locator("#relay-account-button")).toHaveAttribute("title", "owner@example.com");
  await expect(page.locator("#sidebar-user-name")).toContainText("Relay Owner");
  await expect(page.locator("#isolation-label")).toHaveText("Process isolation disabled");
  await expect(page.locator("#agent-accounts-button")).toBeAttached();
  await expect(page.locator("#new-chat-page")).toBeVisible();
}
const card = (page, name) => page.getByRole("region", { name: `${name} · Codex`, exact: true });
async function addAccount(page, name) {
  await page.locator("#agent-account-new").click();
  await expect(page.locator("#agent-account-form")).toBeVisible();
  await page.getByLabel("Account name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Sign in to Codex", exact: true }).click();
}

test("failed disconnect exposes retry instead of unusable reconnect and survives dialog reopen", async ({ page, relay }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, relay); await page.locator("#connect-codex-button").click();
  await addAccount(page, "Retry account"); relay.codex.clients.find(client => client.approve).approve();
  const accountCard = card(page, "Retry account"); await expect(accountCard).toContainText("codex@example.test · Connected");
  const onRevoke = relay.app.agentAccounts.onRevoke;
  relay.app.agentAccounts.onRevoke = async () => { throw Error("private-worker-error"); };
  page.once("dialog", dialog => dialog.accept());
  await accountCard.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(accountCard.getByRole("button", { name: "Retry disconnect", exact: true })).toBeVisible();
  await expect(accountCard.getByRole("button", { name: "Reconnect", exact: true })).toHaveCount(0);
  await expect(accountCard).not.toContainText("private-worker-error");
  await page.screenshot({ path: test.info().outputPath("account-disconnect-retry-mobile.png") });
  await page.getByRole("button", { name: "Close agent accounts" }).click();
  await page.locator("#connect-codex-button").click();
  await expect(accountCard.getByRole("button", { name: "Retry disconnect", exact: true })).toBeVisible();
  relay.app.agentAccounts.onRevoke = onRevoke;
  page.once("dialog", dialog => dialog.accept());
  await accountCard.getByRole("button", { name: "Retry disconnect", exact: true }).click();
  await expect(accountCard.getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
  await expect(accountCard.getByRole("button", { name: "Retry disconnect", exact: true })).toHaveCount(0);
  await accountCard.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(accountCard.getByRole("link", { name: "Open Codex sign-in for Retry account" })).toBeVisible();
});

test("Claude account card owns its link and returned code, enables account models and reconnects without a megazord", async ({ page, relay }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 }); await login(page, relay);
  await expect(page.locator("#new-chat-fields")).toHaveJSProperty("disabled", false); await page.locator("#connect-codex-button").click();
  await page.locator("#agent-account-new").click(); await page.locator("#agent-account-provider").selectOption("claude");
  await page.getByLabel("Account name", { exact: true }).fill("Claude Personal");
  await page.getByRole("button", { name: "Sign in to Claude", exact: true }).click();
  const accountCard = page.getByRole("region", { name: "Claude Personal · Claude", exact: true });
  await expect(accountCard.getByRole("link", { name: "Open Claude sign-in for Claude Personal", exact: true })).toHaveAttribute("href", /^https:\/\/claude\.com\//);
  await expect(accountCard.getByLabel("Claude authorization code for Claude Personal")).toHaveAttribute("type", "password");
  await accountCard.getByLabel("Claude authorization code for Claude Personal").fill("bad-code");
  await accountCard.getByRole("button", { name: "Complete sign-in" }).click();
  await expect(accountCard.getByRole("alert")).toContainText("could not be verified");
  await accountCard.getByLabel("Claude authorization code for Claude Personal").fill("fixture-code#fixture-state");
  await accountCard.getByRole("button", { name: "Complete sign-in" }).click();
  await expect(accountCard).toContainText("claude@example.test · Connected");
  await expect(accountCard.locator("input")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("claude-account-connected-mobile.png") });
  await page.getByRole("button", { name: "Close agent accounts" }).click();
  await expect(page.locator("#agent-select")).toHaveValue("claude");
  const account = relay.app.agentAccounts.list(relay.app.googleAuth.legacyOwnerId)[0];
  await expect(page.getByLabel("Agent", { exact: true })).toHaveValue(account.id);
  await expect(page.locator("#new-model-controls")).toHaveAttribute("data-status", "ready");
  await page.locator("#connect-codex-button").click(); page.once("dialog", dialog => dialog.accept());
  await accountCard.getByRole("button", { name: "Disconnect", exact: true }).click();
  await accountCard.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.locator("#agent-account-form")).toBeHidden();
  await expect(accountCard.getByLabel("Claude authorization code for Claude Personal")).toBeVisible();
  await expect(accountCard.getByRole("link")).toHaveCount(1);
  await accountCard.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
  await expect(accountCard).toContainText("cancelled");
  expect(relay.app.agentAccounts.list(relay.app.googleAuth.legacyOwnerId).length).toBe(1);
  expect(await page.locator("#agent-accounts-dialog").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("missing agent offers account onboarding instead of Invalid agent; device login persists and is explicitly selected", async ({ page, relay }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await login(page, relay);
  await expect(page.locator("#new-chat-fields")).toHaveJSProperty("disabled", false);
  await expect(page.locator("#new-chat-page")).toBeVisible();
  await expect(page.locator("#agent-account-hint")).toContainText("Connect Codex or Claude");
  await expect(page.locator("#create-chat-error")).toHaveText("");
  await expect(page.locator("#new-model-controls")).toBeHidden();
  await expect(page.locator("#create-chat-button")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Manage agent accounts", exact: true })).toHaveText("⚙");
  await expect(page.getByRole("button", { name: "Connect Codex or Claude / manage accounts", exact: true })).toHaveCount(0);
  await page.locator("#connect-codex-button").click();
  await page.locator("#agent-account-new").click();
  await page.getByLabel("Account name", { exact: true }).fill("Personal Codex");
  await page.getByRole("button", { name: "Sign in to Codex", exact: true }).click();
  await expect(card(page, "Personal Codex").getByLabel("Codex sign-in code for Personal Codex")).toHaveText("TEST-1234");
  await expect(card(page, "Personal Codex").getByRole("link", { name: "Open Codex sign-in for Personal Codex" })).toHaveAttribute("href", "https://auth.openai.com/codex/device");
  expect(relay.app.agentAccounts.list(relay.app.googleAuth.legacyOwnerId)[0].status).toBe("pending");
  relay.codex.clients.find(client => client.approve).approve();
  await expect(card(page, "Personal Codex")).toContainText("codex@example.test · Connected");
  await page.getByRole("button", { name: "Close agent accounts" }).click();
  await expect(page.locator("#new-agent-account-field")).toBeVisible();
  await expect(page.locator("#new-agent-account option:checked")).toHaveText("Codex · Personal Codex · codex@example.test");
  await expect(page.locator("#new-model-controls")).toHaveAttribute("data-status", "ready");
  expect(relay.app.store.list()).toEqual([]);
  await page.reload();
  await page.locator("#agent-accounts-button").click();
  await expect(page.locator("#agent-account-list")).toContainText("Personal Codex");
  await expect(page.locator("#agent-account-list")).toContainText("Connected");
  expect(errors).toEqual([]);
});

test("single Agent selector offers every own account and remembers the choice by primary repository", async ({ page, relay }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const repositories = ["12-apps/future-pay", "other/project", "thomfilg/no-environment"].map((fullName, index) => ({
    id: index + 1, fullName, defaultBranch: "main", githubConnectionId: "github-fixture", connectionName: "Fixture GitHub", private: true,
  }));
  await page.route("**/api/github", route => route.fulfill({ json: { connected: true, login: "fixture", repositoryAccess: "github", connections: [{ id: "github-fixture", connected: true, repositoryAccess: "github" }] } }));
  await page.route("**/api/github/repositories*", route => route.fulfill({ json: { repositories } }));
  await page.route("**/api/github/branches?*", route => route.fulfill({ json: { branches: ["main"] } }));
  await page.route("**/api/environments", route => route.fulfill({ json: { environments: [{ id: "environment-fixture", name: "Fixture", companies: ["12-apps", "other"], allowUnassigned: true, archived: false, backend: "local" }], software: [] } }));
  await page.route("**/api/preferences", route => route.fulfill({ json: { preferences: route.request().method() === "PATCH" ? route.request().postDataJSON() : { repositories: [] } } }));
  await login(page, relay);
  const owner = relay.app.googleAuth.legacyOwnerId;
  for (const provider of ["codex", "claude"]) {
    await relay.app.agentAccounts.begin(owner, { provider, name: `Personal ${provider}`, companies: ["12-apps", "thomfilg"], allowUnassigned: false });
    relay[provider].clients.at(-1).approve();
    await expect.poll(() => relay.app.agentAccounts.list(owner).find(account => account.provider === provider)?.status).toBe("connected");
  }
  await page.reload(); await expect(page.locator("#new-chat-fields")).toHaveJSProperty("disabled", false);
  const chooser = page.locator("#repository-picker .repository-picker-dropdown"), accounts = page.locator("#new-agent-account");
  await expect(chooser).not.toHaveAttribute("open", "");
  await expect(accounts).toBeEnabled(); await expect(accounts.locator("option")).toHaveCount(3);
  await expect(page.locator("#agent-select")).toBeHidden();
  await expect(page.locator("#agent-account-requirement")).toBeHidden();
  await expect(page.locator("dialog#new-chat-page")).toHaveCount(0);
  await expect(page.locator("#create-chat-button")).toBeDisabled();
  expect(await page.locator("#repository-picker").evaluate(element => Boolean(element.compareDocumentPosition(document.querySelector("#new-agent-account-field")) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await page.getByRole("button", { name: "Manage agent accounts", exact: true }).click();
  await expect(page.locator("#agent-accounts-dialog")).toBeVisible();
  await expect(page.locator("#agent-account-new")).toBeVisible();
  await page.getByRole("button", { name: "Close agent accounts", exact: true }).click();
  await chooser.locator("summary").click();
  await page.locator("#repository-results").getByRole("checkbox", { name: /12-apps\/future-pay/ }).check();
  await chooser.locator("summary").click();
  for (const provider of ["codex", "claude"]) {
    const account = relay.app.agentAccounts.list(owner).find(item => item.provider === provider);
    await expect(accounts).toBeEnabled(); await expect(accounts.locator("option")).toHaveCount(3);
    await expect(accounts.locator(`option[value="${account.id}"]`)).toHaveCount(1);
    await accounts.selectOption(account.id);
    await expect(page.locator("#create-chat-button")).toBeEnabled();
    await expect(page.locator("#new-model-controls")).toHaveAttribute("data-status", "ready");
  }
  await chooser.locator("summary").click();
  await page.locator("#repository-results").getByRole("checkbox", { name: /other\/project/ }).check();
  await chooser.locator("summary").click();
  await expect(accounts.locator("option")).toHaveCount(3);
  const claude = relay.app.agentAccounts.list(owner).find(item => item.provider === "claude").id;
  const codex = relay.app.agentAccounts.list(owner).find(item => item.provider === "codex").id;
  await expect(accounts).toHaveValue(claude); // Secondary repositories do not change the remembered project.
  await page.getByRole("button", { name: "Make other/project primary", exact: true }).click();
  await expect(accounts).toBeEnabled(); await expect(accounts.locator("option")).toHaveCount(3);
  await accounts.selectOption(codex);
  await expect(page.locator("#new-model-controls")).toHaveAttribute("data-status", "ready");
  await page.getByRole("button", { name: "Make 12-apps/future-pay primary", exact: true }).click();
  await expect(accounts).toHaveValue(claude);
  await page.getByRole("button", { name: "Make other/project primary", exact: true }).click();
  await expect(accounts).toHaveValue(codex);
  await chooser.locator("summary").click();
  await page.locator("#repository-results").getByRole("checkbox", { name: /thomfilg\/no-environment/ }).check();
  await chooser.locator("summary").click();
  await page.getByRole("button", { name: "Make thomfilg/no-environment primary", exact: true }).click();
  await expect(accounts).toBeEnabled();
  await accounts.selectOption(relay.app.agentAccounts.list(owner).find(item => item.provider === "claude").id);
  await expect(page.locator("#environment-select")).toHaveValue("environment-fixture"); await expect(page.locator("#create-chat-button")).toBeDisabled();
  await expect(page.locator("#environment-selection-hint")).toContainText("The selected repositories are not available");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator("#new-chat-page").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(relay.app.store.list()).toEqual([]); expect(errors).toEqual([]);
  for (const account of relay.app.agentAccounts.list(owner)) { expect(account.companies).toBeUndefined(); expect(account.allowUnassigned).toBeUndefined(); }
});

test("repository picker explains GitHub failures and empty results separately from search misses without stale refresh", async ({ page, relay }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  let mode = "empty", releaseOld, oldStarted = false;
  const oldRequest = new Promise(resolve => { releaseOld = resolve; });
  const repository = fullName => ({ id: fullName === "12-apps/future-pay" ? 1 : 2, fullName, defaultBranch: "main", githubConnectionId: "github-fixture", private: true });
  await page.route("**/api/github", route => route.fulfill({ json: { connected: mode !== "auth", login: "fixture", repositoryAccess: "github", connections: [{ id: "github-fixture", name: "Fixture GitHub", login: "fixture", connected: mode !== "auth", repositoryAccess: "github" }] } }));
  await page.route("**/api/github/repositories*", async route => {
    if (mode === "error") return route.fulfill({ status: 503, json: { error: "Private upstream fixture error" } });
    if (mode === "auth") return route.fulfill({ status: 401, json: { error: "GitHub credentials expired or were revoked. Reconnect your account." } });
    if (mode === "hold") { oldStarted = true; await oldRequest; return route.fulfill({ json: { repositories: [repository("12-apps/stale")] } }); }
    return route.fulfill({ json: { repositories: mode === "ready" ? [repository("12-apps/future-pay")] : [] } });
  });
  try {
    await login(page, relay); await expect(page.locator("#new-chat-fields")).toHaveJSProperty("disabled", false);
    await page.getByRole("button", { name: "Add repositories", exact: true }).click();
    await expect(page.locator("#repository-status")).toHaveText("No repositories are available from your connected GitHub accounts. Check GitHub permissions or refresh the list.");
    await page.locator("#repository-manage-github").click(); await expect(page.locator("#github-dialog")).toBeVisible();
    await page.getByRole("button", { name: "Close GitHub dialog", exact: true }).click();
    mode = "error";
    await page.getByRole("button", { name: "Add repositories", exact: true }).click();
    await page.locator("#refresh-repositories").click();
    await expect(page.locator("#repository-status")).toHaveText("Your GitHub accounts are connected, but repositories could not be loaded. Retry; if this continues, check repository permissions or GitHub API limits.");
    await expect(page.locator("#repository-status")).toHaveAttribute("role", "alert");
    await expect(page.locator("#repository-results")).not.toContainText("Private upstream");
    await page.evaluate(() => { window.__relayAuthEvents = 0; window.addEventListener("relay-auth-required", () => window.__relayAuthEvents++); });
    mode = "auth"; await page.locator("#repository-retry").click();
    await expect(page.locator("#repository-status")).toHaveText("GitHub account Fixture GitHub is disconnected. Reconnect in Manage GitHub accounts, then retry.");
    expect(await page.evaluate(() => window.__relayAuthEvents)).toBe(0);
    mode = "empty"; await page.locator("#repository-retry").click();
    await expect(page.locator("#repository-status")).toContainText("No repositories are available from your connected GitHub accounts");
    mode = "ready"; await page.locator("#repository-retry").click();
    await expect(page.locator("#repository-results").getByRole("checkbox", { name: /12-apps\/future-pay/ })).toBeVisible();
    await page.locator("#repo-search").fill("no-match"); await expect(page.locator("#repository-status")).toHaveText("No repositories match your search.");
    await expect(page.locator("#repository-retry")).toHaveCount(0); await page.locator("#repo-search").fill("");
    mode = "hold"; await page.locator("#refresh-repositories").click(); await expect.poll(() => oldStarted).toBe(true);
    mode = "ready"; await page.locator("#refresh-repositories").click();
    await expect(page.locator("#repository-results").getByRole("checkbox", { name: /12-apps\/future-pay/ })).toBeVisible();
    const oldResponse = page.waitForResponse(response => response.url().includes("/api/github/repositories")); releaseOld(); await oldResponse;
    await expect(page.locator("#repository-results")).not.toContainText("12-apps/stale");
    await expect(page.locator("#repository-results").getByRole("checkbox", { name: /12-apps\/future-pay/ })).toBeVisible();
    expect(relay.app.store.list()).toEqual([]); expect(errors).toEqual([]);
  } finally { releaseOld(); }
});

test("mobile onboarding permits cancelling a pending login without project assignment controls", async ({ page, relay }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page, relay);
  // Sidebar is collapsed on mobile; open onboarding via the new-chat action.
  await expect(page.locator("#new-chat-fields")).toHaveJSProperty("disabled", false); await page.locator("#connect-codex-button").click();
  await page.locator("#agent-account-new").click();
  await page.getByLabel("Account name", { exact: true }).fill("Company Codex");
  await expect(page.locator("#agent-account-companies")).toHaveCount(0);
  await page.getByRole("button", { name: "Sign in to Codex", exact: true }).click();
  await expect(card(page, "Company Codex").getByLabel("Codex sign-in code for Company Codex")).toBeVisible();
  expect(await page.locator("#agent-accounts-dialog").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("codex-device-mobile.png") });
  await page.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
  await expect(card(page, "Company Codex")).toContainText("cancelled");
  const account = relay.app.agentAccounts.list(relay.app.googleAuth.legacyOwnerId)[0];
  expect(account.status).toBe("disconnected"); expect(account.companies).toBeUndefined(); expect(account.allowUnassigned).toBeUndefined();
  expect(relay.codex.clients[0].closed).toBe(true);
});

test("a chat explicitly selects among personal and company accounts and shows disconnected access", async ({ page, relay }) => {
  await login(page, relay);
  async function connect(name) {
    await addAccount(page, name);
    await expect(card(page, name).getByLabel(`Codex sign-in code for ${name}`)).toBeVisible();
    relay.codex.clients.at(-1).approve();
    await expect(card(page, name)).toContainText("codex@example.test · Connected");
  }
  await page.locator("#agent-accounts-button").click(); await connect("Personal");
  await page.getByRole("button", { name: "Close agent accounts" }).click();
  const personal = relay.app.agentAccounts.list(relay.app.googleAuth.legacyOwnerId)[0];
  const response = await page.request.post(`${relay.url}/api/chats`, { headers: { origin: relay.url }, data: { agent: "codex", agentAccountId: personal.id, title: "Account picker" } });
  expect(response.status()).toBe(201); const { chat } = await response.json();
  await page.goto(`${relay.url}/#chat=${chat.id}`); await page.reload();
  await expect(page.locator("#chat-agent-select option:checked")).toHaveText("Codex · Personal · codex@example.test");
  await page.locator("#chat-agent-account").click(); await connect("Company");
  const company = relay.app.agentAccounts.list(relay.app.googleAuth.legacyOwnerId).find(account => account.name === "Company");
  page.once("dialog", dialog => dialog.accept());
  await page.locator(".agent-account-card").filter({ hasText: "Company · Codex" }).getByRole("button", { name: "Use in this chat", exact: true }).click();
  await expect(page.locator("#chat-agent-select option:checked")).toHaveText("Codex · Company · codex@example.test");
  expect(relay.app.store.get(chat.id).agentAccountId).toBe(company.id);
  expect(relay.app.store.get(chat.id).workspace).toBe(chat.workspace);
  await page.locator("#chat-agent-account").click(); page.once("dialog", dialog => dialog.accept());
  await page.locator(".agent-account-card").filter({ hasText: "Company · Codex" }).getByRole("button", { name: "Disconnect", exact: true }).click();
  await page.getByRole("button", { name: "Close agent accounts" }).click();
  await expect(page.locator("#chat-agent-select option:checked")).toHaveText("Codex · Company · codex@example.test · reconnect");
  await page.locator("#chat-agent-account").click(); page.once("dialog", dialog => dialog.accept());
  await page.locator(".agent-account-card").filter({ hasText: "Personal · Codex" }).getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(card(page, "Personal")).toContainText("Not connected");
  await expect.poll(() => relay.app.agentAccounts.list(relay.app.googleAuth.legacyOwnerId).some(account => account.status === "connected")).toBe(false);
  await page.getByRole("button", { name: "Close agent accounts" }).click();
  await expect(page.locator("#chat-agent-select")).toHaveValue(company.id);
  await expect(page.locator("#chat-agent-select")).toBeDisabled();
  expect(relay.app.store.get(chat.id).messages).toEqual([]);
});

test("Add account visibly toggles a focused form and preserves its unsent draft", async ({ page, relay }) => {
  await page.setViewportSize({ width: 320, height: 800 }); await login(page, relay);
  await expect(page.locator("#new-chat-fields")).toHaveJSProperty("disabled", false); await page.locator("#connect-codex-button").click();
  const toggle = page.locator("#agent-account-new"), form = page.locator("#agent-account-form");
  await expect(form).toBeHidden(); await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click(); await expect(form).toBeVisible(); await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByLabel("Account name", { exact: true })).toBeFocused();
  await page.getByLabel("Account name", { exact: true }).fill("Unsent personal account");
  await toggle.click(); await expect(form).toBeHidden();
  await toggle.click(); await expect(page.getByLabel("Account name", { exact: true })).toHaveValue("Unsent personal account");
  await expect(form.getByLabel("Unassigned chats (no company)", { exact: true })).toHaveCount(0);
  expect(await page.locator("#agent-accounts-dialog").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.locator("#agent-account-cancel").click(); await expect(form).toBeHidden();
  expect(relay.app.agentAccounts.list(relay.app.googleAuth.legacyOwnerId)).toEqual([]);
});

test("slow code generation shows Connecting immediately and a reloaded pending card acquires its link", async ({ page, relay }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  relay.app.agentAccounts.clientFactory = () => {
    const client = relay.codex.factory(), login = client.login;
    client.login = async function () { await gate; return login.call(this); };
    return client;
  };
  try {
    await login(page, relay); await page.locator("#agent-accounts-button").click(); await addAccount(page, "Slow company");
    await expect(page.locator("#agent-account-submit")).toHaveText("Connecting…");
    await expect(page.locator("#agent-account-submit")).toBeDisabled();
    await expect(page.getByLabel("Account name", { exact: true })).toBeDisabled();
    await expect(page.locator("#agent-account-progress")).toContainText("Slow company");
    await expect(card(page, "Slow company")).toContainText("Preparing your sign-in link");
    await expect(page.locator("#agent-accounts-dialog")).not.toContainText("Sign-in is not pending");
    await page.reload(); await page.locator("#agent-accounts-button").click();
    await expect(card(page, "Slow company")).toContainText("Preparing your sign-in link");
    await expect(card(page, "Slow company").getByRole("link")).toHaveCount(0);
    release();
    await expect(card(page, "Slow company").getByLabel("Codex sign-in code for Slow company")).toHaveText("TEST-1234");
    await expect(card(page, "Slow company").getByRole("link", { name: "Open Codex sign-in for Slow company" })).toBeVisible();
    relay.codex.clients.find(client => client.approve).approve();
    await expect(card(page, "Slow company")).toContainText("codex@example.test · Connected");
    await expect(card(page, "Slow company").locator("code")).toHaveCount(0);
    expect(relay.app.agentAccounts.list(relay.app.googleAuth.legacyOwnerId)).toHaveLength(1);
  } finally { release(); }
});

test("each pending account owns its link and code while adding, reopening, copying and cancelling another account", async ({ page, relay }) => {
  let codeNumber = 0;
  relay.app.agentAccounts.clientFactory = () => { const client = relay.codex.factory(); client.userCode = `TEST-${String(++codeNumber).padStart(4, "0")}`; return client; };
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page, relay); await page.locator("#agent-accounts-button").click(); await addAccount(page, "Personal");
  await expect(card(page, "Personal").locator("code")).toBeVisible();
  relay.codex.clients.find(client => client.approve).approve();
  await expect(card(page, "Personal")).toContainText("codex@example.test · Connected");
  await addAccount(page, "UMG"); await expect(card(page, "UMG").locator("code")).toBeVisible();
  const companyCode = await card(page, "UMG").locator("code").textContent();
  await expect(card(page, "Personal").getByRole("link")).toHaveCount(0);
  await page.getByRole("button", { name: "Close agent accounts" }).click(); await page.locator("#agent-accounts-button").click();
  await expect(page.locator("#agent-account-form")).toBeHidden();
  await expect(card(page, "UMG").locator("code")).toHaveText(companyCode);
  await addAccount(page, "Another company"); await expect(card(page, "Another company").locator("code")).toBeVisible();
  const anotherCode = await card(page, "Another company").locator("code").textContent();
  expect(anotherCode).not.toBe(companyCode);
  await card(page, "UMG").getByRole("button", { name: "Copy code", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(companyCode);
  await page.context().route("https://auth.openai.com/codex/device", route => route.fulfill({ contentType: "text/html", body: "<p>Offline sign-in fixture; no account authorized.</p>" }));
  const opened = page.waitForEvent("popup"); await card(page, "UMG").getByRole("link", { name: "Open Codex sign-in for UMG" }).click();
  const popup = await opened; await popup.waitForLoadState(); expect(popup.url()).toBe("https://auth.openai.com/codex/device"); await popup.close();
  await page.screenshot({ path: test.info().outputPath("codex-account-scoped-login.png") });
  await card(page, "UMG").getByRole("button", { name: "Cancel sign-in", exact: true }).click();
  await expect(card(page, "UMG")).toContainText("cancelled"); await expect(card(page, "UMG").locator("code")).toHaveCount(0);
  await expect(card(page, "Another company").locator("code")).toHaveText(anotherCode);
  await expect(card(page, "Personal")).toContainText("codex@example.test · Connected");
  expect(relay.app.agentAccounts.list(relay.app.googleAuth.legacyOwnerId).find(account => account.name === "Another company").status).toBe("pending");
});

test("failed sign-in restores the form and preserves name and company choices for retry", async ({ page, relay }) => {
  let attempts = 0;
  await page.route(/\/api\/agent-accounts$/, async route => {
    if (route.request().method() !== "POST" || ++attempts !== 1) return route.continue();
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Codex temporarily unavailable. Retry sign-in." }) });
  });
  await login(page, relay); await page.locator("#agent-accounts-button").click(); await addAccount(page, "Retry personal");
  await expect(page.locator("#agent-account-error")).toContainText("temporarily unavailable");
  await expect(page.locator("#agent-account-submit")).toBeEnabled(); await expect(page.locator("#agent-account-submit")).toHaveText("Sign in to Codex");
  await expect(page.getByLabel("Account name", { exact: true })).toHaveValue("Retry personal");
  await expect(page.locator("#agent-account-companies")).toHaveCount(0);
  await page.locator("#agent-account-submit").click(); await expect(card(page, "Retry personal").locator("code")).toBeVisible();
  expect(attempts).toBe(2); expect(relay.app.agentAccounts.list(relay.app.googleAuth.legacyOwnerId)).toHaveLength(1);
});

test("a delayed pending-status response cannot restore a cancelled account's code", async ({ page, relay }) => {
  await login(page, relay); await page.locator("#agent-accounts-button").click(); await addAccount(page, "Cancel race");
  await expect(card(page, "Cancel race").locator("code")).toBeVisible();
  let release, held;
  const gate = new Promise(resolve => { release = resolve; }), intercepted = new Promise(resolve => { held = resolve; });
  const id = relay.app.agentAccounts.list(relay.app.googleAuth.legacyOwnerId)[0].id;
  await page.route(`${relay.url}/api/agent-accounts/${id}`, async route => {
    const response = await route.fetch(); held(); await gate; await route.fulfill({ response });
  });
  try {
    await intercepted;
    await card(page, "Cancel race").getByRole("button", { name: "Cancel sign-in", exact: true }).click();
    await expect(card(page, "Cancel race")).toContainText("cancelled");
    const delivered = page.waitForResponse(`${relay.url}/api/agent-accounts/${id}`); release(); await delivered;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(card(page, "Cancel race").locator("code")).toHaveCount(0);
    await expect(card(page, "Cancel race").getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
  } finally { release(); }
});

test("Reconnect is one click inside the saved account, preserves identity and exposes a retryable startup error only once", async ({ page, relay }) => {
  await login(page, relay); await page.locator("#agent-accounts-button").click();
  await page.locator("#agent-account-new").click();
  await page.getByLabel("Account name", { exact: true }).fill("Personal");
  await page.getByRole("button", { name: "Sign in to Codex", exact: true }).click();
  await expect(card(page, "Personal").locator("code")).toBeVisible();
  relay.codex.clients.at(-1).approve(); await expect(card(page, "Personal")).toContainText("Connected");
  page.once("dialog", dialog => dialog.accept());
  await card(page, "Personal").getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(card(page, "Personal").getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
  const original = relay.app.agentAccounts.list(relay.app.googleAuth.legacyOwnerId)[0];
  const gate = Promise.withResolvers(); let failStart = true;
  relay.app.agentAccounts.clientFactory = () => {
    const client = relay.codex.factory(), start = client.start;
    client.start = async function (auth) { await gate.promise; if (failStart) throw new CodexAccountError("startup_timeout"); return start.call(this, auth); };
    return client;
  };
  try {
    await card(page, "Personal").getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(card(page, "Personal").getByRole("status")).toContainText("Connecting to Codex");
    await expect(page.locator("#agent-account-form")).toBeHidden();
    gate.resolve();
    const message = new CodexAccountError("startup_timeout").message;
    await expect(card(page, "Personal").getByText(message, { exact: true })).toHaveCount(1);
    await expect(card(page, "Personal").getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("codex-reconnect-simple.png") });
    failStart = false;
    await card(page, "Personal").getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(card(page, "Personal").locator("code")).toBeVisible();
    await expect(page.locator("#agent-account-form")).toBeHidden();
    const saved = relay.app.agentAccounts.list(relay.app.googleAuth.legacyOwnerId);
    expect(saved).toHaveLength(1); expect(saved[0].id).toBe(original.id);
    expect(saved[0].name).toBe(original.name); expect(saved[0].companies).toBeUndefined();
    await page.locator("#agent-account-new").click();
    await expect(page.locator("#agent-account-companies")).toHaveCount(0);
    await expect(page.locator(".agent-account-help")).not.toHaveAttribute("open", "");
  } finally { gate.resolve(); }
});

test("a post-consent verification failure is shown once and the same account can reconnect", async ({ page, relay }) => {
  let attempt = 0;
  relay.app.agentAccounts.clientFactory = () => {
    const client = relay.codex.factory();
    if (++attempt === 1) client.snapshot = async () => { throw new CodexAccountError("verification_timeout"); };
    return client;
  };
  await login(page, relay); await page.locator("#agent-accounts-button").click(); await addAccount(page, "Personal");
  await expect(card(page, "Personal").locator("code")).toBeVisible();
  const original = relay.app.agentAccounts.list(relay.app.googleAuth.legacyOwnerId)[0];
  relay.codex.clients[0].approve();
  const message = new CodexAccountError("verification_timeout").message;
  await expect(card(page, "Personal").getByText(message, { exact: true })).toHaveCount(1);
  await expect(card(page, "Personal").locator("code")).toHaveCount(0);
  await expect(card(page, "Personal").getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
  expect((await relay.app.records.get("agent-account", original.id)).auth).toBeNull();
  await card(page, "Personal").getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(card(page, "Personal").locator("code")).toBeVisible();
  relay.codex.clients.at(-1).approve();
  await expect(card(page, "Personal")).toContainText("codex@example.test · Connected");
  await expect(card(page, "Personal").getByText(message, { exact: true })).toHaveCount(0);
  expect(relay.app.agentAccounts.list(relay.app.googleAuth.legacyOwnerId).map(account => account.id)).toEqual([original.id]);
});

for (const provider of ["codex", "claude"]) test(`${provider} Delete account is confirmed, cancels pending consent and removes connected accounts without affecting another account`, async ({ page, relay }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await login(page, relay); await page.locator("#agent-accounts-button").click();
  await addAccount(page, "Keep me"); await expect(card(page, "Keep me").locator("code")).toBeVisible();
  relay.codex.clients.at(-1).approve(); await expect(card(page, "Keep me")).toContainText("Connected");
  await page.locator("#agent-account-new").click(); await page.locator("#agent-account-provider").selectOption(provider);
  await page.getByLabel("Account name", { exact: true }).fill("Delete me");
  await page.locator("#agent-account-submit").click();
  const row = page.getByRole("region", { name: `Delete me · ${provider === "claude" ? "Claude" : "Codex"}`, exact: true });
  await expect(row.getByRole("link")).toBeVisible();
  page.once("dialog", dialog => { expect(dialog.message()).toContain("Conversations stay saved"); expect(dialog.message()).toContain("does not delete your"); return dialog.dismiss(); });
  await row.getByRole("button", { name: "Delete account", exact: true }).click(); await expect(row).toBeVisible();
  const client = relay[provider].clients.at(-1);
  page.once("dialog", dialog => dialog.accept()); await row.getByRole("button", { name: "Delete account", exact: true }).click();
  await expect(row).toHaveCount(0); expect(client.closed).toBe(true); client.approve();
  await expect(card(page, "Keep me")).toContainText("Connected");
  page.once("dialog", dialog => dialog.accept()); await card(page, "Keep me").getByRole("button", { name: "Delete account", exact: true }).click();
  await expect(page.locator("#agent-account-list")).toContainText("No agent accounts yet");
  await page.reload(); await page.locator("#agent-accounts-button").click();
  await expect(page.locator(".agent-account-card")).toHaveCount(0); expect(errors).toEqual([]);
});

test("deleted account cannot return from delayed status or list responses", async ({ page, relay }) => {
  await login(page, relay); await page.locator("#agent-accounts-button").click(); await addAccount(page, "Delete race");
  await expect(card(page, "Delete race").locator("code")).toBeVisible();
  const id = relay.app.agentAccounts.list(relay.app.googleAuth.legacyOwnerId)[0].id;
  const gate = Promise.withResolvers(), polled = Promise.withResolvers(), listed = Promise.withResolvers();
  await page.route(`${relay.url}/api/agent-accounts/${id}`, async route => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch(); polled.resolve(); await gate.promise; await route.fulfill({ response });
  });
  await page.route(`${relay.url}/api/agent-accounts`, async route => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch(); listed.resolve(); await gate.promise; await route.fulfill({ response });
  });
  try {
    await page.evaluate(() => window.dispatchEvent(new Event("relay-agent-accounts-changed")));
    await Promise.all([polled.promise, listed.promise]);
    page.once("dialog", dialog => dialog.accept()); await card(page, "Delete race").getByRole("button", { name: "Delete account", exact: true }).click();
    await expect(card(page, "Delete race")).toHaveCount(0); gate.resolve();
    await expect(page.locator("#agent-account-list")).toContainText("No agent accounts yet");
    await page.getByRole("button", { name: "Close agent accounts" }).click(); await page.locator("#agent-accounts-button").click();
    await expect(card(page, "Delete race")).toHaveCount(0);
  } finally { gate.resolve(); }
});

test("a delayed sign-in POST response cannot resurrect an account deleted while the response was in flight", async ({ page, relay }) => {
  const gate = Promise.withResolvers(), submitted = Promise.withResolvers();
  await page.route(`${relay.url}/api/agent-accounts`, async route => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch(); submitted.resolve(); await gate.promise; await route.fulfill({ response });
  });
  try {
    await login(page, relay); await page.locator("#agent-accounts-button").click(); await addAccount(page, "Slow response");
    await submitted.promise;
    await expect(card(page, "Slow response").getByRole("button", { name: "Delete account", exact: true })).toBeVisible();
    page.once("dialog", dialog => dialog.accept()); await card(page, "Slow response").getByRole("button", { name: "Delete account", exact: true }).click();
    await expect(card(page, "Slow response")).toHaveCount(0); gate.resolve();
    await expect(page.locator("#agent-account-submit")).toBeEnabled();
    await expect(card(page, "Slow response")).toHaveCount(0);
  } finally { gate.resolve(); }
});

test("failed deletion reports blocked access and can be retried on that account card", async ({ page, relay }) => {
  await login(page, relay); await page.locator("#agent-accounts-button").click(); await addAccount(page, "Retry deletion");
  await expect(card(page, "Retry deletion").locator("code")).toBeVisible();
  const erase = relay.app.records.delete.bind(relay.app.records); let failOnce = true;
  relay.app.records.delete = async (...args) => { if (args[0] === "agent-account" && failOnce) { failOnce = false; throw Error("private storage failure"); } return erase(...args); };
  page.once("dialog", dialog => dialog.accept()); await card(page, "Retry deletion").getByRole("button", { name: "Delete account", exact: true }).click();
  await expect(card(page, "Retry deletion").getByRole("alert")).toContainText("Access is blocked");
  await expect(card(page, "Retry deletion")).not.toContainText("private storage failure");
  page.once("dialog", dialog => dialog.accept()); await card(page, "Retry deletion").getByRole("button", { name: "Delete account", exact: true }).click();
  await expect(card(page, "Retry deletion")).toHaveCount(0);
});
