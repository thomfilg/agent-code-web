import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpConnections } from "../src/mcp-connections.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { userRecords } from "../src/user-services.mjs";
import { oauthCookieName } from "../src/mcp-oauth.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { startMcpFixture } from "./fixtures/mcp-server.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";
import { isLinearMcp } from "../public/mcp-provider.js";

const cookies = flow => ({ [oauthCookieName(flow.state)]: flow.cookie });
async function consent(flow, origin) {
  const url = new URL(flow.authorizationUrl); url.pathname = "/approve";
  const approved = await fetch(new URL(url.pathname + url.search, origin || url.origin), { redirect: "manual" });
  assert.equal(approved.status, 302);
  return new URL(approved.headers.get("location")).searchParams;
}
async function linearFixture(t, options = {}) {
  const service = await startMcpFixture({ advertisedOrigin: "https://mcp.linear.app", linear: true, ...options });
  t.after(() => service.close());
  const fetchImpl = (url, init) => { const parsed = new URL(url); assert.equal(parsed.origin, "https://mcp.linear.app"); return fetch(new URL(parsed.pathname + parsed.search, service.origin), init); };
  const records = new MemoryRecords(), mcps = new McpConnections(records, { fetchImpl });
  const c = await mcps.save({ name: "linear", companies: ["12-apps"], type: "http", authMode: "oauth", url: "https://mcp.linear.app/mcp" });
  return { service, mcps, records, c };
}

test("Linear exact endpoint detection does not trust a connection name or lookalike origin", () => {
  assert.equal(isLinearMcp("https://mcp.linear.app/mcp"), true);
  assert.equal(isLinearMcp("https://mcp.linear.app/mcp/readonly"), true);
  for (const url of ["https://mcp.linear.app.evil.test/mcp", "https://mcp.linear.app/other", "http://mcp.linear.app/mcp", "https://user@mcp.linear.app/mcp", "https://mcp.linear.app/mcp?token=secret", "linear"]) assert.equal(isLinearMcp(url), false);
});

test("Linear defaults to read-only dynamic registration and verifies an authenticated read, not just discovery", async t => {
  const { service, mcps, c } = await linearFixture(t);
  assert.equal(c.oauthScopes, "read"); assert.equal(c.oauthConnected, false);
  assert.equal((await mcps.test(c.id)).health.status, "needs_auth"); assert.equal(service.calls, 0);
  const flow = await mcps.oauth.begin(c.id, "http://localhost:8787/oauth/mcp/callback");
  assert.equal(new URL(flow.authorizationUrl).searchParams.get("scope"), "read");
  assert.equal(mcps.oauth.status(c.id).status, "pending");
  for (const privateValue of [flow.state, flow.cookie]) assert.ok(!JSON.stringify(await mcps.list()).includes(privateValue));
  await mcps.oauth.finish(await consent(flow, service.origin), cookies(flow));
  const verified = await mcps.test(c.id);
  assert.equal(verified.health.status, "connected"); assert.equal(service.calls, 1);
  assert.equal(verified.health.workspaceRead.tool, "list_teams");
  assert.ok(!JSON.stringify(verified).includes("fixture-workspace"), "verification must not persist private team data");
  service.failTool = true;
  assert.equal((await mcps.test(c.id)).health.status, "error", "listed tools do not imply a successful workspace read");
  service.failTool = false;
  const changed = await mcps.save({ ...verified, oauthScopes: "read write" }, c.id);
  assert.equal(changed.oauthConnected, false, "expanding permissions must require new consent");
  const expanded = await mcps.oauth.begin(c.id, "http://localhost:8787/oauth/mcp/callback");
  assert.equal(new URL(expanded.authorizationUrl).searchParams.get("scope"), "read write");
  await mcps.oauth.cancel(c.id);
});

test("OAuth status reports denial, cancellation, expiry and missing registration without falsely connecting", async t => {
  const { service, mcps, c } = await linearFixture(t);
  let flow = await mcps.oauth.begin(c.id, "http://localhost:8787/oauth/mcp/callback");
  await assert.rejects(mcps.oauth.finish(new URLSearchParams({ state: flow.state, error: "access_denied", error_description: "sensitive-provider-body" }), cookies(flow)), /declined/);
  assert.equal((await mcps.list())[0].signIn.status, "failed");
  assert.ok(!JSON.stringify(await mcps.list()).includes("sensitive-provider-body"));
  flow = await mcps.oauth.begin(c.id, "http://localhost:8787/oauth/mcp/callback");
  await mcps.oauth.cancel(c.id);
  await assert.rejects(mcps.oauth.finish(await consent(flow, service.origin), cookies(flow)), /Invalid or expired/);
  assert.equal((await mcps.list())[0].signIn.status, "cancelled");
  flow = await mcps.oauth.begin(c.id, "http://localhost:8787/oauth/mcp/callback");
  mcps.oauth.attempts.get(c.id).expiresAt = 0;
  assert.equal((await mcps.list())[0].signIn.status, "expired");
  assert.equal(mcps.oauth.flows.has(flow.state), false);
  assert.equal((await mcps.list())[0].oauthConnected, false);
  const manual = await startMcpFixture({ dynamicRegistration: false, preRegisteredClients: [{ client_id: "registered-relay", redirect_uris: ["http://localhost:8787/oauth/mcp/callback"] }] });
  t.after(() => manual.close());
  const connection = await mcps.save({ name: "registered", allowUnassigned: true, type: "http", authMode: "oauth", url: `${manual.origin}/mcp` });
  mcps.fetch = fetch;
  await assert.rejects(mcps.oauth.begin(connection.id, "http://localhost:8787/oauth/mcp/callback"), /pre-registered OAuth client/);
  assert.equal((await mcps.list()).find(c => c.id === connection.id).signIn.status, "failed");
  const configured = await mcps.save({ ...connection, oauthClientId: "registered-relay" }, connection.id);
  flow = await mcps.oauth.begin(configured.id, "http://localhost:8787/oauth/mcp/callback");
  assert.equal((await mcps.oauth.finish(await consent(flow), cookies(flow))).oauthConnected, true);
});

test("cancelling while the token exchange is pending never saves newly issued credentials", async t => {
  let release, exchanging = false;
  const { service, mcps, c } = await linearFixture(t, { beforeExchange: async () => { exchanging = true; await new Promise(resolve => { release = resolve; }); } });
  const flow = await mcps.oauth.begin(c.id, "http://localhost:8787/oauth/mcp/callback");
  const pending = mcps.oauth.finish(await consent(flow, service.origin), cookies(flow));
  const rejected = assert.rejects(pending, /cancelled or replaced/);
  await waitFor(() => exchanging); await mcps.oauth.cancel(c.id); release(); await rejected;
  assert.equal((await mcps.list())[0].oauthConnected, false);
});

test("legacy blank Linear scopes are not expanded, cancellation retains prior consent, and rejected refresh requires sign-in", async t => {
  const { service, mcps, records, c } = await linearFixture(t);
  const original = await mcps.get(c.id); await records.put("mcp", c.id, { ...original, oauthScopes: "" });
  const flow = await mcps.oauth.begin(c.id, "http://localhost:8787/oauth/mcp/callback");
  assert.equal(new URL(flow.authorizationUrl).searchParams.get("scope"), "read", "old blank settings must not request every advertised permission");
  await mcps.oauth.finish(await consent(flow, service.origin), cookies(flow));
  const before = await mcps.get(c.id);
  await mcps.oauth.begin(c.id, "http://localhost:8787/oauth/mcp/callback"); await mcps.oauth.cancel(c.id);
  assert.deepEqual((await mcps.get(c.id)).oauth, before.oauth, "cancelling a reconnect leaves existing authorization untouched");
  await records.put("mcp", c.id, { ...before, oauth: { ...before.oauth, expiresAt: 0 } }); service.rejectTokens = true;
  await assert.rejects(mcps.oauth.headers(await mcps.get(c.id)), /Sign in/);
  assert.equal((await mcps.list())[0].health.status, "needs_auth");
});

for (const action of ["cancel", "replace", "delete"]) test(`OAuth ${action} at the persistence boundary cannot commit late credentials`, async t => {
  const { service, mcps, records, c } = await linearFixture(t);
  const initial = await mcps.oauth.begin(c.id, "http://localhost:8787/oauth/mcp/callback");
  await mcps.oauth.finish(await consent(initial, service.origin), cookies(initial));
  const before = structuredClone(await mcps.get(c.id));
  const flow = await mcps.oauth.begin(c.id, "http://localhost:8787/oauth/mcp/callback");
  const put = records.put.bind(records); let gated = false, release;
  records.put = async (kind, id, value) => {
    if (!gated && kind === "mcp" && id === c.id && value.oauth?.tokens && value.authGeneration !== before.authGeneration) {
      gated = true; await new Promise(resolve => { release = resolve; });
    }
    return put(kind, id, value);
  };
  const finishing = mcps.oauth.finish(await consent(flow, service.origin), cookies(flow));
  const rejected = assert.rejects(finishing, /cancelled or replaced/);
  await waitFor(() => gated);
  let interruptionDone = false;
  const interrupted = (action === "cancel" ? mcps.oauth.cancel(c.id) : action === "replace" ? mcps.oauth.begin(c.id, "http://localhost:8787/oauth/mcp/callback") : mcps.remove(c.id)).then(value => { interruptionDone = true; return value; });
  await waitFor(() => mcps.oauth.attempts.get(c.id)?.state !== flow.state);
  assert.equal(interruptionDone, false, "cancellation/replacement/deletion must wait for guarded persistence to settle");
  let disclosed = false;
  const reading = mcps.list().then(value => { disclosed = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(disclosed, false, "public reads must not disclose provisional credential state");
  release(); await rejected; await interrupted; await reading;
  if (action === "delete") await assert.rejects(mcps.get(c.id), /not found/);
  else {
    assert.deepEqual(await mcps.get(c.id), before, "prior authorization and its generation must be restored exactly");
    if (action === "replace") { assert.equal(mcps.oauth.status(c.id).status, "pending"); await mcps.oauth.cancel(c.id); }
  }
});

test("editing an authenticated connection cannot masquerade as a completed new OAuth attempt", async t => {
  const { service, mcps, c } = await linearFixture(t);
  const first = await mcps.oauth.begin(c.id, "http://localhost:8787/oauth/mcp/callback");
  await mcps.oauth.finish(await consent(first, service.origin), cookies(first));
  const saved = await mcps.get(c.id), pending = await mcps.oauth.begin(c.id, "http://localhost:8787/oauth/mcp/callback");
  await mcps.save({ ...saved, name: "renamed-linear" }, c.id);
  const current = (await mcps.list())[0];
  assert.equal(current.oauthConnected, true); assert.ok(current.revision > saved.revision);
  assert.equal(current.signIn.status, "cancelled"); assert.equal(current.signIn.id, pending.attemptId);
  await assert.rejects(mcps.oauth.finish(await consent(pending, service.origin), cookies(pending)), /Invalid or expired/);
});

test("independent same-name workspace OAuth reaches both selected provider environments with no company or owner fallback", async t => {
  const fixtures = new Map();
  for (const company of ["12-apps", "g2i"]) {
    const service = await startMcpFixture({ advertisedOrigin: "https://mcp.linear.app", linear: true, workspace: company, accessToken: `access-${company}`, refreshToken: `refresh-${company}` });
    fixtures.set(company, service); t.after(() => service.close());
  }
  let authorizing = "12-apps", upstreamFailure;
  const fetchImpl = (url, init = {}) => {
    const parsed = new URL(url), token = new Headers(init.headers).get("authorization");
    assert.equal(parsed.origin, "https://mcp.linear.app");
    const company = token?.startsWith("Bearer access-") ? token.slice("Bearer access-".length) : authorizing;
    assert.ok(fixtures.has(company));
    return fetch(new URL(parsed.pathname + parsed.search, fixtures.get(company).origin), init).catch(error => { upstreamFailure = error; throw error; });
  };
  const root = await temporaryDirectory(t), seen = [];
  const app = await createAgentWebServer({ config: testConfig(root), models: { creationSettings: async () => ({}), turnSettings: async () => ({}) },
    adapterFactory: ({ chat, executor }) => ({ start: async () => {
      const selected = Object.entries(executor.mcpServers).filter(([name]) => name.startsWith("relay_linear_"));
      assert.equal(selected.length, 1); const [, server] = selected[0];
      assert.ok(!JSON.stringify(executor.mcpServers).includes("access-"));
      const client = new Client({ name: `${chat.agent}-fixture-adapter`, version: "1" });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
        const result = await client.callTool({ name: "list_teams", arguments: { limit: 1 } });
        seen.push({ agent: chat.agent, workspace: JSON.parse(result.content[0].text).teams[0].id, server });
      } finally { await client.close(); }
    }, send: async () => ({ text: "verified" }), stop: async () => {} }) });
  await app.start(); t.after(() => app.stop());
  const githubIds = new Map([...fixtures.keys()].map((company, index) => [company, `github_00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`]));
  for (const [companyId, id] of githubIds) {
    await (await app.resources.forOwner(null)).companies.save({ id: companyId, name: companyId });
    await app.records.put("github_connection", id, { id, companyId, token: `synthetic-linear-github-${companyId}`, revision: 1 });
  }
  app.manager.github.fetch = async () => { throw new Error("Unexpected external GitHub request in Linear fixture"); };
  const mcps = app.manager.mcps; mcps.fetch = fetchImpl;
  const ids = [];
  for (const company of fixtures.keys()) {
    authorizing = company;
    const c = await mcps.save({ name: "linear", companies: [company], type: "http", url: "https://mcp.linear.app/mcp", authMode: "oauth" }); ids.push(c.id);
    const flow = await mcps.oauth.begin(c.id, "http://localhost:8787/oauth/mcp/callback");
    await mcps.oauth.finish(await consent(flow, fixtures.get(company).origin), cookies(flow));
  }
  const otherUser = new McpConnections(userRecords(app.records, "another-user"), { fetchImpl });
  assert.notEqual((await mcps.get(ids[0])).oauth.clientInformation.client_id, (await mcps.get(ids[1])).oauth.clientInformation.client_id, "workspaces must not reuse another connection's registration context");
  assert.deepEqual(await otherUser.list(), []);
  await assert.rejects(otherUser.runtime("foreign-chat", ids, "http://localhost"), /not found/);
  await assert.rejects(otherUser.oauth.begin(ids[0], "http://localhost:8787/oauth/mcp/callback"), /not found/);
  await assert.rejects(otherUser.oauth.cancel(ids[0]), /not found/);
  const environment = await app.manager.environments.save({ name: "Scoped Linear", backend: "local", companies: ["12-apps", "g2i"], allowUnassigned: true, mcpIds: ids });
  for (const agent of ["codex", "claude"]) for (const company of fixtures.keys()) {
    const chat = await app.manager.createChat({ agent, title: "Fixture scoped runtime", environmentId: environment.id });
    // Complete synthetic selections preserve real GitHub admission while the
    // fixture exercises Linear; no clone or upstream GitHub call is involved.
    await app.store.update(chat.id, { repositories: [{ id: 31, githubConnectionId: githubIds.get(company), fullName: `${company}/fixture` }, { id: 32, githubConnectionId: githubIds.get(company), fullName: `${company === "g2i" ? "12-apps" : "g2i"}/secondary` }] });
    await app.manager.send(chat.id, "fixture read");
    assert.equal(seen.at(-1).agent, agent); assert.equal(seen.at(-1).workspace, company);
    const token = seen.at(-1).server.headers.Authorization.slice(7);
    await app.manager.stop(chat.id); assert.equal(mcps.broker.validate(token, "mcp"), null);
    await app.manager.send(chat.id, "fixture resume"); assert.equal(seen.at(-1).workspace, company);
    await app.manager.stop(chat.id);
  }
  const connection = await mcps.get(ids[0]); fixtures.get("12-apps").rejectTokens = true;
  const runtime = await mcps.runtime("revoked", ids, `http://127.0.0.1:${app.server.address().port}`, { repositories: [{ fullName: "12-apps/fixture" }] });
  const server = Object.values(runtime)[0];
  const rejected = await fetch(server.url, { method: "POST", headers: { ...server.headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }) });
  assert.equal(rejected.status, 401, upstreamFailure?.cause?.message || upstreamFailure?.message); await rejected.text();
  assert.equal((await mcps.list()).find(c => c.id === connection.id).health.status, "needs_auth");
  assert.notEqual((await mcps.list()).find(c => c.id === ids[1]).health.status, "needs_auth");
  assert.equal((await mcps.test(ids[1])).health.status, "connected", "the other workspace remains independently usable");
});
