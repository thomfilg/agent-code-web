import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { capabilityMcpServers, codexShellEnvironmentArgs, runtimeMcpSecrets } from "../src/worker-capabilities.mjs";
import { codexMcpArgs } from "../src/mcp-connections.mjs";
import { buildWorkerEnvironment } from "../src/worker-process.mjs";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { ChatStore } from "../src/store.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

const capability = "cap_" + "s".repeat(43), secrets = new Set([capability]);
const server = { type: "http", url: "https://relay.example/gateway/github/mcp", headers: { Authorization: `Bearer ${capability}` } };
const variables = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "http.https://relay.example/.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${capability}`, GIT_CONFIG_KEY_1: "credential.helper", GIT_CONFIG_VALUE_1: "", PUBLIC_VALUE: "visible" };
const browserCap = `cap_${"b".repeat(43)}`, mcpCap = `cap_${"m".repeat(43)}`;
const allServers = { relay_github: server,
  relay_browser: { ...server, url: "https://relay.example/gateway/browser", headers: { Authorization: `Bearer ${browserCap}` } },
  relay_linear: { ...server, url: "https://relay.example/gateway/mcp/mcp_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", headers: { Authorization: `Bearer ${mcpCap}` } },
};

test("only controller-minted gateway headers join the capability set; every aggregated native config uses env refs", () => {
  const collected = runtimeMcpSecrets({ ...allServers, upstream: { ...server, url: "https://upstream.example/mcp", headers: { Authorization: "Bearer provider-private-value" } },
    wrongOrigin: { ...server, url: "https://other.example/gateway/browser", headers: { Authorization: `Bearer cap_${"x".repeat(43)}` } } }, "https://relay.example");
  assert.deepEqual([...collected], [capability, browserCap, mcpCap]);
  for (const provider of ["codex", "claude"]) {
    const env = {}, configs = capabilityMcpServers(allServers, collected, env, provider);
    for (const token of collected) { assert.ok(!JSON.stringify(configs).includes(token)); assert.ok(Object.values(env).includes(token)); }
  }
});

test("MCP capability references preserve input and never serialize the bearer into native argv", () => {
  for (const provider of ["codex", "claude"]) {
    const env = {}, result = capabilityMcpServers({ relay_github: server }, secrets, env, provider);
    assert.equal(env.RELAY_MCP_CAPABILITY_0, capability);
    assert.equal(server.headers.Authorization, `Bearer ${capability}`);
    assert.ok(!JSON.stringify(provider === "codex" ? codexMcpArgs(result) : result).includes(capability));
    if (provider === "codex") assert.equal(result.relay_github.bearerTokenEnvVar, "RELAY_MCP_CAPABILITY_0");
    else assert.equal(result.relay_github.headers.Authorization, "Bearer ${RELAY_MCP_CAPABILITY_0}");
  }
});

test("Codex shell inherits only explicit sanitized names, preserving Git KEY entries without provider secrets or argv values", async () => {
  const env = await buildWorkerEnvironment({ chat: { id: "fixture" }, runtimeHome: "/private/fixture", provider: "openai", authMode: "gateway", capability: "provider-cap", gatewayOrigin: "http://localhost", ensureDirectory: async () => {}, environmentVariables: variables });
  capabilityMcpServers({ relay_github: server }, secrets, env, "codex");
  const args = codexShellEnvironmentArgs(env, variables, secrets), joined = args.join("\n");
  assert.ok(!joined.includes(capability)); assert.ok(!joined.includes("provider-cap")); assert.ok(!joined.includes("Authorization:")); assert.ok(!joined.includes("policy.set"));
  const names = JSON.parse(args.find(value => value.startsWith("shell_environment_policy.include_only=")).split("=").slice(1).join("="));
  for (const name of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "PUBLIC_VALUE", "HOME", "PATH"]) assert.ok(names.includes(name));
  for (const name of ["AGENT_SESSION_TOKEN", "AGENT_GATEWAY_ORIGIN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "RELAY_MCP_CAPABILITY_0"]) assert.ok(!names.includes(name));
  assert.ok(args.includes('shell_environment_policy.inherit="all"'));
  assert.ok(args.includes("shell_environment_policy.ignore_default_excludes=true"));
});

test("no-capability workers retain existing Codex environment policy", () => {
  const args = codexShellEnvironmentArgs({}, { PUBLIC_VALUE: "value" });
  assert.ok(args.includes('shell_environment_policy.inherit="core"'));
  assert.ok(args.includes('shell_environment_policy.set.PUBLIC_VALUE="value"'));
});

async function adapterFixture(t, provider) {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const chat = await store.create({ agent: provider, title: "Git capability" });
  await mkdir(`${chat.workspace}/.git`, { recursive: true });
  const canonical = '[remote "origin"]\n  url = https://github.com/company/project.git\n';
  await writeFile(`${chat.workspace}/.git/config`, canonical);
  const starts = [], events = [], requests = [], config = testConfig(root, { CODEX_BIN: path.resolve("test/fixtures/fake-codex.mjs"), CLAUDE_BIN: path.resolve("test/fixtures/fake-claude-secret.mjs") });
  const launch = (kind, command, args, options) => {
      for (const token of [capability, browserCap, mcpCap]) assert.ok(!JSON.stringify(args).includes(token));
      assert.ok(!JSON.stringify([args, options.env]).includes(config.codex.providerKey));
      assert.ok(!JSON.stringify([args, options.env]).includes(config.claude.providerKey));
      starts.push({ kind, args, env: options.env });
      if (kind === "ordinary" && args[0] === "plugin") {
        return spawn(process.execPath, ["-e", "process.stdout.write(JSON.stringify({installed:[],available:[]}))"], options);
      }
      return spawn(command, args, options);
  };
  const executor = { workspace: chat.workspace, runtimeHome: store.runtimeHome(chat.id), environmentVariables: variables, capabilitySecrets: runtimeMcpSecrets(allServers, "https://relay.example"),
    mcpServers: allServers, mkdir: directory => mkdir(directory, { recursive: true }),
    spawn: (command, args, options) => launch("ordinary", command, args, options),
    spawnAgent: (command, args, options) => launch("agent", command, args, options),
  };
  const adapter = new (provider === "codex" ? CodexAdapter : ClaudeAdapter)({ chat, store, config, executor, broker: new CapabilityBroker({ ttlMs: 10000 }), gatewayOrigin: "http://localhost",
    hooks: { onEvent: value => events.push(value), onRequest: value => requests.push(value), onLog: value => events.push({ log: value }) } });
  t.after(() => adapter.stop()); await adapter.start();
  return { adapter, chat, canonical, starts, events, requests };
}

test("Claude gateway-mode subprocess protects capability across every delta split/tools/debug without persisting Git config", async t => {
  const f = await adapterFixture(t, "claude"), result = await f.adapter.send("all-capabilities");
  assert.equal(result.text, "[redacted] ".repeat(3 * (capability.length - 1)));
  for (const token of [capability, browserCap, mcpCap]) assert.ok(!JSON.stringify([result, f.events, f.requests]).includes(token));
  assert.equal(f.starts.at(-1).env.RELAY_MCP_CAPABILITY_0, capability);
  assert.equal(f.starts.at(-1).kind, "agent", "interactive Claude owner must use the reconnectable agent path");
  assert.equal(f.starts.at(-1).env.GIT_CONFIG_VALUE_0, `Authorization: Bearer ${capability}`);
  assert.equal(await readFile(`${f.chat.workspace}/.git/config`, "utf8"), f.canonical);
});

test("Codex gateway-mode RPC protects capability across every split, tool fields and side agents without argv or Git persistence", async t => {
  const f = await adapterFixture(t, "codex"), running = f.adapter.send("fixture", { mode: "accept_edits" }); await waitFor(() => f.requests.length);
  const params = { threadId: f.adapter.threadId, turnId: f.adapter.current.turnId }, notifications = [];
  for (const token of [capability, browserCap, mcpCap]) for (let split = 1; split < token.length; split++) for (const delta of [token.slice(0, split), token.slice(split) + " "]) notifications.push({ method: "item/agentMessage/delta", params: { ...params, delta } });
  notifications.push({ method: "item/completed", params: { ...params, item: { type: "commandExecution", id: "tool", command: capability, aggregatedOutput: capability } } });
  notifications.push({ method: "turn/completed", params: { ...params, turn: { id: params.turnId, status: "completed" } } });
  await f.adapter.rpc.request("fixture/notifications", { notifications, complete: true }); const result = await running;
  assert.equal(result.text, "[redacted] ".repeat(3 * (capability.length - 1)));
  for (const token of [capability, browserCap, mcpCap]) assert.ok(!JSON.stringify([result, f.events, f.requests]).includes(token));
  const side = await f.adapter.forkSide({}); assert.equal(side.credentialSecrets, f.adapter.credentialSecrets); await side.stop();
  assert.equal(f.starts[0].kind, "agent", "Codex app-server must use the reconnectable agent path");
  assert.deepEqual(await f.adapter.pluginCli.run(["list", "--available", "--json"]), { installed: [], available: [] });
  assert.equal(f.starts.at(-1).kind, "ordinary", "transient Codex plugin commands must not occupy the retained native-agent slot");
  assert.equal(f.starts[0].env.RELAY_MCP_CAPABILITY_0, capability);
  assert.equal(await readFile(`${f.chat.workspace}/.git/config`, "utf8"), f.canonical);
});
