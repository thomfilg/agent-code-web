import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import assert from "node:assert/strict";
import { startMcpFixture } from "../test/fixtures/mcp-server.mjs";
import { McpConnections, codexMcpArgs } from "../src/mcp-connections.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { JsonRpcProcess } from "../src/json-rpc-process.mjs";
import { spawnWorker, terminateWorker } from "../src/worker-process.mjs";
import http from "node:http";
import { fileURLToPath } from "node:url";

// No model calls, account credentials, user config writes, or real tool actions.
const root = await mkdtemp("/tmp/relay-real-mcps-");
const service = await startMcpFixture({ requireAuth: false });
const mcps = new McpConnections(new MemoryRecords());
const connection = await mcps.save({ name: "smoke", type: "http", url: `${service.origin}/mcp`, authMode: "none" });
const stdio = await mcps.save({ name: "stdio", type: "stdio", command: process.execPath, args: [fileURLToPath(new URL("../test/fixtures/mcp-stdio.mjs", import.meta.url))] });
const gateway = http.createServer((req, res) => mcps.handle(req, res, new URL(req.url, "http://localhost")));
await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
const servers = await mcps.runtime("smoke", [connection.id, stdio.id], `http://127.0.0.1:${gateway.address().port}`);
let rpc, child;
try {
  await mkdir(path.join(root, "codex")); await mkdir(path.join(root, "claude"));
  const env = { HOME: root, PATH: process.env.PATH, LANG: "C.UTF-8", CODEX_HOME: path.join(root, "codex"), CLAUDE_CONFIG_DIR: path.join(root, "claude") };
  rpc = new JsonRpcProcess({ command: "codex", args: ["app-server", ...codexMcpArgs(servers)], spawnOptions: { cwd: root, env }, isolation: "none", requestTimeoutMs: 20000 }); rpc.on("error", () => {});
  rpc.start(); await rpc.request("initialize", { clientInfo: { name: "relay_mcp_smoke", version: "1" }, capabilities: { experimentalApi: true } }); rpc.notify("initialized", {});
  await rpc.request("thread/start", { cwd: root, approvalPolicy: "never" });
  const status = await rpc.request("mcpServerStatus/list", { limit: 100 });
  const server = status.data.find(item => item.name === "relay_smoke");
  assert.ok(Object.keys(server?.tools || {}).some(name => name.includes("fixture_echo")), "Codex did not discover the selected MCP tool");
  assert.ok(Object.keys(status.data.find(s => s.name === "relay_stdio")?.tools || {}).some(name => name.includes("stdio_echo")), "Codex did not discover the selected stdio MCP");
  console.log("Real Codex: selected HTTP and stdio MCP tools discovered"); await rpc.stop(); rpc = null;

  child = spawnWorker("claude", ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: servers })], { cwd: root, env, isolation: "none", stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume(); const lines = readline.createInterface({ input: child.stdout }); const pending = new Map();
  lines.on("line", line => { try { const value = JSON.parse(line); const id = value.request_id || value.response?.request_id; if (value.type === "control_response" && pending.has(id)) pending.get(id)(value.response); } catch {} });
  const request = (id, subtype) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Claude ${subtype} timed out`)); }, 25000);
    pending.set(id, response => { clearTimeout(timer); pending.delete(id); response.subtype === "error" ? reject(new Error(response.error)) : resolve(response.response); });
    child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: id, request: { subtype } })}\n`);
  });
  await request("init", "initialize");
  let selected, selectedStdio;
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await request(`mcp-status-${attempt}`, "mcp_status");
    selected = result.mcpServers?.find(item => item.name === "relay_smoke");
    selectedStdio = result.mcpServers?.find(item => item.name === "relay_stdio");
    if (selected?.status === "connected" && selectedStdio?.status === "connected" || selected?.status === "failed" || selectedStdio?.status === "failed") break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(selected?.status, "connected", "Claude did not connect to the selected MCP");
  assert.equal(selectedStdio?.status, "connected", "Claude did not connect to the selected stdio MCP");
  console.log("Real Claude: selected HTTP and stdio MCPs connected");
  lines.close();
} finally {
  await rpc?.stop(); if (child) await terminateWorker(child);
  mcps.revokeChat("smoke"); gateway.close(); gateway.closeAllConnections(); await service.close(); await rm(root, { recursive: true, force: true });
}
