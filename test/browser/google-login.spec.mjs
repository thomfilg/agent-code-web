import { openSettingsSection, switchSettingsCompany } from "./settings-navigation.mjs";
import { test as base, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { createAgentWebServer } from "../../src/server.mjs";
import { testConfig } from "../helpers.mjs";
import { googleOidcFixture, googleTestEnv } from "../fixtures/google-oidc.mjs";

const test = base.extend({
  relay: async ({}, use) => {
    const root = await mkdtemp("/tmp/relay-google-browser-");
    const fixture = googleOidcFixture();
    const app = await createAgentWebServer({ config: testConfig(root, googleTestEnv), googleAuthOptions: { fetchImpl: fixture.fetch } });
    try {
      const { url } = await app.start(); app.config.google.origin = url; await app.googleAuth.initialize();
      await use({ app, url, fixture });
    } finally { await app.stop(); await rm(root, { recursive: true, force: true }); }
  },
});

async function interceptGoogle(page, relay, profile) {
  // Intercept only the top-level consent page. Backend token exchange still
  // executes the actual @12-apps/auth / Auth.js callbacks with signed ID tokens.
  await page.route("https://accounts.google.com/**", async route => {
    const callback = relay.fixture.approve(route.request().url(), profile);
    const escaped = callback.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
    await route.fulfill({ contentType: "text/html", body: `<!doctype html><title>Offline Google fixture</title><h1>Choose fixture Google account</h1><a href="${escaped}">Continue as fixture account</a>` });
  });
}

test("Google sign-in, reload and sign-out work in a real browser without granting Chrome access or sending prompts", async ({ page, relay }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  let prompts = 0; page.on("request", request => { if (/\/api\/chats\/.*\/(messages|queue)$/.test(new URL(request.url()).pathname) && request.method() === "POST") prompts++; });
  await interceptGoogle(page, relay);
  await page.goto(relay.url);
  await expect(page.getByRole("heading", { name: "Sign in to Agent Relay" })).toBeVisible();
  await expect(page.locator("#login-form")).toBeHidden();
  await page.keyboard.press("Escape"); await expect(page.locator("#login-dialog")).toBeVisible();
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.getByRole("link", { name: "Continue as fixture account" }).click();
  await expect(page.getByRole("button", { name: "Your Relay account" })).toHaveAttribute("title", "owner@example.com");
  await expect(page.locator("#sidebar-user-name")).toHaveText("Relay Owner");
  await expect(page.locator("#login-dialog")).toBeHidden();
  await page.reload(); await expect(page.getByRole("button", { name: "Your Relay account" })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const companyForm = page.locator("#settings-company-form");
  await companyForm.getByLabel("Company name", { exact: true }).fill("Fixture company");
  await companyForm.getByLabel("Company identifier", { exact: true }).fill("fixture");
  await companyForm.getByRole("button", { name: "Save company", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Fixture company", exact: true })).toBeVisible();
  await openSettingsSection(page, "Browser connections");
  await expect(page.locator("#browser-account-name")).toHaveText("Signed in as owner@example.com");
  await expect(page.locator("#browser-account-form")).toBeHidden();
  await expect(page.locator("#browser-connection-list")).toContainText("No Chrome profiles paired");
  await page.locator("#browser-connections-close").click();
  await page.getByLabel("Close settings", { exact: true }).click();
  await page.getByRole("button", { name: "Your Relay account" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Agent Relay" })).toBeVisible();
  expect(await relay.app.records.list("relay-session")).toEqual([]);
  expect(await relay.app.records.list("browser-connection")).toEqual([]);
  expect(relay.app.store.list()).toEqual([]); expect(prompts).toBe(0); expect(errors).toEqual([]);
});

test("Google login and setup instructions fit a 320px screen and errors are actionable", async ({ page, relay }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(relay.url + "/?error=AccessDenied");
  await expect(page.locator("#google-sign-in-error")).toContainText("not allowed");
  expect(await page.locator("#login-dialog").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("google-login-mobile.png") });
  relay.app.config.google.clientSecret = ""; relay.app.googleAuth.api = null; await relay.app.googleAuth.initialize();
  await page.reload();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeDisabled();
  await expect(page.locator("#google-setup")).toContainText("GOOGLE_CLIENT_SECRET");
  await expect(page.locator("#google-callback")).toHaveText(relay.url + "/api/auth/callback/google");
  expect(await page.locator("#login-dialog").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("uninvited Google accounts return to login without seeing any saved chat", async ({ page, relay }) => {
  await relay.app.store.create({ title: "Private legacy title", agent: "mock" });
  await interceptGoogle(page, relay, { sub: "outsider", email: "outsider@example.com", email_verified: true });
  await page.goto(relay.url);
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.getByRole("link", { name: "Continue as fixture account" }).click();
  await expect(page.locator("#google-sign-in-error")).toContainText("not allowed");
  await expect(page.locator("#chat-list")).not.toContainText("Private legacy title");
  expect(await relay.app.records.list("relay-user")).toEqual([]);
});

test("a second user's browser cannot see the owner's chat and account switching refreshes other open tabs", async ({ page, browser, relay }) => {
  const legacy = await relay.app.store.create({ title: "Owner transcript", agent: "mock" });
  await interceptGoogle(page, relay); await page.goto(relay.url);
  await page.getByRole("button", { name: "Continue with Google" }).click(); await page.getByRole("link", { name: "Continue as fixture account" }).click();
  await page.getByRole("button", { name: "Open Owner transcript", exact: true }).click();
  await expect(page.locator("#chat-title")).toHaveText("Owner transcript");
  const other = await browser.newContext();
  try {
    const member = await other.newPage();
    await interceptGoogle(member, relay, { sub: "member", email: "member@example.com", email_verified: true });
    await member.goto(relay.url + `/#chat=${legacy.id}`);
    await member.getByRole("button", { name: "Continue with Google" }).click(); await member.getByRole("link", { name: "Continue as fixture account" }).click();
    await expect(member.getByRole("button", { name: "Your Relay account" })).toHaveAttribute("title", "member@example.com");
    await expect(member.locator("#chat-list")).not.toContainText("Owner transcript");
    expect((await member.request.get(relay.url + `/api/chats/${legacy.id}`)).status()).toBe(404);
    const anotherOwnerTab = await page.context().newPage();
    await anotherOwnerTab.goto(relay.url + `/#chat=${legacy.id}`); await expect(anotherOwnerTab.locator("#chat-title")).toHaveText("Owner transcript");
    await page.getByRole("button", { name: "Your Relay account" }).click(); await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.locator("#login-dialog")).toBeVisible();
    await expect(anotherOwnerTab.locator("#login-dialog")).toBeVisible();
    await expect(anotherOwnerTab.locator("#chat-list")).not.toContainText("Owner transcript");
  } finally { await other.close(); }
});
