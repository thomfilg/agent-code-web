import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, writeFile, readFile, symlink, link } from "node:fs/promises";
import { claudeMcpRequest, ClaudeControlChannel, runClaudeMcpCommand } from "../src/claude-mcp.mjs";
import { readPrivateClaudeSettings, inspectClaudeSettings } from "../src/claude-settings.mjs";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { spawnWorker } from "../src/worker-process.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

test("MCP action parsing preserves exact server names and leaves native status/help/invalid commands alone", () => {
  assert.equal(claudeMcpRequest("Explain /mcp disable all"), null);
  assert.equal(claudeMcpRequest("/mcp-extra disable"), null);
  for (const text of ["/mcp", "/mcp status", "/mcp --help", "/mcp invalid"]) assert.deepEqual(claudeMcpRequest(text), {});
  assert.deepEqual(claudeMcpRequest("/mcp DISABLE\nrelay_Exact"), { action: "disable", server: "relay_Exact" });
  assert.deepEqual(claudeMcpRequest("/mcp enable"), { action: "enable", server: "all" });
  assert.deepEqual(claudeMcpRequest(" /mcp reconnect claude.ai Name "), { action: "reconnect", server: "claude.ai Name" });
});

function controlFixture(t, timeout = 100) {
  const child = new EventEmitter(); child.stdin = new PassThrough();
  const writes = []; child.stdin.on("data", chunk => writes.push(JSON.parse(chunk)));
  const channel = new ClaudeControlChannel(child, timeout); t.after(() => { channel.close(); child.stdin.destroy(); });
  return { child, writes, channel };
}

test("native control replies correlate requests, discard unknown IDs and expose no error secrets", async t => {
  const { channel, writes } = controlFixture(t);
  const status = channel.request("mcp_status"), toggle = channel.request("mcp_toggle", { serverName: "relay_exact", enabled: false });
  assert.notEqual(writes[0].request_id, writes[1].request_id);
  assert.deepEqual(writes[1].request, { subtype: "mcp_toggle", serverName: "relay_exact", enabled: false });
  const rejected = assert.rejects(toggle, error => error.message === "Native MCP control failed");
  channel.accept({ type: "control_response", response: { subtype: "success", request_id: "foreign", response: {} } });
  channel.accept({ type: "control_response", response: { subtype: "error", request_id: writes[1].request_id, error: "https://private.example?token=secret Authorization: Bearer secret" } });
  channel.accept({ type: "control_response", request_id: writes[0].request_id, response: { subtype: "success", response: { mcpServers: [] } } });
  assert.deepEqual(await status, { mcpServers: [] }); await rejected; assert.equal(channel.pending.size, 0);
});

test("native control timeouts, closed workers and EPIPE reject pending work without late success", async t => {
  const first = controlFixture(t, 5);
  await assert.rejects(first.channel.request("initialize"), /timed out/); assert.equal(first.channel.pending.size, 0);
  for (const event of ["close", "error", "stdin"]) {
    const f = controlFixture(t), pending = f.channel.request("mcp_status"), rejected = assert.rejects(pending, /stopped/);
    if (event === "stdin") f.child.stdin.emit("error", Error("EPIPE")); else f.child.emit(event, Error("fixture"));
    await rejected; assert.equal(f.channel.pending.size, 0);
    f.channel.accept({ type: "control_response", response: { subtype: "success", request_id: f.writes[0].request_id } });
    await assert.rejects(f.channel.request("mcp_status"), /stopped/);
  }
});

function inventoryFixture(initial) {
  const f = { servers: initial.map(server => ({ ...server })), calls: [] };
  f.request = async (subtype, fields = {}) => {
    f.calls.push({ subtype, ...fields });
    if (subtype === "initialize") return {};
    if (subtype === "mcp_status") return { mcpServers: f.servers.map(server => ({ ...server, config: { secret: "never return" } })) };
    if (fields.serverName === f.errorServer) throw Error("Blocked by managed policy");
    if (!f.ignoreMutation) f.servers.find(server => server.name === fields.serverName).status = subtype === "mcp_toggle" && !fields.enabled ? "disabled" : "connected";
    return {};
  };
  return f;
}

test("native MCP actions honor explicit names, all, disabled/approval states and verify the resulting inventory", async () => {
  const f = inventoryFixture([{ name: "relay_one", status: "connected" }, { name: "relay_two", status: "connected" }, { name: "ide", status: "connected" }]);
  let result = await runClaudeMcpCommand(f, claudeMcpRequest("/mcp disable relay_one"));
  assert.equal(result.text, 'Disabled "relay_one".'); assert.equal(result.failed, false);
  assert.deepEqual(result.connectors, [{ name: "relay_one", status: "disabled" }, { name: "relay_two", status: "connected" }, { name: "ide", status: "connected" }]);
  const count = f.calls.filter(call => call.subtype === "mcp_toggle").length;
  result = await runClaudeMcpCommand(f, claudeMcpRequest("/mcp reconnect relay_one")); assert.match(result.text, /is disabled/);
  assert.equal(f.calls.filter(call => call.subtype === "mcp_toggle").length, count);
  result = await runClaudeMcpCommand(f, claudeMcpRequest("/mcp enable all")); assert.match(result.text, /Enabled "relay_one"/);
  result = await runClaudeMcpCommand(f, claudeMcpRequest("/mcp disable")); assert.equal(result.text, "Disabled 2 MCP server(s).");
  assert(!f.calls.some(call => call.serverName === "ide"));
  f.servers[0].status = "needs-approval";
  result = await runClaudeMcpCommand(f, claudeMcpRequest("/mcp enable relay_one")); assert.equal(result.failed, true); assert.match(result.text, /needs-approval/);
  result = await runClaudeMcpCommand(f, claudeMcpRequest("/mcp disable missing")); assert.match(result.text, /no MCP server named/);
});

test("MCP bulk partial errors and false acknowledgements cannot report verified success", async () => {
  const f = inventoryFixture([{ name: "relay_one", status: "disabled" }, { name: "relay_two", status: "disabled" }]); f.errorServer = "relay_two";
  let result = await runClaudeMcpCommand(f, claudeMcpRequest("/mcp enable all"));
  assert.equal(result.failed, true); assert.match(result.text, /Enabled "relay_one"/); assert.match(result.text, /Blocked by managed policy/);
  f.ignoreMutation = true;
  result = await runClaudeMcpCommand(f, claudeMcpRequest("/mcp disable relay_one")); assert.equal(result.failed, true); assert.match(result.text, /Could not verify disable/);
  for (const invalid of [null, [null], [{ name: "private\nname", status: "connected" }], [{ name: "name", status: "invented" }], [{ name: "same", status: "connected" }, { name: "same", status: "disabled" }]]) {
    await assert.rejects(runClaudeMcpCommand({ request: async () => ({ mcpServers: invalid }) }, claudeMcpRequest("/mcp disable")), /Invalid native MCP/);
  }
  await assert.rejects(runClaudeMcpCommand(f, {}), /Invalid native MCP action/);
});

test("MCP private-file preflight rejects linked/account files without returning account metadata", async t => {
  const root = await temporaryDirectory(t), outside = `${root}/outside.json`;
  await writeFile(outside, JSON.stringify({ oauthAccount: { emailAddress: "private@example.test" }, projects: { private: {} } }));
  for (const kind of ["regular", "symlink", "hardlink", "malformed"]) {
    const home = `${root}/${kind}`; await mkdir(`${home}/claude`, { recursive: true });
    const file = `${home}/claude/.claude.json`;
    if (kind === "symlink") await symlink(outside, file);
    else if (kind === "hardlink") await link(outside, file);
    else await writeFile(file, kind === "malformed" ? "invalid" : await readFile(outside));
    if (kind !== "regular") await assert.rejects(readPrivateClaudeSettings(home, ".claude.json"));
    else {
      const expected = { model: "default", permissionMode: "default" };
      assert.deepEqual(await readPrivateClaudeSettings(home, ".claude.json"), expected);
      assert.deepEqual(await inspectClaudeSettings({ runtimeHome: home, filename: ".claude.json", executor: { metadata: { backend: "ec2" }, spawn: spawnWorker } }), expected);
    }
  }
  assert.match(await readFile(outside, "utf8"), /private@example.test/);
});

async function managerFixture(t, host = false) {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const config = testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "60000", ...(host ? { CLAUDE_AUTH_MODE: "host" } : {}) }), broker = new CapabilityBroker({ ttlMs: 60000 });
  const f = { calls: [] };
  const manager = new RuntimeManager({ store, config, broker, adapterFactory: () => ({ start: async () => {}, stop: async () => f.gate?.resolve(), send: async text => { f.calls.push(text); await f.gate?.promise; if (f.error) throw Error(f.error); return { text: "Verified native MCP outcome" }; } }) });
  t.after(() => manager.shutdown()); const chat = await manager.createChat({ agent: "claude", title: "MCP test" });
  return Object.assign(f, { store, config, broker, manager, chat });
}

test("MCP controls reject attached files and host mutations before accepting or queueing input", async t => {
  const f = await managerFixture(t), host = await managerFixture(t, true);
  for (const text of ["/mcp", "/mcp --help", "/mcp enable all", "/mcp disable relay_one", "/mcp reconnect"]) {
    await assert.rejects(f.manager.submit(f.chat.id, text, ["file"]), /does not accept attachments/);
    await assert.rejects(f.manager.enqueue(f.chat.id, text, ["file"]), /does not accept attachments/);
    if (claudeMcpRequest(text).action) {
      await assert.rejects(host.manager.submit(host.chat.id, text), /shared host profile/);
      await assert.rejects(host.manager.enqueue(host.chat.id, text), /shared host profile/);
    }
  }
  assert.equal(f.store.get(f.chat.id).messages.length, 0); assert.equal(host.store.get(host.chat.id).messages.length, 0);
  const adapter = new ClaudeAdapter({ chat: host.chat, store: host.store, config: host.config, broker: host.broker, hooks: {} });
  await assert.rejects(adapter.send("/mcp disable all"), /shared host profile/); assert.equal(adapter.child, null);
  await host.manager.send(host.chat.id, "/mcp --help"); assert.deepEqual(host.calls, ["/mcp --help"]);
});

test("failed first-command preflight and spawn do not retain nonexistent native session IDs", async t => {
  const f = await managerFixture(t), home = f.store.runtimeHome(f.chat.id), sessions = [];
  await mkdir(`${home}/claude`, { recursive: true }); await writeFile(`${home}/claude/.claude.json`, "invalid");
  const adapter = new ClaudeAdapter({ chat: f.chat, store: f.store, config: f.config, broker: f.broker, gatewayOrigin: "http://127.0.0.1:9", hooks: { onSessionId: id => sessions.push(id) } });
  t.after(() => adapter.stop());
  await assert.rejects(adapter.send("/mcp disable all"), /Cannot safely verify/);
  assert.equal(adapter.sessionId, null); assert.equal(adapter.child, null); assert.deepEqual(sessions, []);
  await writeFile(`${home}/claude/.claude.json`, "{}"); f.config.claude.bin = `${home}/nonexistent-claude`;
  await assert.rejects(adapter.send("/mcp disable all"), /ENOENT/);
  assert.equal(adapter.sessionId, null); assert.deepEqual(sessions, []);
});

test("MCP actions retain literal FIFO order, pause on failure and do not consume following messages", async t => {
  const f = await managerFixture(t); f.gate = Promise.withResolvers();
  const running = f.manager.send(f.chat.id, "Current task"); await waitFor(() => f.calls.length === 1);
  for (const text of ["/mcp disable relay_one", "/mcp enable relay_one", "Next task"]) await f.manager.enqueue(f.chat.id, text);
  f.gate.resolve(); await running; await waitFor(() => f.calls.length === 4 && !f.manager.isBusy(f.chat.id));
  assert.deepEqual(f.calls, ["Current task", "/mcp disable relay_one", "/mcp enable relay_one", "Next task"]);
  f.gate = Promise.withResolvers(); const retry = f.manager.send(f.chat.id, "/mcp reconnect relay_one"); await waitFor(() => f.calls.length === 5);
  await f.manager.enqueue(f.chat.id, "Retain this task"); f.error = "Native MCP control failed"; f.gate.resolve(); await retry;
  assert.equal(f.calls.length, 5); assert.equal(f.store.get(f.chat.id).queuedMessages[0].text, "Retain this task");
  assert(f.store.get(f.chat.id).messages.some(message => message.kind === "error" && /Native MCP control failed/.test(message.text)));
});
