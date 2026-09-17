import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { loadConfig } from "../src/config.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { ChatStore } from "../src/store.mjs";
import { ModelCatalog } from "../src/models.mjs";
import { CommandCatalog } from "../src/command-catalog.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { spawnWorker } from "../src/worker-process.mjs";

// Actual installed CLI, isolated credentials, no real inference or network
// egress. The controller receives allowed/denied organization responses from a
// loopback fixture; the worker receives ONLY its short-lived gateway capability.
const exec = promisify(execFile);
if (!process.argv.includes("--network-isolated")) {
  const result = await exec("/usr/bin/unshare", ["--user", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL", "--", process.execPath, process.argv[1], "--network-isolated"], { timeout: 90000, maxBuffer: 200000 });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
} else {
  await exec("/usr/bin/ip", ["link", "set", "lo", "up"]);
  assert.deepEqual(JSON.parse((await exec("/usr/bin/ip", ["-j", "link", "show"])).stdout).map(item => item.ifname), ["lo"]);
  assert.equal((await exec("/usr/bin/ip", ["route", "show"])).stdout.trim(), "");
  const root = await mkdtemp("/tmp/relay-claude-fast-"), requests = [], launches = [], nativeResults = [], workerEnv = {};
  let manager, allowed = true, availabilityCalls = 0;
  const server = http.createServer(async (request, response) => {
    if (request.url === "/api/claude_code_penguin_mode") {
      assert.equal(request.headers["x-api-key"], "controller-only-fast-fixture"); availabilityCalls++;
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ enabled: allowed, disabled_reason: allowed ? null : "preference" })); return;
    }
    if (request.url.includes("count_tokens")) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"input_tokens":100}'); return; }
    if (request.method !== "POST" || !/\/messages(?:\?|$)/.test(request.url)) { response.writeHead(404); response.end(); return; }
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw), index = requests.push(body), text = "Native Fast fixture reply.";
    const message = { id: `msg_fast_${index}`, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } };
    if (!body.stream) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(message)); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const config = loadConfig({ AGENT_DATA_DIR: root, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", AGENT_IDLE_TIMEOUT_MS: "60000", CLAUDE_AUTH_MODE: "gateway", ANTHROPIC_API_KEY: "controller-only-fast-fixture" });
    const store = new ChatStore(root); await store.initialize(); const broker = new CapabilityBroker({ ttlMs: 120000 });
    manager = new RuntimeManager({ store, config, broker, gatewayOrigin: origin, models: new ModelCatalog(config), adapterFactory: params => {
      const executor = { workspace: params.chat.workspace, runtimeHome: store.runtimeHome(params.chat.id), environmentVariables: workerEnv, mkdir: directory => mkdir(directory, { recursive: true, mode: 0o700 }),
        spawn(command, args, options) {
          assert(!JSON.stringify(options.env).includes(config.claude.providerKey), "The controller key must never enter the worker");
          launches.push({ args, optedIn: options.env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK === "1" });
          const child = spawnWorker(command, args, options); let buffered = "";
          child.stdout.on("data", chunk => { buffered += chunk; const lines = buffered.split("\n"); buffered = lines.pop(); for (const line of lines) { try { const event = JSON.parse(line); if (event.type === "result") nativeResults.push({ text: event.result, state: event.fast_mode_state, reason: event.fast_mode_disabled_reason }); } catch {} } });
          return child;
        } };
      return new ClaudeAdapter({ ...params, store, config, broker, gatewayOrigin: origin, executor,
        fetchImpl: (url, options) => { assert.equal(url, "https://api.anthropic.com/api/claude_code_penguin_mode"); return fetch(`${origin}${new URL(url).pathname}`, options); } });
    } });
    const chat = await manager.createChat({ agent: "claude", title: "Private Fast acceptance" });
    assert((await new CommandCatalog(config).list(store.get(chat.id))).commands.some(command => command.name === "fast"), "The installed command catalog must expose Fast in this private profile");
    const send = async text => {
      const before = store.get(chat.id).messages.length; await manager.send(chat.id, text);
      assert.deepEqual(store.get(chat.id).messages.slice(before).filter(message => message.kind === "error").map(message => message.text), [], `${text}: ${JSON.stringify(nativeResults.at(-1))}`);
    };
    await send("/fast"); assert.equal(store.get(chat.id).claudeFastMode, true); assert.equal(store.get(chat.id).claudeFastStatus.state, "on");
    assert.equal(requests.length, 0, "Fast control must never become inference");
    await send("First Fast request."); assert.equal(requests.at(-1).speed, "fast");
    const session = store.get(chat.id).agentSessionId;
    await manager.stop(chat.id); await send("Continue Fast after Stop."); assert.equal(requests.at(-1).speed, "fast"); assert.equal(store.get(chat.id).agentSessionId, session);
    await send("/fast off"); await send("Standard speed now."); assert.notEqual(requests.at(-1).speed, "fast");
    await manager.setModel(chat.id, { model: "sonnet", effort: "high" }); await send("/fast on");
    assert.equal(store.get(chat.id).model, "opus"); assert.equal(store.get(chat.id).effort, "high");
    await send("Native promotion should persist."); assert.match(requests.at(-1).model, /opus/); assert.equal(requests.at(-1).speed, "fast");
    await manager.setModel(chat.id, { model: "sonnet", effort: "high" }); await send("An explicit model switch wins.");
    assert.match(requests.at(-1).model, /sonnet/); assert.notEqual(requests.at(-1).speed, "fast");
    await send("/fast"); assert.equal(store.get(chat.id).model, "opus"); assert.equal(store.get(chat.id).claudeFastMode, true);
    await send("A toggle from inactive Sonnet enables Fast again."); assert.equal(requests.at(-1).speed, "fast");
    allowed = false; const before = launches.length, inference = requests.length;
    await manager.send(chat.id, "/fast on"); assert.match(store.get(chat.id).messages.at(-1).text, /disabled by the organization/);
    assert.equal(launches.length, before); assert.equal(requests.length, inference);
    await send("Standard mode remains usable after a denial."); assert.notEqual(requests.at(-1).speed, "fast");
    assert.equal(store.get(chat.id).claudeFastMode, false);
    await send("/fast off");
    assert.equal(launches.at(-1).optedIn, false);
    allowed = true; workerEnv.CLAUDE_CODE_DISABLE_FAST_MODE = "1"; const noInference = requests.length;
    await manager.send(chat.id, "/fast on"); assert.match(store.get(chat.id).messages.at(-1).text, /disabled by worker policy/); assert.equal(requests.length, noInference);
    assert.equal(store.get(chat.id).claudeFastMode, false); delete workerEnv.CLAUDE_CODE_DISABLE_FAST_MODE;
    await writeFile(`${store.runtimeHome(chat.id)}/claude/settings.json`, JSON.stringify({ availableModels: ["sonnet"] }));
    await manager.send(chat.id, "/fast on"); assert.match(store.get(chat.id).messages.at(-1).text, /not allowed|not available|unavailable/i);
    assert.equal(requests.length, noInference); assert.equal(store.get(chat.id).claudeFastMode, false);
    console.log(`PASS: native Claude Fast state, ${requests.length} actual loopback model requests (Fast/standard), same-session Stop/resume, model promotion/switch, native disable/model policies, and fresh allowed/denied account checks (${availabilityCalls}). Controller key never enters worker; no external network or personal profiles.`);
  } finally {
    await manager?.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true });
  }
}
