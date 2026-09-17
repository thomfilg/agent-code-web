import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
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
  const root = await mkdtemp("/tmp/relay-claude-mcps-"), requests = [], mainRequests = [], nativeEvents = [], launches = [];
  const application = process.argv.includes("--application");
  let applicationStep = application ? 0 : null, disabledProbe = 0;
  let manager, gatewayServer, mcps, fixtureError, failureStop, expectedTools = ["relay_http", "relay_stdio"], callTool = false, initializes = 0;
  let onInitialize;
  const service = await startMcpFixture({ beforeMcpRequest: async rpc => { if (rpc.method === "initialize") { initializes++; await onInitialize?.(initializes); } } });
  const respond = async (request, response) => {
    if (request.url.includes("count_tokens")) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"input_tokens":100}'); return; }
    if (request.method !== "POST" || !/\/messages(?:\?|$)/.test(request.url)) { response.writeHead(404); response.end(); return; }
    let raw = ""; for await (const chunk of request) raw += chunk;
    assert.equal(request.headers["x-api-key"], "controller-only-mcp-model-fixture");
    const body = JSON.parse(raw), index = requests.push(body);
    assert(index <= 15, "Unexpected inference from a native MCP action");
    const title = !body.tools?.length && JSON.stringify(body.messages.at(-1)).includes("Write the title in the predominant language");
    if (!title) mainRequests.push(body);
    const names = (body.tools || []).map(tool => tool.name).filter(name => name.startsWith("mcp__"));
    if (!title) assert.deepEqual(names.map(name => name.split("__")[1]).sort(), [...expectedTools].sort());
    let content;
    if (title) content = [{ type: "text", text: "Fixture application and MCP controls" }];
    else if (applicationStep === 0) {
      assert.match(JSON.stringify(body.messages), /Running means launching the actual app/);
      content = [{ type: "tool_use", id: `tool_app_${index}`, name: "Bash", input: { command: "node application.mjs", description: "Start the disposable HTTP application", run_in_background: true } }];
      applicationStep++;
    } else if (applicationStep === 1) {
      const results = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === "tool_result");
      assert(results.length); assert(!results.at(-1).is_error, JSON.stringify(results.at(-1)));
      content = [{ type: "text", text: "The fixture application is running." }]; applicationStep = null;
    } else if (disabledProbe === 1) {
      // Deliberately attempt the now-unadvertised tool as well: absence from
      // the model's list alone is not proof that native execution is denied.
      content = [{ type: "tool_use", id: `tool_disabled_${index}`, name: "mcp__relay_http__fixture_echo", input: { text: "Must not reach the MCP server" } }];
      disabledProbe = 2;
    } else if (disabledProbe === 2) {
      const results = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === "tool_result");
      assert.equal(results.at(-1).is_error, true); assert.equal(service.calls, 0);
      content = [{ type: "text", text: "The disabled MCP tool cannot execute." }]; disabledProbe = 0;
    } else {
      const use = callTool; callTool = false;
      content = use ? [{ type: "tool_use", id: `tool_echo_${index}`, name: names.find(name => name.includes("relay_http")), input: { text: "MCP ação verified" } }] : [{ type: "text", text: "Fixture tool availability verified." }];
    }
    const use = content[0].type === "tool_use";
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
  };
  const modelServer = http.createServer((request, response) => { void respond(request, response).catch(error => {
    fixtureError = error;
    if (!response.headersSent) response.writeHead(500);
    response.end(); failureStop ||= manager?.shutdown();
  }); });
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
        if (command === config.claude.bin && args.includes("--print")) launches.push({ chatId: chat.id, args });
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
      if (fixtureError) throw fixtureError;
      const messages = store.get(chat.id).messages.slice(before);
      const errors = messages.filter(message => message.kind === "error").map(message => message.text);
      if (error) assert.equal(errors.length, 1, command); else assert.deepEqual(errors, [], command);
      const text = error ? errors[0] : messages.filter(message => message.role === "assistant").at(-1)?.text;
      console.log(`${command}: ${text}`);
      return text;
    };
    if (application) {
      await writeFile(`${chat.workspace}/application.mjs`, `import http from 'node:http';
import {writeFile} from 'node:fs/promises';
let value = 'initial';
const server = http.createServer(async (req,res) => {
  if (req.method === 'POST') { value = ''; for await (const part of req) value += part; }
  res.setHeader('content-type','application/json'); res.end(JSON.stringify({pid:process.pid,value}));
});
server.listen(0,'127.0.0.1',async()=>{ await writeFile('.application.json',JSON.stringify({port:server.address().port})); console.log('Fixture application ready'); });
`);
      await mkdir(`${store.runtimeHome(chat.id)}/claude`, { recursive: true });
      await writeFile(`${store.runtimeHome(chat.id)}/claude/settings.json`, JSON.stringify({ permissions: { allow: ["Bash(node application.mjs)", "mcp__relay_http__fixture_echo"] } }));
      assert.match(await submit("/run Start the fixture HTTP application and keep it running."), /application is running/);
      const session = store.get(chat.id).agentSessionId;
      let applicationPort;
      const deadline = Date.now() + 10000;
      while (!applicationPort && Date.now() < deadline) { try { applicationPort = JSON.parse(await readFile(`${chat.workspace}/.application.json`, "utf8")).port; } catch { await delay(25); } }
      assert(applicationPort, "The native Bash tool must actually launch the application");
      const appUrl = `http://127.0.0.1:${applicationPort}`;
      const state = await (await fetch(appUrl, { method: "POST", body: "retained ação" })).json();
      const checkApplication = async () => {
        assert.deepEqual(await (await fetch(appUrl, { signal: AbortSignal.timeout(2000) })).json(), state);
        assert.equal(launches.filter(launch => launch.chatId === chat.id).length, 1, "MCP controls must retain the CLI owning the app");
        assert.equal(store.get(chat.id).agentSessionId, session);
      };
      const control = async (command, expected, error = false) => {
        const before = mainRequests.length;
        assert.match(await submit(command, error), expected);
        assert.equal(mainRequests.length, before, "Native MCP controls must not call the model");
        await checkApplication();
      };
      await control("/mcp", /2 connected/);
      const connected = initializes;
      await control("/mcp reconnect relay_http", /Reconnected "relay_http"/);
      assert(initializes > connected, "Reconnect must initialize the actual MCP transport again");
      await control("/mcp reconnect relay_stdio", /Reconnected "relay_stdio"/);
      await control("/mcp disable relay_http", /Disabled "relay_http"/);
      await control("/mcp", /1 connected, 0 not connected, 1 disabled/);
      await control("/mcp reconnect relay_http", /is disabled/);
      const profile = JSON.parse(await readFile(`${store.runtimeHome(chat.id)}/claude/.claude.json`, "utf8"));
      assert.deepEqual(profile.projects[chat.workspace].disabledMcpServers, ["relay_http"]);
      expectedTools = ["relay_stdio"]; disabledProbe = 1;
      await submit("Verify the disabled HTTP tool is not available in this same application session.");
      await checkApplication();
      await control("/mcp enable relay_http", /Enabled "relay_http"/);
      expectedTools = ["relay_http", "relay_stdio"]; callTool = true;
      await submit("Use the HTTP echo tool without restarting the app.");
      assert.equal(service.calls, 1); assert.match(JSON.stringify(mainRequests.at(-1).messages), /MCP ação verified/);
      await control("/mcp disable all", /Disabled 2 MCP server/);
      expectedTools = []; await submit("Verify all MCP tools are absent while the application is still running."); await checkApplication();
      const other = await manager.createChat({ agent: "claude", title: "Independent of retained app", environmentId: environment.id });
      await manager.send(other.id, "/mcp"); assert.match(store.get(other.id).messages.at(-1).text, /2 connected/);
      await control("/mcp enable all", /Enabled 2 MCP server/);
      expectedTools = ["relay_http", "relay_stdio"];
      service.rejectTokens = true;
      await control("/mcp reconnect relay_http", /Native MCP control failed/, true);
      service.rejectTokens = false;
      await control("/mcp reconnect relay_http", /Reconnected "relay_http"/);
      callTool = true; await submit("Use the recovered HTTP tool while retaining the app.");
      assert.equal(service.calls, 2); await checkApplication();
      const held = Promise.withResolvers(), release = Promise.withResolvers();
      onInitialize = () => { held.resolve(); return release.promise; };
      const pending = manager.send(chat.id, "/mcp reconnect relay_http"); let timer;
      try {
        await Promise.race([held.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Retained MCP reconnect did not reach the server")), 15000); })]);
        await manager.enqueue(chat.id, "Retain this queued follow-up");
        await manager.stop(chat.id); await pending;
      } finally { clearTimeout(timer); onInitialize = null; release.resolve(); }
      assert.deepEqual(store.get(chat.id).queuedMessages.map(message => message.text), ["Retain this queued follow-up"]);
      await assert.rejects(fetch(appUrl, { signal: AbortSignal.timeout(2000) }));
      await submit("/mcp"); assert.equal(store.get(chat.id).agentSessionId, session);
      assert.equal(launches.filter(launch => launch.chatId === chat.id).length, 2);
      assert.equal(mainRequests.length, 9);
      assert.deepEqual((await environments.get(environment.id)).mcpIds, [saved.id, stdio.id]);
      assert.equal((await mcps.get(saved.id)).revision, saved.revision);
      assert(!JSON.stringify(store.get(chat.id).messages).includes("fixture-access-secret"));
      console.log(`PASS: native MCP status/reconnect/toggle/all, tool removal/recovery and authenticated tool execution retained one native CLI and actual HTTP app/data; other profiles stayed independent, failure preserved the app, Stop canceled live reconnect and retained queued input/context. ${mainRequests.length} main and ${requests.length - mainRequests.length} title loopback replies.`);
    } else if (process.argv.includes("--errors")) {
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
    await failureStop; await manager?.shutdown(); modelServer.closeAllConnections(); gatewayServer?.closeAllConnections();
    await Promise.all([service.close(), new Promise(resolve => modelServer.close(resolve)), ...(gatewayServer ? [new Promise(resolve => gatewayServer.close(resolve))] : [])]);
    await rm(root, { recursive: true, force: true });
  }
}
