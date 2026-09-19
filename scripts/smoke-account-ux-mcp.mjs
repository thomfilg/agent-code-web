#!/usr/bin/env node
// Manual acceptance driver through the official Playwright MCP. Every identity,
// credential, provider response and record below belongs to disposable fixtures.
// Run after npm run build:auth: taskset -c 0,1 nice -n 10 node scripts/smoke-account-ux-mcp.mjs
// This verifies configuration UX only, not real OAuth consent or worker startup.
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
let workerAcquisitions = 0, adapterStarts = 0;
const app = await createAgentWebServer({
  config: testConfig(directory, { ...googleTestEnv, AGENT_ENABLE_MOCK: "0", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" }),
  googleAuthOptions: { fetchImpl: google.fetch },
  agentAccountsOptions: { clientFactory: provider => provider === "claude" ? claude.factory() : codex.factory() },
  workerBackend: {
    acquire: async () => { workerAcquisitions++; throw Error("Configuration fixture must not acquire a worker"); },
    sleep: async () => {}, destroy: async () => {},
  },
  adapterFactory: () => { adapterStarts++; throw Error("Configuration fixture must not launch a native agent"); },
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
    // This driver only opens its disposable fixture. Preserve its failed UI
    // before cleanup so an empty or stale picker can be diagnosed visually.
    await client.callTool({ name: "browser_take_screenshot", arguments: { filename: path.join(screenshots, "failed-fixture.png"), fullPage: true, scale: "css" } }).catch(() => {});
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
  const fixture = cookieClient(url), owner = await fixture.login(google);
  const services = await app.resources.forOwner(owner.id);
  let runtimeCalls = 0;
  // This is account/configuration acceptance, never native model acceptance.
  for (const method of ["send", "submit", "enqueue", "wake"]) app.manager[method] = async () => { runtimeCalls++; throw Error("Fixture must not start a worker or send a model prompt"); };
  await client.connect(transport);
  const cookies = [...fixture.cookies].map(([name, value]) => ({ name, value, url, httpOnly: true, sameSite: "Lax" }));
  privateFixtureValues.push(...cookies.map(cookie => cookie.value));
  await run(`await page.context().route('**/*', route => route.request().url().startsWith(${JSON.stringify(url + "/")}) ? route.continue() : route.abort());
    await page.context().addCookies(${JSON.stringify(cookies)}); await page.goto(${JSON.stringify(url + "/#new")});`);
  await call("browser_resize", { width: 390, height: 844 });
  await run(`await page.locator('#new-chat-page').waitFor();
    await page.locator('#agent-account-hint').filter({hasText:'Connect Codex or Claude'}).waitFor();
    if (!(await page.locator('#create-chat-button').isDisabled())) throw Error('Chat creation must require an account');
    await page.locator('#connect-codex-button').click();`);
  await shot("01-no-agent-onboarding.png");
  await run(`await page.locator('#agent-account-new').click();
    await page.getByLabel('Account name',{exact:true}).fill('Personal');
    if(await page.locator('#agent-account-companies').count()) throw Error('Agent accounts must not require company assignment');
    await page.getByRole('button',{name:'Sign in to Codex',exact:true}).click();
    await page.getByRole('region',{name:'Personal · Codex',exact:true}).getByRole('link',{name:'Open Codex sign-in for Personal',exact:true}).waitFor();`);
  codex.clients.at(-1).approve();
  await run(`await page.getByRole('region',{name:'Personal · Codex',exact:true}).getByText('codex@example.test · Connected',{exact:true}).waitFor();
    await page.locator('#agent-account-new').click();
    await page.getByLabel('Account name',{exact:true}).fill('Company');
    await page.getByRole('button',{name:'Sign in to Codex',exact:true}).click();
    await page.getByRole('region',{name:'Company · Codex',exact:true}).getByRole('link',{name:'Open Codex sign-in for Company',exact:true}).waitFor();
    if (await page.getByRole('region',{name:'Personal · Codex',exact:true}).getByRole('link').count()) throw Error('Unrelated account must not acquire another account link');`);
  await shot("02-company-login-is-account-scoped.png");
  const pendingCodex = codex.clients.findLast(item => item.completed && !item.closed);
  assert.ok(pendingCodex, "Pending fixture login must exist before deletion");
  await call("browser_click", { target: 'role=region[name="Company · Codex"] >> role=button[name="Delete account"]' });
  await call("browser_handle_dialog", { accept: true });
  await run(`await page.getByRole('region',{name:'Company · Codex',exact:true}).waitFor({state:'detached'});`);
  assert.equal(pendingCodex.cancelled, true); assert.equal(pendingCodex.closed, true);
  await run(`await page.locator('#agent-account-new').click();
    await page.locator('#agent-account-provider').selectOption('claude');
    await page.getByLabel('Account name',{exact:true}).fill('Claude Personal');
    await page.getByRole('button',{name:'Sign in to Claude',exact:true}).click();
    await page.getByRole('region',{name:'Claude Personal · Claude',exact:true}).getByRole('link',{name:'Open Claude sign-in for Claude Personal',exact:true}).waitFor();`);
  await shot("03-claude-link-and-code.png");
  await run(`const card=page.getByRole('region',{name:'Claude Personal · Claude',exact:true});
    await card.getByLabel('Claude authorization code for Claude Personal').fill('fixture-code#fixture-state');
    await card.getByRole('button',{name:'Complete sign-in',exact:true}).click();
    await card.getByText('claude@example.test · Connected',{exact:true}).waitFor();
    if (await card.locator('input').count()) throw Error('Completed code must disappear');`);
  await shot("04-two-providers-connected-fixtures.png");
  await run(`await page.getByRole('button',{name:'Close agent accounts',exact:true}).click();`);
  // Exact dialog labeling can vary independently; the page must always fit.
  for (const width of [320, 390, 1600]) {
    await call("browser_resize", { width, height: 1000 });
    const result = await call("browser_evaluate", { function: "() => ({fits:document.documentElement.scrollWidth<=innerWidth})" });
    assert.match(result, /"fits":\s*true/);
  }
  assert.equal(app.store.list().length, 0);
  const accounts = app.agentAccounts.list(owner.id);
  assert.equal(accounts.length, 2);
  const personal = accounts.find(account => account.provider === "codex");
  const claudePersonal = accounts.find(account => account.provider === "claude");
  // Real owner isolation through the signed, entirely synthetic OIDC boundary.
  const member = cookieClient(url);
  await member.login(google, { sub: "google-member", email: "member@example.com", email_verified: true, name: "Fixture member" });
  assert.deepEqual((await (await member.request("/api/agent-accounts")).json()).accounts, []);
  for (const method of ["GET", "DELETE"]) assert.equal((await member.request(`/api/agent-accounts/${personal.id}`, { method })).status, 404);
  assert.equal((await member.request(`/api/models?agent=codex&account=${personal.id}`)).status, 404);
  // Companies are registered through the visible Settings hub, not hidden
  // legacy sidebar buttons. One company may contain several GitHub owners.
  await run(`await page.getByRole('button',{name:'Settings',exact:true}).click();`);
  for (const [id, name] of [["personal-projects", "Personal projects"], ["example-company", "Company"]]) {
    await run(`const hub=page.locator('#company-settings-dialog');
      if(await hub.locator('#settings-company-form').isHidden()) await hub.getByRole('button',{name:'+ Add company',exact:true}).click();
      await hub.getByLabel('Company name',{exact:true}).fill(${JSON.stringify(name)});
      await hub.getByLabel('Company identifier',{exact:true}).fill(${JSON.stringify(id)});
      await hub.getByRole('button',{name:'Save company',exact:true}).click();
      await hub.locator('#settings-tab-${id}[aria-selected=true]').waitFor();`);
  }
  await run(`await page.getByRole('button',{name:'Close settings',exact:true}).click();`);
  const repos = [
    { id: 101, full_name: "12-apps/fixture-repo", name: "fixture-repo" },
    { id: 102, full_name: "thomfilg/fixture-shared", name: "fixture-shared" },
    { id: 103, full_name: "example-org/company-repo", name: "company-repo" },
  ].map(repo => ({ ...repo, private: true, default_branch: "main", size: 0 }));
  const fixtureRepo = repos[0];
  let repositoryReads = 0;
  services.github.fetch = async (target, options) => {
    const pathname = new URL(target).pathname;
    const authorization = new Headers(options?.headers).get("authorization");
    assert.ok(["Bearer fixture_company_credential", "Bearer fixture_personal_credential"].includes(authorization), "Only explicit fixture GitHub credentials may be used");
    const company = authorization === "Bearer fixture_company_credential";
    const allowed = company ? repos.slice(2) : repos.slice(0, 2);
    if (pathname === "/user") return Response.json({ id: company ? 43 : 42, login: company ? "fixture-company" : "fixture-personal" });
    if (pathname === "/user/repos") { repositoryReads++; return Response.json(allowed); }
    for (const repo of allowed) {
      if (pathname === `/repos/${repo.full_name}`) return Response.json(repo);
      if (pathname === `/repos/${repo.full_name}/branches`) return Response.json([{ name: "main" }, { name: "dev" }]);
    }
    throw new Error("Unexpected fixture GitHub request");
  };
  const personalGitHub = (await services.github.connect({ token: "fixture_personal_credential", name: "Fixture personal GitHub", companyId: "personal-projects" })).connection;
  const companyGitHub = (await services.github.connect({ token: "fixture_company_credential", name: "Fixture company GitHub", companyId: "example-company" })).connection;
  await assert.rejects(services.github.connect({ token: "fixture_duplicate_credential", name: "Duplicate", companyId: "personal-projects" }), /one|already/i);
  await assert.rejects(services.github.connect({ token: "fixture_multi_credential", name: "Invalid", companies: ["personal-projects", "example-company"] }));
  await run(`await page.reload(); await page.locator('#new-chat-page').waitFor();
    await page.locator('#new-agent-account').selectOption(${JSON.stringify(personal.id)});
    await page.locator('#new-model-controls[data-status=ready]').waitFor();
    if(!(await page.locator('#create-chat-button').isDisabled())) throw Error('Missing company environment must block creation');
    await page.getByRole('button',{name:'Settings',exact:true}).click();`);
  const environments = [];
  for (const [companyId, name] of [["personal-projects", "Personal development"], ["example-company", "Company development"]]) {
    await run(`const hub=page.locator('#company-settings-dialog');
      await hub.locator('#settings-tab-${companyId}').click();
      await hub.getByRole('button',{name:'GitHub',exact:true}).click();
      await page.locator('#github-dialog').waitFor();
      await page.locator('#github-account-list').getByRole('button',{name:'Edit',exact:true}).waitFor();
      if(await page.locator('#github-company-filter').inputValue()!==${JSON.stringify(companyId)}) throw Error('Wrong GitHub company');
      if(await page.locator('#github-company-filter').isVisible()) throw Error('Scoped GitHub editor must keep hub context');
      if(await page.locator('#github-account-list').getByRole('button',{name:'Edit',exact:true}).count()!==1) throw Error('Only selected company connection should appear');
      await page.getByRole('button',{name:'Close GitHub dialog',exact:true}).click();
      await hub.getByRole('button',{name:'Environments',exact:true}).click();
      await page.locator('#add-environment').click();
      await page.getByLabel('Environment name',{exact:true}).fill(${JSON.stringify(name)});
      if(await page.locator('#environment-company').inputValue()!==${JSON.stringify(companyId)}) throw Error('Environment must belong to the selected company');
      await page.getByRole('button',{name:'Save environment',exact:true}).click();
      await page.locator('#environments-dialog').waitFor({state:'hidden'});`);
    environments.push((await services.environments.list()).find(env => env.name === name));
  }
  await run(`await page.getByRole('button',{name:'Close settings',exact:true}).click();
    await page.reload(); await page.locator('#new-chat-page').waitFor();`);
  for (let i = 0; i < environments.length; i++) {
    const environment = environments[i], repo = i ? repos[2] : fixtureRepo;
    assert.deepEqual(environment.companies, [i ? "example-company" : "personal-projects"]);
    await run(`await page.locator('#environment-select').selectOption(${JSON.stringify(environment.id)});
      await page.getByRole('button',{name:'Add repositories',exact:true}).click();
      await page.locator('#repository-results').getByRole('checkbox',{name:${JSON.stringify(repo.full_name)}}).check();
      if(await page.locator('#repository-results').getByRole('checkbox',{name:${JSON.stringify(i ? fixtureRepo.full_name : repos[2].full_name)}}).count()) throw Error('Repositories from another company must not be offered');
      await page.getByRole('button',{name:'Add repositories',exact:true}).click();
      await page.locator('#new-agent-account').selectOption({label:'Claude · Claude Personal · claude@example.test'});
      await page.locator('#new-model-controls[data-status=ready]').waitFor();
      await page.locator('#new-agent-account').selectOption({label:'Codex · Personal · codex@example.test'});
      await page.locator('#new-model-controls[data-status=ready]').waitFor();`);
  }
  // A single company's GitHub account covers both owners; company switching
  // restores the last selection without assigning or cloning agent credentials.
  await run(`await page.locator('#environment-select').selectOption(${JSON.stringify(environments[0].id)});
    await page.locator('#selected-repositories .repository-name').filter({hasText:'fixture-repo'}).waitFor();
    await page.getByRole('button',{name:'Add repositories',exact:true}).click();
    await page.locator('#repository-results').getByRole('checkbox',{name:'thomfilg/fixture-shared'}).check();
    await page.getByRole('button',{name:'Add repositories',exact:true}).click();
    await page.locator('#new-agent-account').selectOption(${JSON.stringify(personal.id)});
    await page.locator('#new-model-controls[data-status=ready]').waitFor();`);
  const postChat = body => fixture.request('/api/chats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const selection = { agent: "codex", agentAccountId: personal.id, environmentId: environments[0].id,
    repositories: [{ fullName: fixtureRepo.full_name, branch: "main", githubConnectionId: personalGitHub.id }] };
  for (const denied of [
    { ...selection, agentAccountId: claudePersonal.id },
    { ...selection, environmentId: environments[1].id },
    { ...selection, repositories: [...selection.repositories, { fullName: repos[2].full_name, branch: "main", githubConnectionId: companyGitHub.id }] },
  ]) assert.ok([400, 403, 409].includes((await postChat(denied)).status), "Invalid provider/company combination must be denied");
  assert.equal(app.store.list().length, 0);
  assert.ok(repositoryReads > 0);
  for (const width of [320, 390, 1600]) {
    await call("browser_resize", { width, height: 1000 });
    await run(`if(await page.locator('#sidebar').evaluate(e=>e.classList.contains('open'))) await page.getByRole('button',{name:'Close chats',exact:true}).click();
      if(await page.locator('dialog[open]').count()) throw Error('New chat must be inline');
      if(!await page.locator('#new-chat-page').evaluate(e=>e.scrollWidth<=e.clientWidth)) throw Error('New chat page overflow');`);
    await shot(`06-new-chat-configured-${width}.png`);
  }
  // Explicit local command creates the configured chat without a model prompt.
  await run(`await page.locator('#initial-prompt').fill('/rename Fixture configured chat');
    await page.locator('#create-chat-button').click();
    await page.locator('#conversation').waitFor();
    await page.locator('#chat-title').filter({hasText:'Fixture configured chat'}).waitFor();`);
  const created = app.store.list(); assert.equal(created.length, 1);
  assert.equal(created[0].agent, "codex"); assert.equal(created[0].agentAccountId, personal.id);
  assert.deepEqual(created[0].repositories.map(repo => repo.fullName), repos.slice(0, 2).map(repo => repo.full_name));
  assert.equal(created[0].environmentId, environments[0].id);
  assert.ok(created[0].repositories.every(repo => repo.companyId === "personal-projects"));
  assert.deepEqual(created[0].messages, []); assert.equal(created[0].workspaceReady, false);
  assert.equal(runtimeCalls, 0); assert.equal(workerAcquisitions, 0); assert.equal(adapterStarts, 0);
  assert.equal(app.agentAccounts.list(owner.id).length, 2);
  console.log(JSON.stringify({ browserTransport: "official Playwright MCP", disposableFixtures: true,
    missingAgentOnboarding: true, scopedCodexLink: true, pendingAccountDeletion: true, claudeCodeCompletion: true,
    ownerIsolation: true, inlineNewChat: true, companySettingsHub: true, singleCompanyConnections: true,
    multiCompanyAgentAccounts: true, githubProviderPermissions: true, mixedCompanyDenied: true, wrongProviderDenied: true,
    explicitEnvironmentCompanyAccess: true, retainedAccounts: 2, chatsCreated: 1, realProviderConsents: 0, modelPrompts: 0, workerStarts: 0,
    responsiveWidths: [320, 390, 1600], screenshots }));
} finally {
  await client.callTool({ name: "browser_close", arguments: {} }).catch(() => {});
  await client.close().catch(() => {}); await transport.close().catch(() => {});
  await app.stop(); await rm(directory, { recursive: true, force: true });
}
