#!/usr/bin/env node
// Manual acceptance driver through the official Playwright MCP. Every identity,
// credential, provider response and record below belongs to disposable fixtures.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createAgentWebServer } from "../src/server.mjs";
import { testConfig } from "../test/helpers.mjs";
import { googleOidcFixture, googleTestEnv, cookieClient } from "../test/fixtures/google-oidc.mjs";
import { codexAccountFixture } from "../test/fixtures/codex-account.mjs";
import { claudeAccountFixture } from "../test/fixtures/claude-account.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(path.join(os.tmpdir(), "relay-account-mcp-"));
const screenshots = path.join(root, "test-results/account-ux-mcp");
await mkdir(screenshots, { recursive: true });
const google = googleOidcFixture(), codex = codexAccountFixture(), claude = claudeAccountFixture();
const app = await createAgentWebServer({
  config: testConfig(directory, { ...googleTestEnv, AGENT_ENABLE_MOCK: "0", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" }),
  googleAuthOptions: { fetchImpl: google.fetch },
  agentAccountsOptions: { clientFactory: provider => provider === "claude" ? claude.factory() : codex.factory() },
});
const client = new Client({ name: "relay-account-ux-fixtures", version: "1.0.0" });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [path.join(root, "node_modules/@playwright/mcp/cli.js"), "--headless", "--isolated", "--browser", "chrome", "--output-dir", screenshots],
  cwd: root, stderr: "pipe" });
transport.stderr?.on("data", () => {});
const privateFixtureValues = [];
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  // Avoid returning raw browser error text/cookies, even though these are fakes.
  if (result.isError) {
    const value = (result.content || []).filter(item => item.type === "text").map(item => item.text).join("\n");
    let sanitized = value;
    for (const secret of privateFixtureValues) sanitized = sanitized.replaceAll(secret, "[fixture session redacted]");
    console.error(sanitized.slice(0, 1200));
  }
  assert.notEqual(result.isError, true, `${name} fixture action failed`);
  return (result.content || []).filter(item => item.type === "text").map(item => item.text).join("\n");
}
// This MCP tool executes our fixed test code, never a page-provided snippet.
const run = code => call("browser_run_code_unsafe", { code: `async (page) => { ${code} }` });
const shot = filename => call("browser_take_screenshot", { filename: path.join(screenshots, filename), fullPage: true, scale: "css" });
try {
  const { url } = await app.start();
  assert.equal(new URL(url).hostname, "127.0.0.1");
  assert.notEqual(new URL(url).port, "8787");
  app.config.google.origin = url; await app.googleAuth.initialize();
  const fixture = cookieClient(url); await fixture.login(google);
  await client.connect(transport);
  const cookies = [...fixture.cookies].map(([name, value]) => ({ name, value, url, httpOnly: true, sameSite: "Lax" }));
  privateFixtureValues.push(...cookies.map(cookie => cookie.value));
  await run(`await page.context().addCookies(${JSON.stringify(cookies)}); await page.goto(${JSON.stringify(url)});`);
  await call("browser_resize", { width: 390, height: 844 });
  await run(`await page.locator('#welcome-new-chat').click();
    await page.locator('#agent-account-hint').filter({hasText:'No agent is connected'}).waitFor();
    if (!(await page.locator('#create-chat-button').isDisabled())) throw Error('Chat creation must require an account');
    await page.locator('#connect-codex-button').click();`);
  await shot("01-no-agent-onboarding.png");
  await run(`await page.locator('#agent-account-new').click();
    await page.getByLabel('Account name',{exact:true}).fill('Personal');
    await page.locator('#agent-account-companies').getByLabel('Unassigned chats (no company)',{exact:true}).check();
    await page.getByRole('button',{name:'Sign in to Codex',exact:true}).click();
    await page.getByRole('region',{name:'Personal · Codex',exact:true}).getByRole('link',{name:'Open Codex sign-in for Personal',exact:true}).waitFor();`);
  codex.clients.at(-1).approve();
  await run(`await page.getByRole('region',{name:'Personal · Codex',exact:true}).getByText('codex@example.test · Connected',{exact:true}).waitFor();
    await page.locator('#agent-account-new').click();
    await page.getByLabel('Account name',{exact:true}).fill('Company');
    await page.locator('#agent-account-companies').getByLabel('Add companies',{exact:true}).fill('example-company');
    await page.locator('#agent-account-companies').getByRole('button',{name:'Add companies',exact:true}).click();
    await page.getByRole('button',{name:'Sign in to Codex',exact:true}).click();
    await page.getByRole('region',{name:'Company · Codex',exact:true}).getByRole('link',{name:'Open Codex sign-in for Company',exact:true}).waitFor();
    if (await page.getByRole('region',{name:'Personal · Codex',exact:true}).getByRole('link').count()) throw Error('Unrelated account must not acquire another account link');`);
  await shot("02-company-login-is-account-scoped.png");
  await call("browser_click", { target: 'role=region[name="Company · Codex"] >> role=button[name="Delete account"]' });
  await call("browser_handle_dialog", { accept: true });
  await run(`await page.getByRole('region',{name:'Company · Codex',exact:true}).waitFor({state:'detached'});`);
  await run(`await page.locator('#agent-account-new').click();
    await page.locator('#agent-account-provider').selectOption('claude');
    await page.getByLabel('Account name',{exact:true}).fill('Claude Personal');
    await page.locator('#agent-account-companies').getByLabel('Unassigned chats (no company)',{exact:true}).check();
    await page.getByRole('button',{name:'Sign in to Claude',exact:true}).click();
    await page.getByRole('region',{name:'Claude Personal · Claude',exact:true}).getByRole('link',{name:'Open Claude sign-in for Claude Personal',exact:true}).waitFor();`);
  await shot("03-claude-link-and-code.png");
  await run(`const card=page.getByRole('region',{name:'Claude Personal · Claude',exact:true});
    await card.getByLabel('Claude authorization code for Claude Personal').fill('fixture-code#fixture-state');
    await card.getByRole('button',{name:'Complete sign-in',exact:true}).click();
    await card.getByText('claude@example.test · Connected',{exact:true}).waitFor();
    if (await card.locator('input').count()) throw Error('Completed code must disappear');`);
  await shot("04-two-providers-connected-fixtures.png");
  await run(`await page.getByRole('button',{name:'Close agent accounts',exact:true}).click();
    await page.locator('#new-chat-dialog').getByRole('button',{name:'Close',exact:true}).click();`);
  // Exact dialog labeling can vary independently; the page must always fit.
  for (const width of [320, 390, 1600]) {
    await call("browser_resize", { width, height: 1000 });
    const result = await call("browser_evaluate", { function: "() => ({fits:document.documentElement.scrollWidth<=innerWidth})" });
    assert.match(result, /"fits":\s*true/);
  }
  assert.equal(app.store.list().length, 0);
  assert.equal(app.agentAccounts.list(app.googleAuth.legacyOwnerId).length, 2);
  console.log(JSON.stringify({ browserTransport: "official Playwright MCP", disposableFixtures: true,
    missingAgentOnboarding: true, scopedCodexLink: true, pendingAccountDeletion: true, claudeCodeCompletion: true,
    retainedAccounts: 2, chatsCreated: 0, realProviderConsents: 0, modelPrompts: 0, responsiveWidths: [320, 390, 1600], screenshots }));
} finally {
  await client.callTool({ name: "browser_close", arguments: {} }).catch(() => {});
  await client.close().catch(() => {}); await transport.close().catch(() => {});
  await app.stop(); await rm(directory, { recursive: true, force: true });
}
