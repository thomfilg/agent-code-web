import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { McpConnections, codexMcpArgs } from "../src/mcp-connections.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { Environments } from "../src/environments.mjs";
import { waitFor } from "./helpers.mjs";

test("an MCP grant revoked during OAuth refresh never sends the refreshed credential upstream", async t => {
  const records = new MemoryRecords(); let release, calls = 0;
  const mcps = new McpConnections(records, { fetchImpl: async () => { calls++; return Response.json({}); } });
  const connection = await mcps.save({ name: "refreshing", allowUnassigned: true, type: "http", url: "https://tools.example/mcp" });
  const runtime = await mcps.runtime("a", [connection.id], "http://localhost");
  mcps.oauth.headers = () => new Promise(resolve => { release = () => resolve(new Headers({ Authorization: "Bearer refreshed-fixture-secret" })); });
  const server = http.createServer((req, res) => mcps.handle(req, res, new URL(req.url, "http://localhost")));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => { server.close(); server.closeAllConnections(); });
  const pending = fetch(`http://127.0.0.1:${server.address().port}/gateway/mcp/${connection.id}`, { headers: runtime.relay_refreshing.headers });
  await waitFor(() => release); mcps.restrictChat("a", []); release();
  const response = await pending; assert.equal(response.status, 401); await response.text(); assert.equal(calls, 0);
});

test("MCP organizations filter grants by primary repository and keep same-provider credentials separate", async t => {
  const records = new MemoryRecords(), received = [];
  const mcps = new McpConnections(records, { fetchImpl: async (_url, options) => { received.push(options.headers.get("authorization")); return Response.json({ ok: true }); } });
  const save = organization => mcps.save({ name: "linear", organization, allowUnassigned: !organization, type: "http", url: "https://mcp.linear.app/mcp", authMode: "oauth" });
  const future = await save(" 12-APPS "), g2i = await save("g2i"), shared = await save("");
  assert.equal(future.organization, "12-apps"); assert.equal(shared.organization, null);
  await assert.rejects(save("12-apps"), /already exists/);
  await assert.rejects(save("https://github.com/g2i"), /GitHub owner/);
  for (const c of [future, g2i, shared]) {
    const raw = await mcps.get(c.id);
    await records.put("mcp", c.id, { ...raw, oauth: { tokens: { access_token: `secret-for-${c.organization || "shared"}` }, expiresAt: null } });
  }
  const stdio = await mcps.save({ name: "local", organization: "g2i", type: "stdio", command: "node", args: ["g2i-only.mjs"] });
  const ids = [future.id, g2i.id, shared.id, stdio.id];
  const selected = await mcps.runtime("future", ids, "http://localhost", { repositories: [{ fullName: "12-Apps/future-pay" }, { fullName: "g2i/other" }], customGroupId: "g2i" });
  assert.equal(Object.keys(selected).length, 1);
  assert.deepEqual([...mcps.grants.get("future").keys()], [future.id]);
  assert.ok(!JSON.stringify(selected).includes("secret-for"));
  const other = await mcps.runtime("g2i", ids, "http://localhost", { repositories: [{ fullName: "g2i/project" }] });
  assert.equal(Object.keys(other).length, 2); assert.deepEqual([...mcps.grants.get("g2i").keys()], [g2i.id, stdio.id]);
  await mcps.runtime("personal", ids, "http://localhost", { customGroupId: "12-apps" });
  assert.deepEqual([...mcps.grants.get("personal").keys()], [shared.id]);
  await mcps.runtime("legacy", ids, "http://localhost", { source: "git@github.com:12-apps/future-pay.git" });
  assert.deepEqual([...mcps.grants.get("legacy").keys()], [future.id]);
  const server = http.createServer((req, res) => mcps.handle(req, res, new URL(req.url, "http://localhost")));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => { server.close(); server.closeAllConnections(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (id, auth) => { const response = await fetch(`${origin}/gateway/mcp/${id}`, { headers: auth }); await response.text(); return response.status; };
  const futureAuth = Object.values(selected).find(c => c.url.endsWith(future.id)).headers;
  const otherAuth = Object.values(other).find(c => c.url?.endsWith(g2i.id)).headers;
  assert.equal(await call(future.id, futureAuth), 200); assert.equal(await call(g2i.id, futureAuth), 401);
  assert.equal(await call(g2i.id, otherAuth), 200); assert.equal(await call(future.id, otherAuth), 401);
  assert.deepEqual(received, ["Bearer secret-for-12-apps", "Bearer secret-for-g2i"]);
  await mcps.oauth.disconnect(future.id);
  assert.equal(await call(future.id, futureAuth), 401); assert.equal(await call(g2i.id, otherAuth), 200);
  const updated = await mcps.save({ ...g2i, companies: ["12-apps"], name: "moved" }, g2i.id);
  assert.equal(updated.organization, "12-apps"); assert.equal(await call(g2i.id, otherAuth), 401);
});
test("saved MCP credentials stay masked, selections validate, revisions conflict and stdio has no secret env", async () => {
  const records = new MemoryRecords(), mcps = new McpConnections(records), envs = new Environments(records, "local", mcps);
  const connection = await mcps.save({ name: "tools", allowUnassigned: true, type: "http", url: "https://tools.example/mcp", headers: { Authorization: "Bearer protected" } });
  assert.equal(connection.headers, undefined); assert.equal(connection.hasCredentials, true); assert.ok(!JSON.stringify(await mcps.list()).includes("protected"));
  const environment = await envs.save({ name: "MCP env", backend: "local", allowUnassigned: true, mcpIds: [connection.id] });
  assert.deepEqual((await envs.runtime(environment.id)).mcpIds, [connection.id]);
  await assert.rejects(mcps.remove(connection.id), /environments/);
  await assert.rejects(mcps.save({ ...connection, name: "changed", revision: 0 }, connection.id), /changed/);
  await assert.rejects(mcps.validateSelection(["missing"]), /Choose/);
  await assert.rejects(mcps.save({ name: "stdio", type: "stdio", command: "npx", args: [], env: { SECRET: "secret" } }), /Protected credentials/);
  const runtime = await mcps.runtime("chat-a", [connection.id], "http://localhost:8787");
  assert.ok(!JSON.stringify(runtime).includes("protected")); assert.match(codexMcpArgs(runtime).join(" "), /http_headers/);
});
test("MCP gateway scopes capabilities, preserves protocol headers, blocks redirects and revokes on sleep", async t => {
  const records = new MemoryRecords(); let received, redirect = false;
  const mcps = new McpConnections(records, { fetchImpl: async (url, options) => { received = { url, headers: options.headers }; return redirect ? new Response(null, { status: 302, headers: { location: "https://evil.example" } }) : Response.json({ jsonrpc: "2.0", id: 1, result: {} }, { headers: { "mcp-session-id": "scoped-session" } }); } });
  const connection = await mcps.save({ name: "tools", allowUnassigned: true, type: "http", url: "https://tools.example/mcp", headers: { Authorization: "Bearer protected" } });
  const other = await mcps.save({ name: "other", type: "http", url: "https://other.example/mcp" });
  const runtime = await mcps.runtime("a", [connection.id], "http://localhost"), auth = runtime.relay_tools.headers.Authorization;
  const server = http.createServer(async (req, res) => { if (!await mcps.handle(req, res, new URL(req.url, "http://localhost"))) { res.statusCode = 404; res.end(); } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`, url = `${origin}/gateway/mcp/${connection.id}`;
  const response = await fetch(url, { method: "POST", body: "{}", headers: { Authorization: auth, "mcp-protocol-version": "2025-06-18" } });
  assert.equal(response.status, 200); assert.equal(response.headers.get("mcp-session-id"), "scoped-session"); await response.text();
  assert.equal(received.headers.get("authorization"), "Bearer protected"); assert.equal(received.headers.get("mcp-protocol-version"), "2025-06-18");
  const second = await mcps.runtime("b", [connection.id], "http://localhost");
  assert.equal((await fetch(url, { headers: { Authorization: second.relay_tools.headers.Authorization, "mcp-session-id": "scoped-session" } })).status, 403);
  assert.equal((await fetch(`${origin}/gateway/mcp/${other.id}`, { headers: { Authorization: auth } })).status, 401);
  redirect = true; assert.equal((await fetch(url, { headers: { Authorization: auth } })).status, 502);
  mcps.revokeChat("a"); assert.equal((await fetch(url, { headers: { Authorization: auth } })).status, 401);
});

test("Codex pre-approves only the relay browser tools, so Auto mode can use them", () => {
  const args = codexMcpArgs({
    relay_browser: { type: "http", url: "https://relay.test/gateway/browser", headers: {}, bearerTokenEnvVar: "RELAY_MCP_CAPABILITY_0" },
    company_tool: { type: "http", url: "https://relay.test/gateway/mcp/x", headers: {} },
  }).join(" ");
  assert.match(args, /mcp_servers\.relay_browser\.default_tools_approval_mode="approve"/);
  assert.match(args, /mcp_servers\.relay_browser\.tool_timeout_sec=120/);
  assert.doesNotMatch(args, /company_tool\.default_tools_approval_mode/);
});
