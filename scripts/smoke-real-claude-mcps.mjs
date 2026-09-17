import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { ChatStore } from "../src/store.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { ProviderGateway } from "../src/provider-gateway.mjs";
import { McpConnections } from "../src/mcp-connections.mjs";
import { Environments } from "../src/environments.mjs";
import { spawnWorker } from "../src/worker-process.mjs";
import { startMcpFixture } from "../test/fixtures/mcp-server.mjs";

// Actual installed Claude, Relay environment selection and credential gateway.
// Only loopback exists; all profiles, tools, credentials and replies are fixtures.
const exec = promisify(execFile);
if (!process.argv.includes("--network-isolated")) {
  const result = await exec("/usr/bin/unshare", ["--user", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL", "--", process.execPath, process.argv[1], ...process.argv.slice(2), "--network-isolated"], { timeout: 120000, maxBuffer: 40000 });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  assert.match(result.stdout, /^PASS:/m, "The fixture must finish its assertions");
} else {
  await exec("/usr/bin/ip", ["link", "set", "lo", "up"]);
  assert.deepEqual(JSON.parse((await exec("/usr/bin/ip", ["-j", "link", "show"])).stdout).map(item => item.ifname), ["lo"]);
  assert.equal((await exec("/usr/bin/ip", ["route", "show"])).stdout.trim(), "");
  const root = await mkdtemp("/tmp/relay-claude-mcps-"), requests = [], nativeEvents = [];
  let manager, gatewayServer, mcps, expectedTools = ["relay_http", "relay_stdio"], callTool = false, initializes = 0;
  let onInitialize;
  const service = await startMcpFixture({ beforeMcpRequest: async rpc => { if (rpc.method === "initialize") { initializes++; await onInitialize?.(initializes); } } });
  const modelServer = http.createServer(async (request, response) => {
    if (request.url.includes("count_tokens")) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"input_tokens":100}'); return; }
    if (request.method !== "POST" || !/\/messages(?:\?|$)/.test(request.url)) { response.writeHead(404); response.end(); return; }
    let raw = ""; for await (const chunk of request) raw += chunk;
    assert.equal(request.headers["x-api-key"], "controller-only-mcp-model-fixture");
    const body = JSON.parse(raw), index = requests.push(body);
    assert(index <= 10, "Unexpected inference from a native MCP action");
    const names = (body.tools || []).map(tool => tool.name).filter(name => name.startsWith("mcp__"));
    assert.deepEqual(names.map(name => name.split("__")[1]).sort(), [...expectedTools].sort());
    const use = callTool; callTool = false;
    const content = use ? [{ type: "tool_use", id: `tool_echo_${index}`, name: names.find(name => name.includes("relay_http")), input: { text: "MCP ação verified" } }] : [{ type: "text", text: "Fixture tool availability verified." }];
    const message = { id: `msg_mcp_${index}`, type: "message", role: "assistant", model: body.model, content, stop_reason: use ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } };
    if (!body.stream) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(message)); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const block = content[0];
    for (const event of [
      { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: use ? { ...block, input: {} } : { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: use ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  try {
    await new Promise(resolve => modelServer.listen(0, "127.0.0.1", resolve));
    const config = loadConfig({ AGENT_DATA_DIR: root, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", AGENT_IDLE_TIMEOUT_MS: "60000", CLAUDE_AUTH_MODE: "gateway", ANTHROPIC_API_KEY: "controller-only-mcp-model-fixture" });
    const store = new ChatStore(root); await store.initialize(); const broker = new CapabilityBroker({ ttlMs: 180000 }), records = new MemoryRecords();
    mcps = new McpConnections(records);
    const saved = await mcps.save({ name: "http", allowUnassigned: true, type: "http", url: `${service.origin}/mcp`, authMode: "headers", headers: { Authorization: "Bearer fixture-access-secret" } });
    const stdio = await mcps.save({ name: "stdio", allowUnassigned: true, type: "stdio", command: process.execPath, args: [fileURLToPath(new URL("../test/fixtures/mcp-stdio.mjs", import.meta.url))] });
    const environments = new Environments(records, "local", mcps);
    const environment = await environments.save({ name: "MCP fixtures", backend: "local", allowUnassigned: true, software: [], mcpIds: [saved.id, stdio.id] });
    const gateway = new ProviderGateway({ config, broker, fetchImpl: (url, options) => fetch(`http://127.0.0.1:${modelServer.address().port}${new URL(url).pathname}${new URL(url).search}`, options) });
    gatewayServer = http.createServer(async (request, response) => {
      const url = new URL(request.url, "http://fixture");
      if (!await mcps.handle(request, response, url) && !await gateway.handle(request, response, url)) { response.writeHead(404); response.end(); }
    });
    await new Promise(resolve => gatewayServer.listen(0, "127.0.0.1", resolve));
    const gatewayOrigin = `http://127.0.0.1:${gatewayServer.address().port}`;
    const workerBackend = { sleep: async () => {}, shutdown: async () => {}, acquire: async chat => ({
      workspace: chat.workspace, runtimeHome: store.runtimeHome(chat.id), metadata: { backend: "local" },
      mkdir: directory => mkdir(directory, { recursive: true, mode: 0o700 }),
      spawn(command, args, options) {
        assert(!JSON.stringify([args, options.env]).includes(config.claude.providerKey));
        assert(!JSON.stringify([args, options.env]).includes("fixture-access-secret"));
        const child = spawnWorker(command, args, { ...options, env: { ...options.env, ENABLE_TOOL_SEARCH: "false" } });
        let buffer = ""; child.stdout.on("data", chunk => { buffer += chunk; const lines = buffer.split("\n"); buffer = lines.pop(); for (const line of lines) { try { nativeEvents.push(JSON.parse(line)); } catch {} } });
        return child;
      },
    }) };
    manager = new RuntimeManager({ store, config, broker, gatewayOrigin, workerBackend, mcps, environments, adapterFactory: params => new ClaudeAdapter({ ...params, store, config, broker, gatewayOrigin }) });
    const chat = await manager.createChat({ agent: "claude", title: "Native MCP actions", environmentId: environment.id });
    const submit = async (command, error = false) => {
      const before = store.get(chat.id).messages.length;
      await manager.send(chat.id, command);
      const messages = store.get(chat.id).messages.slice(before);
      const errors = messages.filter(message => message.kind === "error").map(message => message.text);
      if (error) assert.equal(errors.length, 1, command); else assert.deepEqual(errors, [], command);
      const text = error ? errors[0] : messages.filter(message => message.role === "assistant").at(-1)?.text;
      console.log(`${command}: ${text}`);
      return text;
    };
    if (process.argv.includes("--errors")) {
      assert.match(await submit("/mcp"), /2 connected/); const session = store.get(chat.id).agentSessionId;
      service.rejectTokens = true;
      assert.match(await submit("/mcp reconnect relay_http", true), /Native MCP control failed/);
      await submit("/mcp disable relay_http");
      assert.match(await submit("/mcp enable relay_http", true), /Native MCP control failed/);
      assert.match(await submit("/mcp"), /1 connected, 1 not connected, 0 disabled/);
      service.rejectTokens = false;
      assert.match(await submit("/mcp reconnect relay_http"), /Reconnected "relay_http"/);
      const stopWhileConnecting = async (target, offset) => {
        const held = Promise.withResolvers(), release = Promise.withResolvers(), holdAt = initializes + offset;
        onInitialize = count => { if (count === holdAt) { held.resolve(); return release.promise; } };
        const pending = manager.send(target.id, "/mcp reconnect relay_http");
        let timer;
        try {
          await Promise.race([held.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("The real MCP initialization was not reached")), 15000); })]);
          await manager.enqueue(target.id, "Retain this unsent follow-up");
          await manager.stop(target.id); await pending;
        } finally { clearTimeout(timer); onInitialize = null; release.resolve(); }
        assert.equal(store.get(target.id).status, "stopped");
        assert.equal(store.get(target.id).queuedMessages[0].text, "Retain this unsent follow-up");
      };
      await stopWhileConnecting(chat, 2); // Startup connects once; the RPC reconnect connects again.
      assert.equal(store.get(chat.id).agentSessionId, session);
      assert.match(await submit("/mcp"), /2 connected/); assert.equal(store.get(chat.id).agentSessionId, session);
      const fresh = await manager.createChat({ agent: "claude", title: "Interrupted first control", environmentId: environment.id });
      await stopWhileConnecting(fresh, 1);
      assert.equal(store.get(fresh.id).agentSessionId, null, "Do not retain a nonexistent journal from interrupted control-only initialization");
      await manager.send(fresh.id, "/mcp"); assert.match(store.get(fresh.id).messages.at(-1).text, /2 connected/);
      assert(store.get(fresh.id).agentSessionId);
      assert.equal(requests.length, 0);
      assert(!JSON.stringify(store.get(chat.id).messages).includes("fixture-access-secret"));
      console.log("PASS: failed reconnect/enable stay errors, native partial enable persists honestly, recovery works, Stop interrupts actual MCP initialization without consuming queued input, and interrupted first controls do not leave broken resume IDs. Zero inference.");
    } else {
    assert.match(await submit("/mcp disable relay_stdio"), /Disabled "relay_stdio"/);
    assert.match(await submit("/mcp enable relay_stdio"), /Enabled "relay_stdio"/);
    assert.match(await submit("/mcp"), /2 MCP server\(s\): 2 connected/);
    await writeFile(`${store.runtimeHome(chat.id)}/claude/settings.json`, JSON.stringify({ permissions: { allow: ["mcp__relay_http__fixture_echo"] } }));
    const session = store.get(chat.id).agentSessionId;
    const connected = initializes;
    assert.match(await submit("/mcp reconnect relay_http"), /Reconnected "relay_http"/);
    assert(initializes >= connected + 2, "Reconnect must perform initialization again, not merely acknowledge it");
    assert.match(await submit("/mcp disable relay_http"), /Disabled "relay_http"/);
    assert.match(await submit("/mcp"), /1 connected, 0 not connected, 1 disabled/);
    assert.match(await submit("/mcp reconnect relay_http"), /is disabled/);
    await manager.stop(chat.id);
    assert.match(await submit("/mcp"), /1 connected, 0 not connected, 1 disabled/);
    assert.equal(store.get(chat.id).agentSessionId, session);
    assert.match(await submit("/mcp enable relay_http"), /Enabled "relay_http"/);
    assert.match(await submit("/mcp disable all"), /Disabled 2 MCP server/);
    assert.match(await submit("/mcp"), /0 connected, 0 not connected, 2 disabled/);
    assert.match(await submit("/mcp enable"), /Enabled 2 MCP server/);
    assert.match(await submit("/mcp reconnect all"), /already connected or cached/);
    assert.match(await submit("/mcp disable missing"), /no MCP server named "missing"/);
    assert.match(await submit("/mcp invalid"), /isn't a recognized/);
    assert.match(await submit("/mcp --help"), /Usage: \/mcp/);
    assert.equal(requests.length, 0, "Local MCP actions must never call the model");
    const other = await manager.createChat({ agent: "claude", title: "Independent MCP selection", environmentId: environment.id });
    await submit("/mcp disable");
    await manager.send(other.id, "/mcp"); assert.match(store.get(other.id).messages.at(-1).text, /2 connected/);
    const afterDisable = initializes;
    expectedTools = []; await submit("Verify no fixture MCP tools are available.");
    assert.equal(initializes, afterDisable, "Disabled servers must not reconnect on an ordinary turn");
    await submit("/mcp enable all");
    expectedTools = ["relay_http", "relay_stdio"]; callTool = true;
    await submit("Use the fixture HTTP echo tool, then report its result.");
    assert.equal(service.calls, 1); assert.match(JSON.stringify(requests.at(-1).messages.at(-1)), /MCP ação verified/);
    assert.equal(requests.length, 3);
    assert.deepEqual((await environments.get(environment.id)).mcpIds, [saved.id, stdio.id]);
    assert.equal((await mcps.get(saved.id)).revision, saved.revision, "Per-chat native toggles must not alter saved credentials/selections");
    const nativeProfile = JSON.parse(await readFile(`${store.runtimeHome(chat.id)}/claude/.claude.json`, "utf8"));
    assert.deepEqual(nativeProfile.projects[chat.workspace].disabledMcpServers, []);
    assert(store.get(chat.id).slashCommands.length > 0, "Post-action connector refresh must retain the native command catalog");
    console.log("PASS: actual HTTP/stdio MCP reconnect, disable/enable/all, Stop/resume, independent profiles, invalid/help, next-turn tool availability and gateway tool execution. Three loopback replies; no real accounts or host-profile writes.");
    }
  } finally {
    await manager?.shutdown(); modelServer.closeAllConnections(); gatewayServer?.closeAllConnections();
    await Promise.all([service.close(), new Promise(resolve => modelServer.close(resolve)), ...(gatewayServer ? [new Promise(resolve => gatewayServer.close(resolve))] : [])]);
    await rm(root, { recursive: true, force: true });
  }
}
