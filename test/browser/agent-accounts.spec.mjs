import { test as base, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createAgentWebServer } from "../../src/server.mjs";
import { testConfig } from "../helpers.mjs";
import { googleOidcFixture, googleTestEnv } from "../fixtures/google-oidc.mjs";
import { codexAccountFixture } from "../fixtures/codex-account.mjs";

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
  await page.getByLabel("Account name", { exact: true }).fill("Personal Codex");
  await page.getByLabel("Unassigned chats (no company)", { exact: true }).check();
  await page.getByRole("button", { name: "Sign in to Codex", exact: true }).click();
  await expect(page.getByLabel("Codex sign-in code")).toHaveText("TEST-1234");
  await expect(page.getByRole("link", { name: "Open Codex sign-in" })).toHaveAttribute("href", "https://auth.openai.com/codex/device");
  expect(relay.app.agentAccounts.list(relay.app.googleAuth.legacyOwnerId)[0].status).toBe("pending");
  relay.codex.clients.find(client => client.approve).approve();
  await expect(page.locator("#agent-account-login")).toContainText("Codex connected");
  await page.getByRole("button", { name: "Close agent accounts" }).click();
  await expect(page.locator("#new-agent-account-field")).toBeVisible();
  await expect(page.locator("#new-agent-account")).toHaveValue("");
  await page.locator("#new-agent-account").selectOption({ label: "Personal Codex · codex@example.test" });
  await expect(page.locator("#new-model-controls")).toHaveAttribute("data-status", "ready");
  expect(relay.app.store.list()).toEqual([]);
  await page.reload();
  await page.locator("#agent-accounts-button").click();
  await expect(page.locator("#agent-account-list")).toContainText("Personal Codex");
  await expect(page.locator("#agent-account-list")).toContainText("connected");
  expect(errors).toEqual([]);
});

test("mobile onboarding permits cancelling a pending login and never widens company scope", async ({ page, relay }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page, relay);
  // Sidebar is collapsed on mobile; open onboarding via the new-chat action.
  await page.locator("#welcome-new-chat").click(); await page.locator("#connect-codex-button").click();
  await page.getByLabel("Account name", { exact: true }).fill("Company Codex");
  const companies = page.locator("#agent-account-companies");
  await companies.getByLabel("Add companies", { exact: true }).fill("12-apps");
  await companies.getByRole("button", { name: "Add companies", exact: true }).click();
  await page.getByRole("button", { name: "Sign in to Codex", exact: true }).click();
  await expect(page.getByLabel("Codex sign-in code")).toBeVisible();
  expect(await page.locator("#agent-accounts-dialog").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("codex-device-mobile.png") });
  await page.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
  await expect(page.locator("#agent-account-login")).toContainText("cancelled");
  const account = relay.app.agentAccounts.list(relay.app.googleAuth.legacyOwnerId)[0];
  expect(account.status).toBe("disconnected"); expect(account.companies).toEqual(["12-apps"]); expect(account.allowUnassigned).toBe(false);
  expect(relay.codex.clients[0].closed).toBe(true);
});

test("a chat explicitly selects among personal and company accounts and shows disconnected access", async ({ page, relay }) => {
  await login(page, relay);
  async function connect(name) {
    await page.getByLabel("Account name", { exact: true }).fill(name);
    await page.locator("#agent-account-companies").getByLabel("Unassigned chats (no company)", { exact: true }).check();
    await page.getByRole("button", { name: "Sign in to Codex", exact: true }).click();
    await expect(page.getByLabel("Codex sign-in code")).toBeVisible();
    relay.codex.clients.at(-1).approve();
    await expect(page.locator("#agent-account-login")).toContainText("Codex connected");
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
