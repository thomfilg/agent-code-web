import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startMcpFixture } from "../test/fixtures/mcp-server.mjs";
import { McpConnections, codexMcpArgs } from "../src/mcp-connections.mjs";
import { oauthCookieName } from "../src/mcp-oauth.mjs";
import { Companies } from "../src/companies.mjs";
import { Environments } from "../src/environments.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { JsonRpcProcess } from "../src/json-rpc-process.mjs";
import { spawnWorker, terminateWorker } from "../src/worker-process.mjs";
import { capabilityMcpServers, runtimeMcpSecrets } from "../src/worker-capabilities.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { SharedBrowsers } from "../src/shared-browser.mjs";

// Actual installed CLIs, with no model requests or real account credentials.
// A loopback-only network namespace prevents accidental provider requests.
const exec = promisify(execFile);
if (!process.argv.includes("--network-isolated")) {
  const result = await exec("/usr/bin/unshare", ["--user", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL", "--", process.execPath, process.argv[1], "--network-isolated"], { timeout: 120000, maxBuffer: 40000 });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  assert.match(result.stdout, /^PASS:/m);
} else {
  await exec("/usr/bin/ip", ["link", "set", "lo", "up"]);
  assert.deepEqual(JSON.parse((await exec("/usr/bin/ip", ["-j", "link", "show"])).stdout).map(item => item.ifname), ["lo"]);
  assert.equal((await exec("/usr/bin/ip", ["route", "show"])).stdout.trim(), "");
  await run();
}

async function run() {
  const root = await mkdtemp("/tmp/relay-real-mcps-"), fixtures = new Map();
  const records = new MemoryRecords(), companies = new Companies(records);
  let authorizing, rpc, child, gateway, browsers, mcps;
  try {
    for (const companyId of ["acme", "other"]) {
      await companies.save({ id: companyId, name: companyId });
      fixtures.set(companyId, await startMcpFixture({ advertisedOrigin: "https://mcp.linear.app", linear: true, workspace: companyId, accessToken: `fixture-access-${companyId}`, refreshToken: `fixture-refresh-${companyId}` }));
    }
    mcps = new McpConnections(records, { companies, fetchImpl: (url, init = {}) => {
      const parsed = new URL(url), authorization = new Headers(init.headers).get("authorization");
      assert.equal(parsed.origin, "https://mcp.linear.app");
      const companyId = authorization?.startsWith("Bearer fixture-access-") ? authorization.slice("Bearer fixture-access-".length) : authorizing;
      assert.ok(fixtures.has(companyId), "Unknown upstream token must never fall back to another workspace");
      return fetch(new URL(parsed.pathname + parsed.search, fixtures.get(companyId).origin), init);
    } });
    const connections = new Map();
    for (const companyId of fixtures.keys()) {
      authorizing = companyId;
      const connection = await mcps.save({ name: "linear", companyId, type: "http", url: "https://mcp.linear.app/mcp", authMode: "oauth" });
      const flow = await mcps.oauth.begin(connection.id, "http://localhost:8787/oauth/mcp/callback");
      const consent = new URL(flow.authorizationUrl); consent.pathname = "/approve";
      const approved = await fetch(new URL(consent.pathname + consent.search, fixtures.get(companyId).origin), { redirect: "manual" });
      assert.equal(approved.status, 302);
      await mcps.oauth.finish(new URL(approved.headers.get("location")).searchParams, { [oauthCookieName(flow.state)]: flow.cookie });
      assert.match(mcps.oauth.status(connection.id).message, /company's chats/);
      assert.doesNotMatch(mcps.oauth.status(connection.id).message, /selecting.*environment/);
      assert.equal((await mcps.test(connection.id)).health.workspaceRead?.tool, "list_teams");
      connections.set(companyId, connection);
    }
    const stdio = await mcps.save({ name: "stdio", companyId: "acme", type: "stdio", command: process.execPath, args: [fileURLToPath(new URL("../test/fixtures/mcp-stdio.mjs", import.meta.url))] });
    const environments = new Environments(records, "local", mcps);
    const environment = await environments.save({ name: "Acme", companies: ["acme"], backend: "local", mcpIds: [] });
    const chat = { id: "smoke", repositories: [{ companyId: "acme", fullName: "unrelated-github-owner/app" }] };
    const selection = await environments.runtime(environment.id, chat);
    assert.deepEqual(new Set(selection.mcpIds), new Set([connections.get("acme").id, stdio.id]));
    browsers = new SharedBrowsers({ store: { get: id => id === chat.id ? chat : null }, config: { sessionCapabilityTtlMs: 60000 }, acquire: async () => { throw new Error("Discovery must not start Chrome"); } });
    gateway = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (!await mcps.handle(req, res, url) && !await browsers.handle(req, res, url)) { res.writeHead(404); res.end(); }
    });
    await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${gateway.address().port}`;
    for (const provider of ["codex", "claude"]) {
      // The runtime must independently filter an injected foreign ID before
      // minting credentials, even though selection already excludes it.
      const servers = { ...await mcps.runtime(chat.id, [...selection.mcpIds, connections.get("other").id], origin, chat), ...browsers.runtime(chat.id, origin) };
      const linearName = Object.keys(servers).find(name => name.startsWith("relay_linear_")), stdioName = Object.keys(servers).find(name => name.startsWith("relay_stdio_"));
      assert.equal(Object.keys(servers).length, 3);
      const linear = servers[linearName];
      assert.equal(linear.url, `${origin}/gateway/mcp/${connections.get("acme").id}`);
      assert.doesNotMatch(JSON.stringify(servers), /fixture-access-|fixture-refresh-/);
      const foreign = await fetch(`${origin}/gateway/mcp/${connections.get("other").id}`, { method: "POST", headers: linear.headers, body: "{}" });
      assert.equal(foreign.status, 401); await foreign.text();
      await mkdir(path.join(root, provider));
      const env = { HOME: root, PATH: process.env.PATH, LANG: "C.UTF-8", CODEX_HOME: path.join(root, "codex"), CLAUDE_CONFIG_DIR: path.join(root, "claude") };
      const secrets = runtimeMcpSecrets(servers, origin), native = capabilityMcpServers(servers, secrets, env, provider);
      for (const secret of secrets) assert.ok(!JSON.stringify(native).includes(secret), "Capability must remain out of argv");
      assert.doesNotMatch(JSON.stringify(env), /fixture-access-|fixture-refresh-/);
      if (provider === "codex") {
        rpc = new JsonRpcProcess({ command: "codex", args: ["app-server", ...codexMcpArgs(native)], spawnOptions: { cwd: root, env }, isolation: "none", requestTimeoutMs: 20000 }); rpc.on("error", () => {});
        rpc.start(); await rpc.request("initialize", { clientInfo: { name: "relay_mcp_smoke", version: "1" }, capabilities: { experimentalApi: true } }); rpc.notify("initialized", {});
        await rpc.request("thread/start", { cwd: root, approvalPolicy: "never" });
        const status = await rpc.request("mcpServerStatus/list", { limit: 100 });
        for (const [name, tool] of [[linearName, "list_teams"], [stdioName, "stdio_echo"], ["relay_browser", "browser_navigate"]]) assert.ok(Object.keys(status.data.find(item => item.name === name)?.tools || {}).some(key => key.includes(tool)), `Codex did not discover ${tool}`);
        await rpc.stop(); rpc = null;
      } else {
        child = spawnWorker("claude", ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: native })], { cwd: root, env, isolation: "none", stdio: ["pipe", "pipe", "pipe"] });
        child.stderr.resume(); const lines = readline.createInterface({ input: child.stdout }), pending = new Map();
        lines.on("line", line => { try { const value = JSON.parse(line), id = value.request_id || value.response?.request_id; if (value.type === "control_response" && pending.has(id)) pending.get(id)(value.response); } catch {} });
        const request = (id, subtype) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Claude ${subtype} timed out`)); }, 25000);
          pending.set(id, response => { clearTimeout(timer); pending.delete(id); response.subtype === "error" ? reject(new Error(response.error)) : resolve(response.response); });
          child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: id, request: { subtype } })}\n`);
        });
        try {
          await request("init", "initialize");
          let selected = [];
          for (let attempt = 0; attempt < 40; attempt++) {
            const result = await request(`mcp-status-${attempt}`, "mcp_status");
            selected = [linearName, stdioName, "relay_browser"].map(name => result.mcpServers?.find(item => item.name === name));
            if (selected.every(item => item?.status === "connected") || selected.some(item => item?.status === "failed")) break;
            await new Promise(resolve => setTimeout(resolve, 250));
          }
          for (const server of selected) assert.equal(server?.status, "connected", "Claude did not connect to every company-selected MCP");
        } finally { lines.close(); await terminateWorker(child); child = null; }
      }
      // Same capability as the native CLI, but a deterministic SDK call, not
      // model inference. Do not count this as native CLI tool execution.
      const client = new Client({ name: "relay-no-model-workspace-read", version: "1" });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(linear.url), { requestInit: { headers: linear.headers } }));
        const result = await client.callTool({ name: "list_teams", arguments: { limit: 1 } });
        assert.equal(result.isError, undefined); assert.equal(JSON.parse(result.content[0].text).teams[0].id, "acme");
      } finally { await client.close(); }
      mcps.revokeChat(chat.id);
      const revoked = await fetch(linear.url, { method: "POST", headers: linear.headers, body: "{}" });
      assert.equal(revoked.status, 401); await revoked.text();
      console.log(`Real ${provider}: company OAuth MCP discovery, private capability environment, scoped gateway read and revocation verified`);
    }
    assert.equal(fixtures.get("other").calls, 1, "Foreign workspace receives only its explicit connection verification");
    console.log("PASS: real Codex/Claude company MCP, stdio and browser discovery; fixture OAuth and SDK gateway reads only, no model or external network.");
  } finally {
    await rpc?.stop(); if (child) await terminateWorker(child);
    mcps?.revokeChat("smoke"); await browsers?.shutdown(); gateway?.close(); gateway?.closeAllConnections();
    for (const fixture of fixtures.values()) await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
}
