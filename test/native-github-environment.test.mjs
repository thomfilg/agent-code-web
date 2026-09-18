// Opt-in local native protocol check: no user turn, model, real account, AWS,
// GitHub network or imported profile. Loopback MCP has synthetic capabilities.
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import readline from "node:readline";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { capabilityMcpServers, codexShellEnvironmentArgs, runtimeMcpSecrets } from "../src/worker-capabilities.mjs";
import { codexMcpArgs } from "../src/mcp-connections.mjs";
import { JsonRpcProcess } from "../src/json-rpc-process.mjs";
import { ClaudeControlChannel } from "../src/claude-mcp.mjs";
import { buildWorkerEnvironment, terminateWorker } from "../src/worker-process.mjs";
import { githubWorkerMcpConfig, handleGitHubWorkerMcp } from "../src/github-worker-mcp.mjs";
import { temporaryDirectory, waitFor } from "./helpers.mjs";

const enabled = process.env.AGENT_TEST_NATIVE_GITHUB === "1";
async function fixture(t, provider) {
  const root = await temporaryDirectory(t, "relay-native-github-env-"), capability = `cap_${randomBytes(32).toString("base64url")}`;
  const tokens = [capability, `cap_${randomBytes(32).toString("base64url")}`, `cap_${randomBytes(32).toString("base64url")}`];
  const authenticated = new Set(); let providerRequests = 0;
  const gateway = { listRepositories: async token => { assert.ok(tokens.includes(token)); authenticated.add(token); return [{ id: 1, fullName: "fixture/repo" }]; } };
  const server = http.createServer((req, res) => {
    if (!["/gateway/github/mcp", "/gateway/browser", "/gateway/mcp/mcp_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"].includes(req.url)) { providerRequests++; res.writeHead(404); res.end(); return; }
    req.url = "/gateway/github/mcp"; // All three local fixture tools share one no-write handler.
    void handleGitHubWorkerMcp(req, res, new URL(req.url, "http://localhost"), { gateway }).catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`, variables = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: `http.${origin}/.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Bearer ${capability}`, GIT_CONFIG_KEY_1: "credential.helper", GIT_CONFIG_VALUE_1: "" };
  const env = await buildWorkerEnvironment({ chat: { id: "fixture" }, runtimeHome: `${root}/home`, provider: provider === "codex" ? "openai" : "anthropic", authMode: "gateway", capability: "synthetic-provider-unused", gatewayOrigin: origin, environmentVariables: variables });
  Object.assign(env, { HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" });
  await mkdir(env.CODEX_HOME || env.CLAUDE_CONFIG_DIR, { recursive: true });
  await mkdir(`${root}/work/.git`, { recursive: true });
  const canonical = '[remote "origin"]\n  url = https://github.com/fixture/repo.git\n';
  await writeFile(`${root}/work/.git/config`, canonical);
  const configs = { ...githubWorkerMcpConfig(origin, capability),
    relay_browser: { type: "http", url: `${origin}/gateway/browser`, headers: { Authorization: `Bearer ${tokens[1]}` } },
    relay_linear: { type: "http", url: `${origin}/gateway/mcp/mcp_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`, headers: { Authorization: `Bearer ${tokens[2]}` } } };
  const secrets = runtimeMcpSecrets(configs, origin), servers = capabilityMcpServers(configs, secrets, env, provider);
  return { root, env, origin, servers, secrets, variables, capability, tokens, authenticated: () => authenticated.size,
    async verifyDisk() {
      assert.equal(await readFile(`${root}/work/.git/config`, "utf8"), canonical); assert.equal(providerRequests, 0);
      for (const file of [`${root}/home/.claude.json`, `${root}/home/claude/.claude.json`, `${root}/home/claude/settings.json`, `${root}/home/codex/config.toml`, `${root}/work/.mcp.json`, `${root}/work/.claude/settings.local.json`]) {
        const content = await readFile(file, "utf8").catch(error => { if (error.code !== "ENOENT") throw error; return ""; });
        for (const token of tokens) assert.ok(!content.includes(token), "Native settings must never persist a capability");
      }
    } };
}

test("native Codex resolves MCP bearer env and shell Git config without argv/disk capability", { skip: !enabled, timeout: 60000 }, async t => {
  const f = await fixture(t, "codex");
  const args = ["app-server", "-c", 'cli_auth_credentials_store="ephemeral"', ...codexMcpArgs(f.servers), ...codexShellEnvironmentArgs(f.env, f.variables, f.secrets)];
  for (const token of f.tokens) assert.ok(!JSON.stringify(args).includes(token));
  const rpc = new JsonRpcProcess({ command: "codex", args, spawnOptions: { cwd: `${f.root}/work`, env: f.env }, requestTimeoutMs: 20000 });
  rpc.on("error", () => {}); rpc.on("protocolError", () => {});
  t.after(() => rpc.stop()); rpc.start();
  await rpc.request("initialize", { clientInfo: { name: "relay_github_env_test", version: "1.0.0" }, capabilities: { experimentalApi: true } }); rpc.notify("initialized", {});
  const inspect = 'const e=process.env;process.stdout.write(JSON.stringify({key:e.GIT_CONFIG_KEY_0?.startsWith("http.http://127.0.0.1:"),value:e.GIT_CONFIG_VALUE_0?.startsWith("Authorization: Bearer cap_"),count:e.GIT_CONFIG_COUNT==="2",providerAbsent:!e.AGENT_SESSION_TOKEN,mcpCopyAbsent:!e.RELAY_MCP_CAPABILITY_0}))';
  const result = await rpc.request("command/exec", { command: [process.execPath, "-e", inspect], cwd: `${f.root}/work`, sandboxPolicy: { type: "dangerFullAccess" } });
  assert.equal(result.exitCode, 0); assert.deepEqual(JSON.parse(result.stdout), { key: true, value: true, count: true, providerAbsent: true, mcpCopyAbsent: true });
  const status = await rpc.request("mcpServerStatus/list", { limit: 20 });
  for (const name of ["relay_github", "relay_browser", "relay_linear"]) assert.ok(status.data.some(entry => entry.name === name && Object.keys(entry.tools || {}).length === 2));
  assert.equal(f.authenticated(), 3);
  const argv = await readFile(`/proc/${rpc.child.pid}/cmdline`); for (const token of f.tokens) assert.ok(!argv.includes(Buffer.from(token)));
  await rpc.stop(); await f.verifyDisk();
});

test("native Claude resolves ephemeral MCP env header without argv or Git config persistence", { skip: !enabled, timeout: 60000 }, async t => {
  const f = await fixture(t, "claude");
  const args = ["--print", "--verbose", "--output-format", "stream-json", "--input-format", "stream-json", "--tools", "", "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: f.servers }), "--settings", '{"disableAllHooks":true}'];
  for (const token of f.tokens) assert.ok(!JSON.stringify(args).includes(token));
  const child = spawn("claude", args, { cwd: `${f.root}/work`, env: f.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  child.stderr.resume();
  const channel = new ClaudeControlChannel(child, 20000), lines = readline.createInterface({ input: child.stdout });
  lines.on("line", line => { try { channel.accept(JSON.parse(line)); } catch {} });
  t.after(async () => { channel.close(); lines.close(); await terminateWorker(child); });
  await channel.request("initialize");
  await waitFor(async () => { const status = await channel.request("mcp_status"); return ["relay_github", "relay_browser", "relay_linear"].every(name => status.mcpServers?.some(entry => entry.name === name && entry.status === "connected")); }, { timeoutMs: 20000, intervalMs: 200 });
  assert.equal(f.authenticated(), 3);
  const argv = await readFile(`/proc/${child.pid}/cmdline`); for (const token of f.tokens) assert.ok(!argv.includes(Buffer.from(token)));
  channel.close(); await terminateWorker(child); await f.verifyDisk();
});
