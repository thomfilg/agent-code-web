import { test as base, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createAgentWebServer } from "../../src/server.mjs";
import { testConfig } from "../helpers.mjs";
import { googleOidcFixture, googleTestEnv } from "../fixtures/google-oidc.mjs";
import { codexAccountFixture } from "../fixtures/codex-account.mjs";
import { CodexAccountError } from "../../src/codex-account-client.mjs";

const test = base.extend({
  relay: async ({}, use) => {
    const root = await mkdtemp("/tmp/relay-accounts-browser-"), google = googleOidcFixture(), codex = codexAccountFixture();
    const app = await createAgentWebServer({ config: testConfig(root, { ...googleTestEnv, CODEX_BIN: path.resolve("test/fixtures/fake-codex.mjs"), AGENT_ENABLE_MOCK: "0", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" }),
      googleAuthOptions: { fetchImpl: google.fetch }, agentAccountsOptions: { clientFactory: codex.factory } });
    try {
      const { url } = await app.start(); app.config.google.origin = url; await app.googleAuth.initialize();
      await use({ app, url, google, codex });
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
  await expect(page.locator("#relay-account-button")).toHaveText("owner@example.com");
  await expect(page.locator("#isolation-label")).toHaveText("Process isolation disabled");
  await expect(page.locator("#agent-accounts-button")).toBeAttached();
  await expect(page.locator("#welcome-new-chat")).toBeVisible();
}
const card = (page, name) => page.getByRole("region", { name: `${name} · Codex`, exact: true });
async function addAccount(page, name) {
  await page.locator("#agent-account-new").click();
  await expect(page.locator("#agent-account-form")).toBeVisible();
  await page.getByLabel("Account name", { exact: true }).fill(name);
  await page.locator("#agent-account-companies").getByLabel("Unassigned chats (no company)", { exact: true }).check();
  await page.getByRole("button", { name: "Sign in to Codex", exact: true }).click();
}

test("missing agent offers account onboarding instead of Invalid agent; device login persists and is explicitly selected", async ({ page, relay }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await login(page, relay);
  await page.locator("#welcome-new-chat").click();
  await expect(page.locator("#new-chat-dialog")).toBeVisible();
  await expect(page.locator("#agent-account-hint")).toContainText("No agent is connected");
  await expect(page.locator("#create-chat-error")).toHaveText("");
  await expect(page.locator("#new-model-controls")).toBeHidden();
  await expect(page.locator("#create-chat-button")).toBeDisabled();
  await page.locator("#connect-codex-button").click();
  await page.locator("#agent-account-new").click();
  await page.getByLabel("Account name", { exact: true }).fill("Personal Codex");
  await page.getByLabel("Unassigned chats (no company)", { exact: true }).check();
  await page.getByRole("button", { name: "Sign in to Codex", exact: true }).click();
  await expect(card(page, "Personal Codex").getByLabel("Codex sign-in code for Personal Codex")).toHaveText("TEST-1234");
  await expect(card(page, "Personal Codex").getByRole("link", { name: "Open Codex sign-in for Personal Codex" })).toHaveAttribute("href", "https://auth.openai.com/codex/device");
  expect(relay.app.agentAccounts.list(relay.app.googleAuth.legacyOwnerId)[0].status).toBe("pending");
  relay.codex.clients.find(client => client.approve).approve();
  await expect(card(page, "Personal Codex")).toContainText("codex@example.test · Connected");
  await page.getByRole("button", { name: "Close agent accounts" }).click();
  await expect(page.locator("#new-agent-account-field")).toBeVisible();
  await expect(page.locator("#new-agent-account")).toHaveValue("");
  await page.locator("#new-agent-account").selectOption({ label: "Personal Codex · codex@example.test" });
  await expect(page.locator("#new-model-controls")).toHaveAttribute("data-status", "ready");
  expect(relay.app.store.list()).toEqual([]);
  await page.reload();
  await page.locator("#agent-accounts-button").click();
  await expect(page.locator("#agent-account-list")).toContainText("Personal Codex");
  await expect(page.locator("#agent-account-list")).toContainText("Connected");
  expect(errors).toEqual([]);
});

test("mobile onboarding permits cancelling a pending login and never widens company scope", async ({ page, relay }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page, relay);
  // Sidebar is collapsed on mobile; open onboarding via the new-chat action.
  await page.locator("#welcome-new-chat").click(); await page.locator("#connect-codex-button").click();
  await page.locator("#agent-account-new").click();
  await page.getByLabel("Account name", { exact: true }).fill("Company Codex");
  const companies = page.locator("#agent-account-companies");
  await companies.getByLabel("Add companies", { exact: true }).fill("12-apps");
  await companies.getByRole("button", { name: "Add companies", exact: true }).click();
  await page.getByRole("button", { name: "Sign in to Codex", exact: true }).click();
  await expect(card(page, "Company Codex").getByLabel("Codex sign-in code for Company Codex")).toBeVisible();
  expect(await page.locator("#agent-accounts-dialog").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("codex-device-mobile.png") });
  await page.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
  await expect(card(page, "Company Codex")).toContainText("cancelled");
  const account = relay.app.agentAccounts.list(relay.app.googleAuth.legacyOwnerId)[0];
  expect(account.status).toBe("disconnected"); expect(account.companies).toEqual(["12-apps"]); expect(account.allowUnassigned).toBe(false);
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
  await expect(page.locator("#chat-agent-account")).toHaveText("Personal");
  await page.locator("#chat-agent-account").click(); await connect("Company");
  const company = relay.app.agentAccounts.list(relay.app.googleAuth.legacyOwnerId).find(account => account.name === "Company");
  page.once("dialog", dialog => dialog.accept());
  await page.locator(".agent-account-card").filter({ hasText: "Company · Codex" }).getByRole("button", { name: "Use in this chat", exact: true }).click();
  await expect(page.locator("#chat-agent-account")).toHaveText("Company");
  expect(relay.app.store.get(chat.id).agentAccountId).toBe(company.id);
  expect(relay.app.store.get(chat.id).workspace).toBe(chat.workspace);
  await page.locator("#chat-agent-account").click(); page.once("dialog", dialog => dialog.accept());
  await page.locator(".agent-account-card").filter({ hasText: "Company · Codex" }).getByRole("button", { name: "Disconnect", exact: true }).click();
  await page.getByRole("button", { name: "Close agent accounts" }).click();
  await expect(page.locator("#chat-agent-account")).toHaveText("Company · reconnect");
  await page.locator("#chat-agent-account").click(); page.once("dialog", dialog => dialog.accept());
  await page.locator(".agent-account-card").filter({ hasText: "Personal · Codex" }).getByRole("button", { name: "Disconnect", exact: true }).click();
  await page.getByRole("button", { name: "Close agent accounts" }).click();
  await expect(page.locator("#chat-agent-select")).toHaveValue("codex");
  await expect(page.locator("#chat-agent-select")).toBeDisabled();
  expect(relay.app.store.get(chat.id).messages).toEqual([]);
});

test("Add account visibly toggles a focused form and preserves its unsent draft", async ({ page, relay }) => {
  await page.setViewportSize({ width: 320, height: 800 }); await login(page, relay);
  await page.locator("#welcome-new-chat").click(); await page.locator("#connect-codex-button").click();
  const toggle = page.locator("#agent-account-new"), form = page.locator("#agent-account-form");
  await expect(form).toBeHidden(); await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click(); await expect(form).toBeVisible(); await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByLabel("Account name", { exact: true })).toBeFocused();
  await page.getByLabel("Account name", { exact: true }).fill("Unsent personal account");
  await form.getByLabel("Unassigned chats (no company)", { exact: true }).check();
  await toggle.click(); await expect(form).toBeHidden();
  await toggle.click(); await expect(page.getByLabel("Account name", { exact: true })).toHaveValue("Unsent personal account");
  await expect(form.getByLabel("Unassigned chats (no company)", { exact: true })).toBeChecked();
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
  await expect(page.locator("#agent-account-form").getByLabel("Unassigned chats (no company)", { exact: true })).toBeChecked();
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

test("Reconnect is one click inside the saved account, preserves scope and exposes a retryable startup error only once", async ({ page, relay }) => {
  await login(page, relay); await page.locator("#agent-accounts-button").click();
  await page.locator("#agent-account-new").click();
  await page.getByLabel("Account name", { exact: true }).fill("Personal");
  const companies = page.locator("#agent-account-companies");
  await companies.getByLabel("Add companies", { exact: true }).fill("12-apps");
  await companies.getByRole("button", { name: "Add companies", exact: true }).click();
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
    expect(saved[0].companies).toEqual(["12-apps"]); expect(saved[0].allowUnassigned).toBe(false);
    await page.locator("#agent-account-new").click();
    await expect(companies.locator("details")).not.toHaveAttribute("open", "");
    await expect(page.locator(".agent-account-help")).not.toHaveAttribute("open", "");
  } finally { gate.resolve(); }
});
