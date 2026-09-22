import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { loadConfig } from "../src/config.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { ChatStore } from "../src/store.mjs";
import { ModelCatalog } from "../src/models.mjs";
import { CommandCatalog } from "../src/command-catalog.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { ProviderGateway } from "../src/provider-gateway.mjs";
import { spawnWorker } from "../src/worker-process.mjs";

// Real installed CLI + controller + gateway. Network/PID namespace with only
// loopback, disposable profiles and authored model replies; no real inference.
const exec = promisify(execFile);
if (!process.argv.includes("--network-isolated")) {
  const result = await exec("/usr/bin/unshare", ["--user", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL", "--", process.execPath, process.argv[1], ...process.argv.slice(2), "--network-isolated"], { timeout: 90000, maxBuffer: 40000 });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  assert.match(result.stdout, /^PASS:/m, "The fixture must finish its assertions, not merely exit zero");
} else {
  await exec("/usr/bin/ip", ["link", "set", "lo", "up"]);
  assert.deepEqual(JSON.parse((await exec("/usr/bin/ip", ["-j", "link", "show"])).stdout).map(item => item.ifname), ["lo"]);
  assert.equal((await exec("/usr/bin/ip", ["route", "show"])).stdout.trim(), "");
  const root = await mkdtemp("/tmp/relay-claude-goals-"), requests = [], events = [];
  let manager, gatewayServer, evaluations = 0, turns = 0, holdEvaluation = false, evaluationHeld = false;
  const invalidEvaluation = process.argv.includes("--errors");
  const server = http.createServer(async (request, response) => {
    if (request.url.includes("count_tokens")) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"input_tokens":100}'); return; }
    if (request.method !== "POST" || !/\/messages(?:\?|$)/.test(request.url)) { response.writeHead(404); response.end(); return; }
    let raw = ""; for await (const chunk of request) raw += chunk;
    assert.equal(request.headers["x-api-key"], "controller-only-goal-fixture");
    const body = JSON.parse(raw), index = requests.push(body);
    assert(index <= 20, "Unexpected native inference loop");
    const evaluator = (body.system || []).some(block => block.text?.startsWith("You are evaluating a stop-condition hook in Claude Code."));
    if (evaluator) evaluations++; else turns++;
    if (evaluator && holdEvaluation) { evaluationHeld = true; return; }
    const text = evaluator ? invalidEvaluation ? "Invalid evaluator output is deliberately not JSON." : JSON.stringify({ ok: evaluations > 1, reason: evaluations > 1 ? "Goal fixture completed." : "The second fixture step is still missing." }) : turns > 1 ? "GOAL_FIXTURE_COMPLETE. Both steps verified." : "First goal step completed. One remains.";
    // Several content blocks still belong to ONE native assistant message.
    const content = !evaluator && turns === 1 ? [{ type: "text", text: "First goal step completed. " }, { type: "text", text: "One remains." }] : [{ type: "text", text }];
    const message = { id: `msg_goal_${index}`, type: "message", role: "assistant", model: body.model, content, stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } };
    if (!body.stream) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(message)); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      ...content.flatMap((block, index) => [
        { type: "content_block_start", index, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
        { type: "content_block_stop", index },
      ]),
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const config = loadConfig({ AGENT_DATA_DIR: root, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", AGENT_IDLE_TIMEOUT_MS: "60000", CLAUDE_AUTH_MODE: "gateway", ANTHROPIC_API_KEY: "controller-only-goal-fixture" });
    const store = new ChatStore(root); await store.initialize(); const broker = new CapabilityBroker({ ttlMs: 120000 }), commands = new CommandCatalog(config);
    const gateway = new ProviderGateway({ config, broker, fetchImpl: (url, options) => fetch(`${origin}${new URL(url).pathname}${new URL(url).search}`, options) });
    gatewayServer = http.createServer((request, response) => { void gateway.handle(request, response, new URL(request.url, "http://fixture")); });
    await new Promise(resolve => gatewayServer.listen(0, "127.0.0.1", resolve));
    const gatewayOrigin = `http://127.0.0.1:${gatewayServer.address().port}`;
    manager = new RuntimeManager({ store, config, broker, gatewayOrigin, commands, models: new ModelCatalog(config), adapterFactory: params => {
      const executor = { workspace: params.chat.workspace, runtimeHome: store.runtimeHome(params.chat.id), mkdir: directory => mkdir(directory, { recursive: true, mode: 0o700 }),
        spawn(command, args, options) {
          assert(!JSON.stringify(options.env).includes(config.claude.providerKey));
          const child = spawnWorker(command, args, options); let buffered = "";
          child.stdout.on("data", chunk => { buffered += chunk; const lines = buffered.split("\n"); buffered = lines.pop(); for (const line of lines) { try { events.push(JSON.parse(line)); } catch {} } });
          return child;
        } };
      return new ClaudeAdapter({ ...params, store, config, broker, gatewayOrigin, executor });
    } });
    const chat = await manager.createChat({ agent: "claude", title: "Native goal acceptance" });
    await manager.setModel(chat.id, { model: "sonnet", effort: "high" });
    assert((await commands.claude(store.get(chat.id))).some(command => command.name === "goal"));
    const condition = "Produce GOAL_FIXTURE_COMPLETE after verifying both fixture steps.\nPreserve Unicode: ação.";
    const submit = async command => {
      const before = store.get(chat.id).messages.length;
      await manager.send(chat.id, command);
      const messages = store.get(chat.id).messages.slice(before);
      assert.deepEqual(messages.filter(message => message.kind === "error").map(message => message.text), [], command);
      return messages.filter(message => message.role === "assistant").at(-1)?.text;
    };
    const stopDuringEvaluation = async () => {
      holdEvaluation = true; evaluationHeld = false;
      const pending = manager.send(chat.id, `/goal ${condition}`);
      const deadline = Date.now() + 15000;
      while (!evaluationHeld && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert(evaluationHeld, "Stop must interrupt the actual native evaluator, not a fabricated idle state");
      assert(manager.isBusy(chat.id));
      await manager.stop(chat.id); await pending; holdEvaluation = false;
      assert.equal(store.get(chat.id).status, "stopped");
    };
    assert.match(await submit("/goal"), /No goal set/); assert.equal(requests.length, 0);
    const session = store.get(chat.id).agentSessionId;
    if (process.argv.includes("--resume")) {
      await stopDuringEvaluation();
      const afterStop = requests.length;
      assert.match(await submit("/goal"), /Goal active: Produce GOAL_FIXTURE_COMPLETE/);
      assert.equal(requests.length, afterStop, "A status query must not start another goal turn/evaluation");
      assert.equal(store.get(chat.id).agentSessionId, session);
      const other = await manager.createChat({ agent: "claude", title: "Independent goal" });
      await manager.send(other.id, "/goal"); assert.match(store.get(other.id).messages.at(-1).text, /No goal set/);
      assert.match(await submit("Continue the saved goal."), /GOAL_FIXTURE_COMPLETE/);
      assert.match(await submit("/goal"), /No goal set/); assert.equal(evaluations, 2);
      await stopDuringEvaluation(); const beforeClear = requests.length;
      assert.match(await submit("/goal clear"), /Goal cleared: Produce GOAL_FIXTURE_COMPLETE/);
      for (const alias of ["stop", "off", "reset", "none", "cancel", "CLEAR"]) assert.match(await submit(`/goal ${alias}`), /No goal set/);
      await manager.stop(chat.id); assert.match(await submit("/goal"), /No goal set/);
      assert.equal(requests.length, beforeClear, "Clearing/status aliases must never turn into inference");
      const saved = new ChatStore(root); await saved.initialize(); assert.equal(saved.get(chat.id).agentSessionId, session);
      assert.equal(requests.length, 6);
      console.log("PASS: native goal survives interruption during its evaluator, same-session Stop/resume, explicit continuation, independent chats, clear and all native clear aliases; six loopback requests, no real accounts.");
    } else if (invalidEvaluation) {
      await submit(`/goal ${condition}`);
      assert(events.some(event => event.key === "stop-hook-error"));
      assert.equal(store.get(chat.id).messages.filter(message => message.kind === "notice" && /completion check failed/.test(message.text)).length, 1, "Native evaluator errors must be visible, without an unusable terminal shortcut");
      assert.match(await submit("/goal"), /Goal active:/);
      await submit("/goal clear");
      const settingsFile = `${store.runtimeHome(chat.id)}/claude/settings.json`;
      await writeFile(settingsFile, JSON.stringify({ disableAllHooks: true }));
      const beforePolicy = requests.length;
      assert.match(await submit(`/goal ${condition}`), /hooks are restricted/);
      assert.match(await submit("/goal"), /No goal set/);
      assert.equal(requests.length, beforePolicy); assert.equal(requests.length, 2);
      assert.equal(JSON.parse(await readFile(settingsFile, "utf8")).disableAllHooks, true);
      console.log("PASS: native evaluator error is visible and does not clear/complete its goal; native hook restriction is enforced without inference or settings writes. Two loopback requests, no personal profiles.");
    } else {
      assert.equal(await submit(`/goal ${condition}`), "First goal step completed. One remains.\n\nGOAL_FIXTURE_COMPLETE. Both steps verified.");
      assert.equal(turns, 2); assert.equal(evaluations, 2);
      assert.equal(requests.length, 4);
      const evaluation = requests.filter(body => (body.system || []).some(block => block.text?.startsWith("You are evaluating a stop-condition hook in Claude Code.")));
      assert.equal(evaluation.length, 2); assert.match(JSON.stringify(evaluation[0].messages), /Preserve Unicode: ação/);
      assert.match(JSON.stringify(requests[2].messages.at(-1)), /The second fixture step is still missing/);
      assert.match(await submit("/goal"), /No goal set/); await manager.stop(chat.id);
      assert.match(await submit("/goal"), /No goal set/); assert.equal(store.get(chat.id).agentSessionId, session);
      const beforeInvalid = requests.length;
      assert.match(await submit(`/goal ${"x".repeat(4001)}`), /limited to 4000 characters/); assert.equal(requests.length, beforeInvalid);
      console.log("PASS: native goal starts immediately, evaluates/continues through two actual turns, preserves multiline Unicode and response boundaries, clears only after evaluation, stays cleared after Stop, and enforces the native limit. Four loopback replies.");
    }
  } finally {
    await manager?.shutdown(); server.closeAllConnections(); gatewayServer?.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), ...(gatewayServer ? [new Promise(resolve => gatewayServer.close(resolve))] : [])]);
    await rm(root, { recursive: true, force: true });
  }
}
