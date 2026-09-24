import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRecords } from "../src/database.mjs";
import { Companies, connectionCompany } from "../src/companies.mjs";
import { userRecords } from "../src/user-services.mjs";
import { McpConnections } from "../src/mcp-connections.mjs";
import { Environments } from "../src/environments.mjs";
import { GitHubConnection } from "../src/github.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { temporaryDirectory, testConfig } from "./helpers.mjs";
import { googleOidcFixture, googleTestEnv, cookieClient } from "./fixtures/google-oidc.mjs";
import { companyForChat } from "../public/company-scope.js";
import { groupChats } from "../public/chat-organization.js";

async function setup(records = new MemoryRecords()) {
  const companies = new Companies(records);
  await companies.save({ id: "acme", name: "Acme" }); await companies.save({ id: "other", name: "Other" });
  return { records, companies, mcps: new McpConnections(records, { companies }) };
}
const chat = company => ({ repositories: [{ fullName: `${company}/app` }] });

test("company registration is durable, user-scoped and never retargets keys on rename", async () => {
  const records = new MemoryRecords(), alice = new Companies(userRecords(records, "alice")), bob = new Companies(userRecords(records, "bob"));
  const company = await alice.save({ id: "ACME", name: "Acme" }); assert.equal(company.id, "acme");
  assert.deepEqual(await bob.list(), []); await assert.rejects(bob.get(company.id), /registered company/);
  await assert.rejects(alice.save({ id: "acme", name: "Duplicate" }), { statusCode: 409 });
  await assert.rejects(alice.save({ ...company, id: "other" }, "acme"), /cannot be changed/);
  await assert.rejects(alice.save({ ...company, revision: 0 }, "acme"), { statusCode: 409 });
  const renamed = await alice.save({ ...company, name: "Acme Incorporated" }, "acme");
  assert.deepEqual(await new Companies(userRecords(records, "alice")).get("acme"), renamed);
  for (const id of ["*", "https://github.com/acme", "two companies", "-bad", "bad-"]) await assert.rejects(alice.save({ id, name: "Invalid" }));
});

test("legacy migration registers names without assigning or duplicating credentials", async () => {
  const records = new MemoryRecords();
  const legacy = { id: "mcp_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "linear", companies: ["acme", "other"], type: "http", url: "https://mcp.linear.app/mcp", authMode: "oauth", oauthScopes: "read", oauth: { tokens: { access_token: "fixture-only-secret" } }, revision: 1 };
  await records.put("mcp", legacy.id, legacy);
  const companies = new Companies(records), mcps = new McpConnections(records, { companies });
  assert.deepEqual((await companies.list()).map(company => company.id), ["acme", "other"]);
  assert.deepEqual(await records.get("mcp", legacy.id), legacy);
  assert.equal((await mcps.list())[0].scopeNeedsReview, true);
  assert.equal(connectionCompany({ companies: ["acme"], allowUnassigned: true }), null);
  for (const company of ["acme", "other"]) {
    assert.deepEqual(await mcps.forCompany(company), []);
    assert.deepEqual(await mcps.runtime("test-chat", [legacy.id], "http://localhost", chat(company)), {});
  }
  await assert.rejects(mcps.oauth.begin(legacy.id, "http://localhost/oauth/mcp/callback"), /registered company/);
  const saved = await mcps.save({ name: legacy.name, companyId: "acme", type: legacy.type, url: legacy.url, authMode: "oauth", revision: legacy.revision }, legacy.id);
  assert.equal(saved.oauthConnected, true); assert.equal(saved.companyId, "acme");
  assert.deepEqual((await records.get("mcp", legacy.id)).oauth.tokens, legacy.oauth.tokens);
  assert.deepEqual(await mcps.forCompany("acme"), [legacy.id]); assert.deepEqual(await mcps.forCompany("other"), []);
  assert.equal((await records.list("mcp")).length, 1);
});

test("multiple MCPs belong to one registered company and reach its environment without a second selector", async () => {
  const { companies, mcps } = await setup();
  const first = await mcps.save({ name: "docs", companyId: "acme", type: "http", url: "https://example.test/mcp", authMode: "none" });
  const second = await mcps.save({ name: "issues", companyId: "acme", type: "http", url: "https://example.test/issues", authMode: "headers", headers: { Authorization: "Bearer fixture-only" } });
  const other = await mcps.save({ name: "docs", companyId: "other", type: "http", url: "https://other.test/mcp", authMode: "none" });
  const pending = await mcps.save({ name: "pending", companyId: "acme", type: "http", url: "https://example.test/oauth", authMode: "oauth" });
  await assert.rejects(mcps.save({ name: "bad", companies: ["acme", "other"], type: "http", url: "https://example.test/mcp" }), /exactly one/);
  await assert.rejects(mcps.save({ name: "bad", companyId: "unregistered", type: "http", url: "https://example.test/mcp" }), /registered company/);
  const envs = new Environments(mcps.records, "local", mcps);
  const env = await envs.save({ name: "Acme dev", backend: "local", companies: ["acme"], mcpIds: [] });
  assert.deepEqual(new Set((await envs.runtime(env.id, chat("acme"))).mcpIds), new Set([first.id, second.id]));
  await assert.rejects(envs.runtime(env.id, chat("other")), { statusCode: 403 });
  const servers = await mcps.runtime("chat-acme", [first.id, second.id, other.id, pending.id], "http://localhost", chat("acme"));
  assert.equal(Object.values(servers).some(server => server.url.includes(other.id)), false);
  const grant = mcps.grants.get("chat-acme"); assert.ok(grant.has(first.id));
  await mcps.save({ ...first, companyId: "other", companies: undefined, name: "moved" }, first.id);
  assert.equal(grant.has(first.id), false);
  assert.deepEqual((await envs.runtime(env.id, chat("acme"))).mcpIds, [second.id]);
  await mcps.remove(second.id); assert.deepEqual((await envs.runtime(env.id, chat("acme"))).mcpIds, []);
  assert.equal((await companies.list()).length, 2);
});

function githubFixture(records, companies) {
  const calls = [];
  const github = new GitHubConnection({ records, companies, config: { apiBase: "https://api.github.com" }, fetchImpl: async (url, options) => {
    calls.push({ path: new URL(url).pathname, auth: options.headers.authorization });
    if (new URL(url).pathname === "/user") return Response.json({ login: "fixture", id: 1 });
    if (new URL(url).pathname === "/user/repos") return Response.json(["acme/app", "other/library"].map((full_name, i) => ({ full_name, id: i + 1, default_branch: "main" })));
    if (url.includes("/branches")) return Response.json([{ name: "main" }]);
    const selected = /^\/repos\/([^/]+\/[^/]+)$/.exec(new URL(url).pathname);
    if (selected) return Response.json({ full_name: selected[1], name: selected[1].split("/")[1], id: selected[1].length, default_branch: "main", size: 1 });
    return Response.json({});
  } });
  return { github, calls };
}

test("GitHub allows exactly one connection per company, including concurrent writes, without borrowing credentials", async () => {
  const { records, companies } = await setup(), { github, calls } = githubFixture(records, companies);
  const attempts = await Promise.allSettled([github.connect({ companyId: "acme", token: "fixture-acme-token" }), github.connect({ companyId: "acme", token: "fixture-another-token" })]);
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  assert.match(attempts.find(result => result.status === "rejected").reason.message, /already has/);
  const acme = attempts.find(result => result.status === "fulfilled").value.connection;
  const other = (await github.connect({ companyId: "other", token: "fixture-other-token" })).connection;
  const count = calls.length;
  await assert.rejects(github.request("/repos/acme/app", { connectionId: other.id, chatCompany: "acme" }), { statusCode: 403 });
  await assert.rejects(github.request("/repos/other/library", { connectionId: other.id, chatCompany: "acme" }), { statusCode: 403 });
  assert.equal(calls.length, count);
  await github.request("/repos/other/library", { connectionId: acme.id, chatCompany: "acme" });
  assert.equal(calls.at(-1).auth, "Bearer fixture-acme-token", "Explicit secondary repos use the primary company's credential, not the secondary company's");
  await assert.rejects(github.request("/repos/acme/app"), { statusCode: 409 });
  await github.request("/repos/acme/app", { connectionId: acme.id }); assert.equal(calls.at(-1).auth, "Bearer fixture-acme-token");
  await assert.rejects(github.update({ id: acme.id, revision: acme.revision, companyId: "other", name: "Move" }), { statusCode: 409 });
  await github.close();
});

test("one company groups personal and organization repositories without sharing its GitHub connection with another company", async () => {
  const { records, companies } = await setup(), { github, calls } = githubFixture(records, companies);
  await companies.save({ id: "personal-projects", name: "thomfilg + 12-apps" });
  const personal = (await github.connect({ companyId: "personal-projects", token: "fixture-personal-token" })).connection;
  const work = (await github.connect({ companyId: "other", token: "fixture-work-token" })).connection;
  const selections = ["thomfilg/app", "12-apps/app"].map(fullName => ({ fullName, githubConnectionId: personal.id, companyId: "other", branch: "main" }));
  const repositories = await github.resolveSelections(selections);
  assert.ok(repositories.every(repo => repo.companyId === "personal-projects"), "Company comes from the saved connection, not forged browser metadata or repository owner");
  assert.equal(companyForChat({ repositories }), "personal-projects");
  assert.equal(companyForChat({ repositories: [...repositories].reverse() }), "personal-projects");
  const grouped = groupChats(repositories.map((repo, i) => ({ id: `fixture-${i}`, repositories: [repo], updatedAt: "2026-09-18" })), [], "updated_desc");
  assert.equal(grouped.companies.length, 1); assert.equal(grouped.companies[0].repositories.length, 2, "Same repo names under different GitHub owners stay separate projects");
  const before = calls.length;
  await assert.rejects(github.resolveSelections([selections[0], { fullName: "other/private", githubConnectionId: work.id }]), { statusCode: 403 });
  assert.equal(calls.length, before, "Mixed-company credentials are rejected before provider requests");
  await assert.rejects(github.tokenForRepository(repositories[0], chat("other")), { statusCode: 403 });
  await github.close();
});

test("chat admission and preferences use the registered company rather than GitHub owner or submitted company metadata", async t => {
  const root = await temporaryDirectory(t), records = new MemoryRecords(), { companies } = await setup(records);
  await companies.save({ id: "personal-projects", name: "thomfilg + 12-apps" });
  const { github } = githubFixture(records, companies);
  const personal = (await github.connect({ companyId: "personal-projects", token: "fixture-personal-token" })).connection;
  const app = await createAgentWebServer({ config: testConfig(root), records, github }); t.after(() => app.stop());
  const { url } = await app.start();
  const { environments } = await app.resources.forOwner(null);
  const environment = await environments.save({ name: "Personal projects", backend: "local", companies: ["personal-projects"], allowUnassigned: false });
  const isolated = await environments.save({ name: "Other company", backend: "local", companies: ["other"], allowUnassigned: false });
  const input = { agent: "mock", environmentId: environment.id, repositories: [{ fullName: "thomfilg/app", githubConnectionId: personal.id, branch: "main", companyId: "other" }] };
  const created = await app.manager.createChat(input);
  assert.equal(companyForChat(created), "personal-projects");
  assert.equal(companyForChat(app.store.get(created.id)), "personal-projects");
  await assert.rejects(app.manager.createChat({ ...input, environmentId: isolated.id }), { statusCode: 403 });
  const response = await fetch(`${url}/api/preferences`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  assert.equal(response.status, 200); assert.equal((await response.json()).preferences.repositories[0].companyId, "personal-projects");
  // An environment can be remembered before its repository is chosen, without
  // turning that incomplete draft into permission to run an unassigned chat.
  const draft = { agent: "mock", environmentId: isolated.id, repositories: [] };
  const remembered = await fetch(`${url}/api/preferences`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) });
  assert.equal(remembered.status, 200);
  const loaded = (await (await fetch(`${url}/api/preferences`)).json()).preferences;
  assert.equal(loaded.environmentId, isolated.id); assert.deepEqual(loaded.repositories, []);
  const chatCount = app.store.list().length;
  const restored = await fetch(`${url}/api/preferences/restore?company=personal-projects&repository=thomfilg%2Fapp`);
  assert.equal(restored.status, 200);
  const restoredSelection = (await restored.json()).selection;
  assert.equal(restoredSelection.environmentId, environment.id);
  assert.equal(restoredSelection.repositories[0].companyId, "personal-projects");
  assert.equal(restoredSelection.repositories[0].branch, "main");
  assert.equal(restoredSelection.agent, "mock");
  assert.equal(app.store.list().length, chatCount, "Restoring options never creates a chat or starts its worker");
  assert.equal(app.store.get(created.id).status, "stopped");
  const unfinished = await fetch(`${url}/api/preferences/restore?company=other`);
  assert.equal(unfinished.status, 200); assert.deepEqual((await unfinished.json()).selection.repositories, []);
  const denied = await fetch(`${url}/api/chats`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) });
  assert.equal(denied.status, 403); assert.equal(app.store.list().length, chatCount);
  assert.equal((await environments.get(isolated.id)).allowUnassigned, false);
  const scratch = await app.manager.createChat({ agent: "mock", repositories: [] });
  assert.equal(companyForChat(scratch), null); assert.equal(scratch.repositories.length, 0);
});

test("unassigned GitHub credentials are preserved but unavailable until explicitly assigned", async () => {
  const { records, companies } = await setup();
  const legacy = { id: "github", login: "fixture", accountId: 1, token: "fixture-legacy-token", companies: ["acme", "other"], revision: 4 };
  await records.put("connection", "github", legacy);
  const { github, calls } = githubFixture(records, companies);
  assert.equal((await github.status()).connections[0].scopeNeedsReview, true);
  assert.deepEqual(await github.repositories(), []); assert.equal(calls.length, 0);
  await assert.rejects(github.requireConnection({ repository: "acme/app" }), { statusCode: 403 });
  await github.update({ id: "github", name: "Personal", companyId: "acme", revision: 4 });
  assert.equal((await github.get("github")).token, legacy.token); assert.equal(calls.length, 0);
  assert.equal((await github.repositories()).length, 2);
  assert.equal((await github.requireConnection({ repository: "acme/app" })).companyId, "acme");
  await github.close();
});

test("company HTTP registration and connection assignment enforce Google ownership", async t => {
  const fixture = googleOidcFixture(), config = testConfig(await temporaryDirectory(t), googleTestEnv);
  const app = await createAgentWebServer({ config, googleAuthOptions: { fetchImpl: fixture.fetch } });
  const { url } = await app.start(); config.google.origin = url; await app.googleAuth.initialize(); t.after(() => app.stop());
  const alice = cookieClient(url), bob = cookieClient(url), anonymous = cookieClient(url);
  const post = (client, route, value) => client.request(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  assert.equal((await anonymous.request("/api/companies")).status, 401);
  await alice.login(fixture); await bob.login(fixture, { sub: "bob-company-test", email: "member@example.com", email_verified: true });
  assert.equal((await post(alice, "/api/companies", { id: "acme", name: "Acme" })).status, 201);
  assert.deepEqual((await (await bob.request("/api/companies")).json()).companies, []);
  const mcp = { name: "docs", companyId: "acme", type: "http", authMode: "none", url: "https://example.test/mcp" };
  assert.equal((await post(bob, "/api/mcps", mcp)).status, 400);
  const created = await post(alice, "/api/mcps", mcp); assert.equal(created.status, 201);
  const { connection } = await created.json();
  assert.equal((await bob.request(`/api/mcps/${connection.id}`, { method: "DELETE" })).status, 404);
  assert.equal((await post(alice, "/api/mcps", { ...mcp, companyId: undefined, companies: ["acme", "other"] })).status, 400);
});

test("Codex and Claude adapters receive company MCP capabilities even when the saved environment selection is empty", async t => {
  const { records, mcps } = await setup(), root = await temporaryDirectory(t), store = new ChatStore(root, records); await store.initialize();
  const connection = await mcps.save({ name: "linear", companyId: "acme", type: "http", url: "https://example.test/mcp", authMode: "headers", headers: { Authorization: "Bearer upstream-controller-only-fixture" } });
  await mcps.save({ name: "linear", companyId: "other", type: "http", url: "https://other.test/mcp", authMode: "none" });
  const environments = new Environments(records, "local", mcps), environment = await environments.save({ name: "Acme", companies: ["acme"], backend: "local", mcpIds: [] });
  const captures = [];
  const manager = new RuntimeManager({ store, config: testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "60000" }), broker: new CapabilityBroker({ ttlMs: 10000 }), environments, mcps,
    workerBackend: { acquire: async chat => { await mkdir(chat.workspace, { recursive: true }); await mkdir(store.runtimeHome(chat.id), { recursive: true }); return { workspace: chat.workspace, runtimeHome: store.runtimeHome(chat.id), mkdir: directory => mkdir(directory, { recursive: true }), spawn, gatewayOrigin: "http://localhost" }; }, sleep: async () => {}, destroy: async () => {} },
    adapterFactory: ({ executor }) => { captures.push(executor.mcpServers); return { start: async () => {}, send: async () => ({ text: "fixture only" }), stop: async () => {} }; },
  });
  t.after(() => manager.shutdown());
  for (const agent of ["codex", "claude"]) {
    const created = await store.create({ agent, ...chat("acme"), environmentId: environment.id }); await store.update(created.id, { workspaceReady: true });
    await manager.send(created.id, "Fixture adapter only; no provider request");
    const servers = Object.values(captures.at(-1)); assert.equal(servers.length, 1); assert.ok(servers[0].url.endsWith(`/gateway/mcp/${connection.id}`));
    assert.match(servers[0].headers.Authorization, /^Bearer /); assert.doesNotMatch(JSON.stringify(servers), /upstream-controller-only-fixture/);
    assert.doesNotMatch(JSON.stringify([store.get(created.id), manager.eventsSince(created.id)]), /upstream-controller-only-fixture/);
    await manager.stop(created.id); assert.equal(mcps.grants.has(created.id), false);
  }
});
