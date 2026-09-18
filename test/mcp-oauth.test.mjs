import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpConnections } from "../src/mcp-connections.mjs";
import { oauthCookieName } from "../src/mcp-oauth.mjs";
import { MemoryRecords, RecordCipher } from "../src/database.mjs";
import { startMcpFixture } from "./fixtures/mcp-server.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

async function fixture(t) {
  const service = await startMcpFixture({ anonymousInitialize: true }); t.after(() => service.close());
  const records = new MemoryRecords(), mcps = new McpConnections(records);
  const c = await mcps.save({ name: "custom", allowUnassigned: true, type: "http", url: `${service.origin}/mcp`, authMode: "oauth" });
  return { service, records, mcps, c };
}
async function consent(flow) {
  const url = new URL(flow.authorizationUrl); assert.equal(url.searchParams.get("code_challenge_method"), "S256"); assert.ok(url.searchParams.get("code_challenge"));
  url.pathname = url.pathname.replace(/\/authorize$/, "/approve"); const approval = await fetch(url, { redirect: "manual" }); assert.equal(approval.status, 302);
  return new URL(approval.headers.get("location")).searchParams;
}
const cookies = flow => ({ [oauthCookieName(flow.state)]: flow.cookie });

test("custom OAuth: PKCE consent, masked encrypted persistence, real MCP discovery and tool call through worker gateway", async t => {
  const { service, records, mcps, c } = await fixture(t);
  assert.equal((await mcps.test(c.id)).health.status, "needs_auth"); // Anonymous initialize must not fake authentication.
  const flow = await mcps.oauth.begin(c.id, "http://127.0.0.1:8787/oauth/mcp/callback");
  const saved = await mcps.oauth.finish(await consent(flow), cookies(flow)); assert.equal(saved.oauthConnected, true);
  const serialized = JSON.stringify(await mcps.list());
  for (const secret of ["fixture-access-secret", "fixture-refresh-secret", "codeVerifier", "clientInformation"]) assert.ok(!serialized.includes(secret));
  const cipher = new RecordCipher(randomBytes(32)), raw = await records.get("mcp", c.id), sealed = cipher.seal("mcp", c.id, raw);
  assert.ok(!sealed.includes(Buffer.from("fixture-access-secret")));
  const restored = new MemoryRecords(); await restored.put("mcp", c.id, cipher.open("mcp", c.id, sealed));
  const restarted = new McpConnections(restored);
  const checked = await restarted.test(c.id); assert.equal(checked.health.status, "connected"); assert.equal(checked.health.tools[0].name, "fixture_echo"); assert.equal(service.calls, 0);
  const server = http.createServer((req, res) => restarted.handle(req, res, new URL(req.url, "http://localhost")));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => { server.close(); server.closeAllConnections(); });
  const runtime = await restarted.runtime("worker", [c.id], `http://127.0.0.1:${server.address().port}`);
  assert.ok(!JSON.stringify(runtime).includes("fixture-access-secret"));
  const client = new Client({ name: "worker", version: "1" }), transport = new StreamableHTTPClientTransport(new URL(runtime.relay_custom.url), { requestInit: { headers: runtime.relay_custom.headers } });
  t.after(() => client.close()); await client.connect(transport);
  assert.equal((await client.listTools()).tools[0].name, "fixture_echo");
  assert.equal((await client.callTool({ name: "fixture_echo", arguments: { text: "actual MCP call" } })).content[0].text, "actual MCP call");
  assert.equal(service.calls, 1);
  await restarted.oauth.disconnect(c.id);
  await assert.rejects(client.listTools(), error => error.code === 401);
});

test("custom OAuth handles Paladira-shaped path discovery, dynamic registration and callbacks without optional issuer parameters", async t => {
  // Matches public discovery metadata fetched from paladira.com on 2026-09-15;
  // authentication and tokens below are entirely local fixtures, not a live grant.
  const service = await startMcpFixture({ mcpPath: "/api/mcp", oauthPrefix: "/api/oauth", issuerParameter: false, anonymousInitialize: true });
  t.after(() => service.close());
  const records = new MemoryRecords(), mcps = new McpConnections(records);
  const connection = await mcps.save({ name: "paladira", companies: ["12-apps"], type: "http", url: `${service.origin}/api/mcp`, authMode: "oauth" });
  const flow = await mcps.oauth.begin(connection.id, "http://127.0.0.1:8787/oauth/mcp/callback");
  const authorization = new URL(flow.authorizationUrl);
  assert.equal(authorization.pathname, "/api/oauth/authorize");
  assert.equal(authorization.searchParams.get("resource"), `${service.origin}/api/mcp`);
  assert.equal(authorization.searchParams.get("scope"), "mcp:read mcp:write");
  assert.equal(authorization.searchParams.get("redirect_uri"), "http://127.0.0.1:8787/oauth/mcp/callback");
  assert.equal((await mcps.list())[0].oauthConnected, false, "discovery and registration must not imply account consent");
  const params = await consent(flow); assert.equal(params.has("iss"), false);
  const saved = await mcps.oauth.finish(params, cookies(flow));
  assert.equal(saved.oauthConnected, true);
  assert.equal((await new McpConnections(records).test(connection.id)).health.status, "connected");
  assert.equal(service.exchanges, 1); assert.equal(service.calls, 0);
});

test("OAuth callback rejects missing browser cookie, replay, issuer mix-up, stale revision and cancellation", async t => {
  const { mcps, c, service } = await fixture(t);
  const begin = () => mcps.oauth.begin(c.id, "http://127.0.0.1:8787/oauth/mcp/callback");
  const flow = await begin(), params = await consent(flow);
  await assert.rejects(mcps.oauth.finish(params, {}), /Invalid or expired/);
  const mixed = new URLSearchParams(params); mixed.set("iss", "https://attacker.example");
  await assert.rejects(mcps.oauth.finish(mixed, cookies(flow)), /issuer mismatch/); assert.equal(service.exchanges, 0);
  await assert.rejects(mcps.oauth.finish(params, cookies(flow)), /Invalid or expired/);
  const denied = await begin(); await assert.rejects(mcps.oauth.finish(new URLSearchParams({ state: denied.state, error: "access_denied" }), cookies(denied)), /declined/);
  const stale = await begin(); await mcps.save({ ...c, name: "changed" }, c.id);
  await assert.rejects(mcps.oauth.finish(await consent(stale), cookies(stale)), /changed|Invalid or expired/); assert.equal(service.exchanges, 0);
  service.pkce = false; await assert.rejects(begin(), /PKCE/);
});

test("OAuth refresh is single-flight and persistent; endpoint changes drop credentials and invalidate worker grants", async t => {
  const { mcps, c, records, service } = await fixture(t);
  const flow = await mcps.oauth.begin(c.id, "http://127.0.0.1:8787/oauth/mcp/callback"); await mcps.oauth.finish(await consent(flow), cookies(flow));
  const connection = await mcps.get(c.id); connection.oauth.expiresAt = 1; await records.put("mcp", c.id, connection);
  const headers = await Promise.all(Array.from({ length: 8 }, () => mcps.oauth.headers(connection)));
  assert.equal(service.refreshes, 1); assert.ok(headers.every(h => h.get("authorization") === "Bearer fixture-access-secret"));
  assert.ok((await records.get("mcp", c.id)).oauth.expiresAt > Date.now());
  const publicData = (await mcps.list())[0]; await mcps.save({ ...publicData, url: "https://different.example/mcp" }, c.id);
  assert.equal((await mcps.list())[0].oauthConnected, false); await assert.rejects(mcps.oauth.headers(connection), /Sign in/);
  const manual = await mcps.save({ name: "manual", type: "http", url: "https://one.example/mcp", headers: { Authorization: "Bearer secret" } });
  assert.equal((await mcps.save({ ...manual, url: "https://two.example/mcp" }, manual.id)).hasCredentials, false);
});

test("HTTP OAuth routes require authenticated same-origin initiation and a browser-bound callback", async t => {
  const service = await startMcpFixture(); t.after(() => service.close());
  const root = await temporaryDirectory(t), app = await createAgentWebServer({ config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "browser-secret" }) });
  await app.start(); t.after(() => app.stop());
  const origin = `http://127.0.0.1:${app.server.address().port}`, authorization = { Authorization: "Bearer browser-secret", "content-type": "application/json" };
  await (await app.resources.forOwner(null)).companies.save({ id: "acme", name: "Acme" });
  const c = (await (await fetch(`${origin}/api/mcps`, { method: "POST", headers: authorization, body: JSON.stringify({ name: "routes", companyId: "acme", type: "http", url: `${service.origin}/mcp`, authMode: "oauth" }) })).json()).connection;
  const start = `${origin}/api/mcps/${c.id}/oauth`;
  assert.equal((await fetch(start, { method: "POST" })).status, 401);
  assert.equal((await fetch(start, { method: "POST", headers: { ...authorization, Origin: "https://attacker.example" } })).status, 403);
  const response = await fetch(start, { method: "POST", headers: authorization }); assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie"); assert.match(cookie, /HttpOnly; SameSite=Lax/);
  const flow = await response.json(), params = await consent(flow);
  assert.equal((await fetch(`${origin}/oauth/mcp/callback?${params}`)).status, 400);
  const callback = await fetch(`${origin}/oauth/mcp/callback?${params}`, { headers: { Cookie: cookie.split(";")[0] } });
  assert.equal(callback.status, 200); assert.ok(!(await callback.text()).includes("fixture-access-secret"));
  assert.equal((await (await fetch(`${origin}/api/mcps`, { headers: authorization })).json()).connections[0].oauthConnected, true);
  const cancel = `${origin}/api/mcps/${c.id}/cancel-oauth`;
  assert.equal((await fetch(cancel, { method: "POST" })).status, 401);
  assert.equal((await fetch(cancel, { method: "POST", headers: { ...authorization, Origin: "https://attacker.example" } })).status, 403);
  assert.equal((await fetch(cancel, { method: "POST", headers: authorization })).status, 200);
  assert.equal((await (await fetch(`${origin}/api/mcps`, { headers: authorization })).json()).connections[0].oauthConnected, true, "cancel is not disconnect");
});

test("company connections reach both adapters without environment selection; stop revokes and resume rotates grants", async t => {
  const root = await temporaryDirectory(t), seen = [];
  const app = await createAgentWebServer({ config: testConfig(root), models: { creationSettings: async () => ({}), turnSettings: async () => ({}) },
    adapterFactory: ({ chat, executor }) => ({ start: async () => { seen.push({ agent: chat.agent, servers: executor.mcpServers }); }, send: async () => ({ text: "ready" }), stop: async () => {} }) });
  await app.start(); t.after(() => app.stop());
  const mcps = app.manager.mcps;
  for (const id of ["acme", "other"]) await (await app.resources.forOwner(null)).companies.save({ id, name: id });
  await app.records.put("connection", "github", { id: "github", companyId: "acme", token: "fixture-mcp-github-token", revision: 1 });
  app.manager.github.fetch = async () => { throw new Error("No real GitHub requests in this fixture"); };
  const included = await mcps.save({ name: "selected", companyId: "acme", type: "http", url: "https://included.example/mcp", headers: { Authorization: "Bearer upstream-secret" } });
  await mcps.save({ name: "not-selected", companyId: "other", type: "http", url: "https://excluded.example/mcp" });
  const environment = await app.manager.environments.save({ name: "Company MCPs", backend: "local", companies: ["acme"], allowUnassigned: true, mcpIds: [] });
  const selectedName = `relay_selected_${included.id.slice(4).replaceAll("-", "")}`;
  for (const agent of ["codex", "claude"]) {
    const chat = await app.manager.createChat({ agent, title: "MCP worker", environmentId: environment.id });
    await app.store.update(chat.id, { repositories: [{ id: 31, fullName: "acme/fixture", githubConnectionId: "github" }] });
    await app.manager.send(chat.id, "load tools"); const runtime = seen.at(-1);
    assert.equal(runtime.agent, agent); assert.deepEqual(Object.keys(runtime.servers), [selectedName, "relay_browser", "relay_github"]);
    const browserToken = runtime.servers.relay_browser.headers.Authorization.slice(7);
    assert.equal(app.manager.browsers.grants.validate(browserToken, "browser").chatId, chat.id);
    assert.ok(!JSON.stringify(runtime).includes("upstream-secret"));
    const token = runtime.servers[selectedName].headers.Authorization.slice(7); assert.ok(mcps.broker.validate(token, "mcp"));
    await app.manager.stop(chat.id); assert.equal(mcps.broker.validate(token, "mcp"), null);
    assert.equal(app.manager.browsers.grants.validate(browserToken, "browser"), null);
    await app.manager.send(chat.id, "restart tools"); assert.notEqual(seen.at(-1).servers[selectedName].headers.Authorization, runtime.servers[selectedName].headers.Authorization);
    await app.manager.stop(chat.id);
  }
});
