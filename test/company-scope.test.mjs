import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { companyForChat, companyScope, normalizeCompanyScope, scopeAllows } from "../public/company-scope.js";
import { MemoryRecords } from "../src/database.mjs";
import { Environments } from "../src/environments.mjs";
import { McpConnections } from "../src/mcp-connections.mjs";
import { GitHubConnection } from "../src/github.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

const chat = company => ({ repositories: [{ fullName: `${company}/project` }] });
test("company allowlists normalize multiple owners and never turn a blank legacy scope into a global grant", () => {
  const scope = normalizeCompanyScope({ companies: ["12-APPS", "thomfilg", "12-apps"] });
  assert.deepEqual(scope, { companies: ["12-apps", "thomfilg"], allowUnassigned: false });
  for (const company of ["12-apps", "thomfilg"]) assert.equal(scopeAllows(scope, company), true);
  for (const company of ["g2i", "umg", null]) assert.equal(scopeAllows(scope, company), false);
  for (const legacy of [{}, { organization: null }]) for (const company of ["12-apps", "g2i", null]) assert.equal(scopeAllows(legacy, company), false);
  assert.deepEqual(companyScope({ organization: "g2i" }).companies, ["g2i"]);
  for (const companies of [["*"], ["https://github.com/g2i"], [null], "g2i"]) assert.throws(() => normalizeCompanyScope({ companies }), /GitHub owners/);
  assert.equal(companyForChat({ ...chat("12-apps"), customGroupId: "g2i", repositories: [...chat("12-apps").repositories, ...chat("g2i").repositories] }), "12-apps");
});
test("MCP multi-company connections grant only explicitly selected primary companies and revoke on scope edits", async () => {
  const records = new MemoryRecords(), mcps = new McpConnections(records);
  const shared = await mcps.save({ name: "linear", companies: ["12-apps", "thomfilg"], type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer fixture-future-secret" } });
  const other = await mcps.save({ name: "linear", companies: ["g2i"], type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer fixture-g2i-secret" } });
  const local = await mcps.save({ name: "local", companies: ["g2i"], type: "stdio", command: "node", args: ["g2i.mjs"] });
  for (const company of ["12-apps", "thomfilg", "g2i", "umg"]) {
    const runtime = await mcps.runtime(company, [shared.id, other.id, local.id], "http://localhost", chat(company));
    assert.ok(!JSON.stringify(runtime).includes("secret"));
    assert.deepEqual([...mcps.grants.get(company).keys()], company === "g2i" ? [other.id, local.id] : company === "umg" ? [] : [shared.id]);
  }
  await mcps.runtime("unassigned", [shared.id, other.id], "http://localhost"); assert.equal(mcps.grants.get("unassigned").size, 0);
  await mcps.save({ ...shared, companies: ["thomfilg"] }, shared.id);
  assert.equal(mcps.grants.get("12-apps").size, 0);
  assert.deepEqual([...mcps.grants.get("g2i").keys()], [other.id, local.id]);
});
test("environments reject excluded companies before returning worker variables, including after restart and migration", async () => {
  const records = new MemoryRecords(), envs = new Environments(records);
  for (const id of ["12-apps", "thomfilg"]) await envs.companies.save({ id, name: id });
  const env = await envs.save({ name: "Future", backend: "local", companies: ["12-apps"], variables: [{ key: "REGION", value: "allowed", secret: false }, { key: "SECRET", value: "protected" }] });
  assert.ok(!JSON.stringify(await envs.list()).includes("protected"));
  assert.deepEqual((await envs.runtime(env.id, chat("12-apps"))).variables, { REGION: "allowed" });
  for (const company of ["g2i", "umg"]) await assert.rejects(envs.runtime(env.id, chat(company)), { statusCode: 403 });
  await assert.rejects(envs.runtime(env.id), { statusCode: 403 });
  await envs.save({ ...env, companies: ["thomfilg"], companyId: "thomfilg" }, env.id);
  await assert.rejects(new Environments(records).runtime(env.id, chat("12-apps")), { statusCode: 403 });
  await records.put("environment", "legacy", { id: "legacy", name: "Legacy", variables: [], backend: "local" });
  await assert.rejects(envs.runtime("legacy", chat("g2i")), { statusCode: 403 });
});

function fixtureGithub(records = new MemoryRecords()) {
  const calls = [];
  const github = new GitHubConnection({ records, config: { apiBase: "https://api.github.com" }, fetchImpl: async (url, options) => {
    const pathname = new URL(url).pathname; calls.push({ pathname, token: options.headers.authorization });
    if (pathname === "/user") return Response.json({ login: "fixture", id: 1 });
    if (pathname === "/user/repos") return Response.json(["12-apps/project", "thomfilg/project", "g2i/project", "umg/project"].map((full_name, id) => ({ full_name, id, default_branch: "main" })));
    if (pathname.endsWith("/branches")) return Response.json([{ name: "main" }]);
    if (pathname.includes("/branches/")) return Response.json({ name: "main" });
    return Response.json({ full_name: pathname.slice(7), id: 1, default_branch: "main", size: 1 });
  } });
  return { github, calls, records };
}
test("GitHub uses provider repository permissions and explicit connections, never Relay company matching", async () => {
  const { github, calls } = fixtureGithub();
  const future = (await github.connect({ name: "Future", token: "fixture-future-token", companies: ["12-apps", "thomfilg"] })).connection;
  const g2i = (await github.connect({ name: "G2i", token: "fixture-g2i-token", companies: ["g2i"] })).connection;
  assert.equal((await github.status()).connections.length, 2); assert.ok(!JSON.stringify(await github.status()).includes("token"));
  const repos = await github.repositories();
  assert.deepEqual(repos.filter(repo => repo.githubConnectionId === future.id).map(repo => repo.fullName).sort(), ["12-apps/project", "g2i/project", "thomfilg/project", "umg/project"]);
  assert.equal(repos.filter(repo => repo.githubConnectionId === g2i.id).length, 4);
  const count = calls.length;
  await assert.rejects(github.request("/repos/umg/project"), { statusCode: 409 });
  await assert.rejects(github.request("/repos/g2i/project", { connectionId: "github_ffffffff-ffff-ffff-ffff-ffffffffffff" }), { statusCode: 404 });
  await assert.rejects(github.request("/graphql", { connectionId: g2i.id }), /repository is required/);
  assert.equal(calls.length, count);
  await github.request("/repos/g2i/project", { connectionId: future.id }); assert.equal(calls.at(-1).token, "Bearer fixture-future-token");
  await github.request("/repos/12-apps/project", { connectionId: g2i.id }); assert.equal(calls.at(-1).token, "Bearer fixture-g2i-token");
  const selected = await github.resolveSelections([{ fullName: "12-apps/project", githubConnectionId: future.id }]);
  assert.equal(selected[0].githubConnectionId, future.id);
  assert.equal(await github.tokenForRepository(selected[0]), "fixture-future-token");
  await github.connect({ ...future, companies: ["thomfilg"] });
  assert.equal(await github.tokenForRepository(selected[0]), "fixture-future-token");
  const duplicate = (await github.connect({ name: "Other G2i", token: "fixture-another-token", companies: ["g2i"] })).connection;
  await assert.rejects(github.request("/repos/g2i/project"), { statusCode: 409 });
  await github.request("/repos/g2i/project", { connectionId: g2i.id }); assert.equal(calls.at(-1).token, "Bearer fixture-g2i-token");
  await github.disconnect(duplicate.id); assert.equal((await github.status()).connections.length, 2);
});
test("existing empty, missing and restrictive GitHub scopes need no migration or fresh consent", async () => {
  for (const kind of ["connection", "github_connection"]) for (const oldScope of [{}, { companies: [] }, { companies: ["12-apps"] }, { organization: "g2i", allowUnassigned: false }]) {
    const { github, records, calls } = fixtureGithub();
    const id = kind === "connection" ? "github" : "github_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const saved = { id, token: "fixture-legacy-token", login: "old", revision: 7, ...oldScope };
    await records.put(kind, id, saved);
    const legacy = (await github.status()).connections[0];
    assert.equal(legacy.repositoryAccess, "github");
    for (const key of ["token", "companies", "organization", "allowUnassigned", "scopeNeedsReview"]) assert.equal(Object.hasOwn(legacy, key), false);
    assert.equal((await github.repositories()).length, 4);
    await github.request("/repos/g2i/project"); assert.equal(calls.at(-1).token, "Bearer fixture-legacy-token");
    assert.deepEqual(await records.get(kind, id), saved);
    await github.close();
  }
});
test("secondary repositories retain their selected GitHub connection; provider denial never borrows another token", async () => {
  const { github, calls } = fixtureGithub();
  const future = (await github.connect({ name: "Future", token: "fixture-future-token", companies: ["12-apps"] })).connection;
  const g2i = (await github.connect({ name: "G2i", token: "fixture-g2i-token", companies: ["g2i"] })).connection;
  const selections = [{ fullName: "12-apps/project", githubConnectionId: future.id }, { fullName: "g2i/project", githubConnectionId: g2i.id }];
  assert.equal((await github.resolveSelections(selections)).length, 2);
  assert.equal(await github.tokenForRepository(selections[1], { repositories: selections }), "fixture-g2i-token");
  for (const status of [403, 404]) {
    const providerCalls = [];
    github.fetch = async (_url, options) => { providerCalls.push(options.headers.authorization); return Response.json({ message: "provider fixture denied" }, { status }); };
    await assert.rejects(github.resolveSelections([selections[1]], { company: "12-apps" }), { statusCode: status });
    assert.deepEqual(providerCalls, ["Bearer fixture-g2i-token"]);
    await assert.rejects(github.request("/repos/g2i/project", { connectionId: future.id }), { statusCode: status });
    assert.equal(providerCalls.at(-1), "Bearer fixture-future-token");
  }
});
test("environment scope edits revoke existing MCP grants and block the next turn without losing real messages", async t => {
  const root = await temporaryDirectory(t), records = new MemoryRecords(), store = new ChatStore(root, records); await store.initialize();
  const mcps = new McpConnections(records), environments = new Environments(records, "local", mcps);
  for (const id of ["12-apps", "g2i"]) await environments.companies.save({ id, name: id });
  const first = await mcps.save({ name: "first", companies: ["12-apps"], type: "http", url: "https://tools.example/mcp" });
  const second = await mcps.save({ name: "second", companies: ["12-apps"], type: "http", url: "https://tools.example/mcp" });
  let environment = await environments.save({ name: "Future", backend: "local", companies: ["12-apps"], mcpIds: [first.id, second.id] });
  const manager = new RuntimeManager({ store, config: testConfig(root), broker: new CapabilityBroker({ ttlMs: 10000 }), environments, mcps }); t.after(() => manager.shutdown());
  const created = await store.create({ agent: "mock", title: "Scoped fixture", ...chat("12-apps"), environmentId: environment.id });
  await store.appendMessage(created.id, { role: "user", text: "Keep this actual message" });
  await mcps.runtime(created.id, environment.mcpIds, "http://localhost", created);
  const revoked = new AbortController(); mcps.grants.get(created.id).get(first.id).streams.add(revoked);
  environment = await environments.save({ ...environment, mcpIds: [second.id] }, environment.id);
  assert.equal(revoked.signal.aborted, true); assert.deepEqual([...mcps.grants.get(created.id).keys()], [second.id]);
  await environments.save({ ...environment, companies: ["g2i"], companyId: "g2i" }, environment.id);
  assert.equal(mcps.grants.get(created.id).size, 0);
  await assert.rejects(manager.submit(created.id, "This must not reach an agent"), { statusCode: 403 });
  assert.deepEqual(store.get(created.id).messages.map(message => message.text), ["Keep this actual message"]);
});
test("the configured default source is company-checked before cloning, even if omitted from the request", async t => {
  const root = await temporaryDirectory(t), records = new MemoryRecords(), store = new ChatStore(root, records); await store.initialize();
  const environments = new Environments(records);
  await environments.companies.save({ id: "other", name: "Other" });
  const environment = await environments.save({ name: "Other company only", backend: "local", companies: ["other"] });
  const manager = new RuntimeManager({ store, config: testConfig(root, { AGENT_WORKSPACE_SOURCE: "https://github.com/g2i/project.git" }), broker: new CapabilityBroker({ ttlMs: 10000 }), environments });
  t.after(() => manager.shutdown());
  await assert.rejects(manager.createChat({ agent: "mock", environmentId: environment.id }), { statusCode: 403 });
  assert.equal(store.list().length, 0);
});
test("Git's transient auth header matches only the exact selected repository, not another company", () => {
  const args = ["-c", "http.https://github.com/12-apps/project.git.extraheader=fixture-auth", "config", "--get-urlmatch", "http.extraheader"];
  assert.equal(execFileSync("git", [...args, "https://github.com/12-apps/project.git/info/refs"], { encoding: "utf8" }).trim(), "fixture-auth");
  for (const url of ["https://github.com/g2i/project.git/info/refs", "https://github.com/12-apps/project-other.git/info/refs"]) assert.throws(() => execFileSync("git", [...args, url], { stdio: "pipe" }));
});
