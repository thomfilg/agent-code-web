import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { loadConfig } from "../src/config.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { ProviderGateway } from "../src/provider-gateway.mjs";
import { spawnWorker } from "../src/worker-process.mjs";

// Real installed scheduler and tools, authored inference, actual elapsed time.
// No personal profiles, accounts, external traffic or accelerated native clock.
const exec = promisify(execFile);
if (!process.argv.includes("--network-isolated")) {
  const result = await exec("/usr/bin/unshare", ["--user", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL", "--", process.execPath, process.argv[1], ...process.argv.slice(2), "--network-isolated"], { timeout: 180000, killSignal: "SIGKILL", maxBuffer: 40000 }).catch(error => {
    process.stdout.write(error.stdout || ""); process.stderr.write(error.stderr || error.message); process.exit(1);
  });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); assert.match(result.stdout, /^PASS:/m);
} else {
  await exec("/usr/bin/ip", ["link", "set", "lo", "up"]);
  assert.deepEqual(JSON.parse((await exec("/usr/bin/ip", ["-j", "link", "show"])).stdout).map(item => item.ifname), ["lo"]);
  assert.equal((await exec("/usr/bin/ip", ["route", "show"])).stdout.trim(), "");
  const root = await mkdtemp("/tmp/relay-claude-loop-"), launches = [], requests = [];
  const sendNow = process.argv.includes("--send-now"), stop = process.argv.includes("--stop"), release = Promise.withResolvers();
  assert(!(sendNow && stop));
  let held = false;
  let manager, gatewayServer, chat, fixtureError, jobId, step = 0, phase = "create";
  const prompt = "RELAY_LOOP_TICK: run node tick.mjs and report the actual counter.";
  const respond = async (request, response) => {
    if (request.url.includes("count_tokens")) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"input_tokens":100}'); return; }
    if (request.method !== "POST" || !/\/messages(?:\?|$)/.test(request.url)) { response.writeHead(404); response.end(); return; }
    assert.equal(request.headers["x-api-key"], "controller-only-loop-fixture");
    let raw = ""; for await (const part of request) raw += part;
    const body = JSON.parse(raw), text = JSON.stringify(body.messages), last = JSON.stringify(body.messages.findLast(message => message.role === "user"));
    let content;
    if (!body.tools?.length && last.includes("Write the title in the predominant language")) content = [{ type: "text", text: "Native loop fixture" }];
    else {
      requests.push(body); assert(requests.length <= 25, "Unexpected inference loop");
      const result = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === "tool_result").at(-1);
      const check = pattern => { assert(result); assert(!result.is_error, JSON.stringify(result)); if (pattern) assert.match(JSON.stringify(result.content), pattern); };
      const tool = (name, input) => [{ type: "tool_use", id: `loop_${requests.length}`, name, input }];
      const done = value => [{ type: "text", text: value }];
      if (process.argv.includes("--trace")) console.log("QUERY", phase, step, last.slice(-600));
      if (phase === "create") {
        if (step === 0) {
          assert.match(text, /schedule a recurring prompt/); assert.match(last, /RELAY_LOOP_TICK/);
          assert(body.tools.some(tool => tool.name === "CronCreate"));
          content = tool("CronCreate", { cron: "* * * * *", prompt, recurring: true, durable: false });
        } else if (step === 1) {
          check(); jobId = JSON.stringify(result.content).match(/\b[a-f0-9]{8}\b/)?.[0]; assert(jobId, JSON.stringify(result));
          content = tool("Bash", { command: "node tick.mjs", description: "Execute the first scheduled check now" });
        } else if (step === 2) { check(/counter.*1/); content = done(`Scheduled fixture ${jobId}; initial check returned counter 1.`); }
        else throw Error(`Unexpected create step ${step}`);
        step++;
      } else if (phase === "fire") {
        assert.match(text, /RELAY_LOOP_TICK/);
        if (sendNow && step === 0) { held = true; await release.promise; response.end(); return; }
        if (step === 0) content = tool("Bash", { command: "node tick.mjs", description: "Execute an actual native scheduled fire" });
        else { check(/counter.*2/); content = done("Scheduled fire completed with counter 2."); }
        step++;
      } else if (phase === "delete") {
        if (step === 0) content = tool("CronList", {});
        else if (step === 1) { check(new RegExp(jobId)); content = tool("CronDelete", { id: jobId }); }
        else if (step === 2) { check(new RegExp(jobId)); content = tool("CronList", {}); }
        else { check(); assert(!JSON.stringify(result.content).includes(jobId)); content = done("The fixture loop was cancelled; no scheduled jobs remain."); }
        step++;
      } else if (phase === "stopped") {
        assert.match(text, /initial check returned counter 1/);
        if (step === 0) content = tool("CronList", {});
        else if (step === 1) { check(new RegExp(jobId)); content = tool("CronDelete", { id: jobId }); }
        else if (step === 2) { check(new RegExp(jobId)); content = tool("CronList", {}); }
        else { check(/No scheduled jobs/); content = done("Stopped worker resumed its native schedule; cancellation confirmed."); }
        step++;
      } else if (phase === "resume") { assert.match(text, sendNow ? /fixture loop was cancelled/ : /Scheduled fire completed with counter 2/); content = done("Saved loop history retained after Stop."); }
      else throw Error(`Unexpected phase ${phase}`);
    }
    const message = { id: `msg_loop_${requests.length}`, type: "message", role: "assistant", model: body.model, content, stop_reason: content.some(block => block.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } };
    if (!body.stream) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(message)); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const block = content[0], tool = block.type === "tool_use";
    for (const event of [
      { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: tool ? { ...block, input: {} } : { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  };
  const server = http.createServer((request, response) => { void respond(request, response).catch(error => { fixtureError = error; response.writeHead(500); response.end(); void manager.stop(chat.id); }); });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const config = loadConfig({ AGENT_DATA_DIR: root, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", AGENT_IDLE_TIMEOUT_MS: "5000", CLAUDE_AUTH_MODE: "gateway", ANTHROPIC_API_KEY: "controller-only-loop-fixture" });
    const store = new ChatStore(root); await store.initialize(); const broker = new CapabilityBroker({ ttlMs: 120000 });
    const gateway = new ProviderGateway({ config, broker, fetchImpl: (url, options) => fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}${new URL(url).search}`, options) });
    gatewayServer = http.createServer((request, response) => { void gateway.handle(request, response, new URL(request.url, "http://fixture")); });
    await new Promise(resolve => gatewayServer.listen(0, "127.0.0.1", resolve));
    const gatewayOrigin = `http://127.0.0.1:${gatewayServer.address().port}`;
    const workerBackend = { sleep: async () => {}, shutdown: async () => {}, acquire: async current => ({
      workspace: current.workspace, runtimeHome: store.runtimeHome(current.id), metadata: { backend: "local" }, mkdir: directory => mkdir(directory, { recursive: true, mode: 0o700 }),
      spawn(command, args, options) {
        assert(!JSON.stringify([args, options.env]).includes(config.claude.providerKey));
        const child = spawnWorker(command, args, options);
        if (command === config.claude.bin && args.includes("--print")) {
          launches.push(child);
          if (process.argv.includes("--trace")) {
            let buffer = "";
            child.stdout.on("data", chunk => {
              buffer += chunk; const lines = buffer.split("\n"); buffer = lines.pop();
              for (const line of lines) {
                try {
                  const event = JSON.parse(line);
                  if (event.type === "command_lifecycle" || event.type === "user" || event.type === "system" && !["init", "status"].includes(event.subtype)) console.log("NATIVE", line.slice(0, 2000));
                } catch {}
              }
            });
          }
        }
        return child;
      },
    }) };
    manager = new RuntimeManager({ store, config, broker, gatewayOrigin, workerBackend, adapterFactory: params => new ClaudeAdapter({ ...params, store, config, broker, gatewayOrigin }) });
    chat = await manager.createChat({ agent: "claude", title: "Native loop fixture" });
    await manager.setMode(chat.id, "accept_edits");
    await mkdir(`${store.runtimeHome(chat.id)}/claude`, { recursive: true });
    await writeFile(`${store.runtimeHome(chat.id)}/claude/settings.json`, JSON.stringify({ permissions: { allow: ["Bash(node tick.mjs)"] } }));
    await writeFile(`${chat.workspace}/tick.mjs`, "import {readFile,writeFile} from 'node:fs/promises';\nlet counter=0;try{counter=JSON.parse(await readFile('.counter.json','utf8')).counter}catch{}\nconst value={counter:counter+1};await writeFile('.counter.json',JSON.stringify(value));console.log(JSON.stringify(value));\n");
    await manager.send(chat.id, `/loop 1m ${prompt}`); if (fixtureError) throw fixtureError;
    const session = store.get(chat.id).agentSessionId;
    assert.equal(JSON.parse(await readFile(`${chat.workspace}/.counter.json`, "utf8")).counter, 1);
    assert.equal(launches[0].exitCode, null, "The native scheduler must survive its initial reply");
    assert.equal(launches[0].signalCode, null, "The native scheduler must not be terminated after scheduling");
    if (stop) {
      await manager.stop(chat.id);
      assert.notEqual(launches[0].exitCode ?? launches[0].signalCode, null);
      phase = "stopped"; step = 0;
      await manager.send(chat.id, "Inspect scheduled tasks after explicit Stop without recreating them."); if (fixtureError) throw fixtureError;
      assert.equal(store.get(chat.id).agentSessionId, session); assert.equal(launches.length, 2);
      assert.equal(JSON.parse(await readFile(`${chat.workspace}/.counter.json`, "utf8")).counter, 1);
      assert.match(store.get(chat.id).messages.at(-1).text, /Stopped worker resumed its native schedule/);
      console.log(`PASS: explicit Stop terminates the worker; native list restores the saved schedule on resume and explicit delete cancels it, without replaying the counter write; ${requests.length} authored main replies.`);
    } else {
      phase = "fire"; step = 0;
      const deadline = Date.now() + 100000;
      while (!(sendNow ? held : !manager.isBusy(chat.id) && store.get(chat.id).messages.some(message => message.text?.includes("Scheduled fire completed with counter 2"))) && Date.now() < deadline) {
        if (fixtureError) throw fixtureError;
        assert.equal(launches[0].exitCode, null, "Idle timeout must not kill a pending native schedule");
        assert.equal(launches[0].signalCode, null); await delay(100);
      }
      if (sendNow) {
        assert(held, "The native scheduled turn must reach inference");
        assert.equal(manager.isBusy(chat.id), true, "A native scheduled turn must be busy and interruptible in Relay");
        assert.equal(store.get(chat.id).status, "running");
        await store.update(chat.id, { queuePaused: true });
        await manager.enqueue(chat.id, "Keep this unrelated queued input");
        const selected = await manager.enqueue(chat.id, "List and cancel the fixture loop, then verify the schedule is empty.");
        phase = "delete"; step = 0;
        await manager.sendQueuedNow(chat.id, selected.queuedMessages.at(-1).id); release.resolve();
        const done = Date.now() + 15000;
        while (manager.isBusy(chat.id) && Date.now() < done) await delay(25);
        assert.equal(manager.isBusy(chat.id), false);
        assert.deepEqual(store.get(chat.id).queuedMessages.map(item => item.text), ["Keep this unrelated queued input"]);
      } else {
        assert(store.get(chat.id).messages.some(message => message.role === "assistant" && message.text?.includes("Scheduled fire completed with counter 2")), "A real scheduled fire must become visible in the chat");
        phase = "delete"; step = 0;
        await manager.send(chat.id, "List and cancel the fixture loop, then verify the schedule is empty.");
      }
      if (fixtureError) throw fixtureError;
      assert.equal(JSON.parse(await readFile(`${chat.workspace}/.counter.json`, "utf8")).counter, sendNow ? 1 : 2);
      assert.equal(launches.length, 1); assert.equal(store.get(chat.id).agentSessionId, session);
      assert.match(store.get(chat.id).messages.at(-1).text, /no scheduled jobs remain/);
      await manager.stop(chat.id); phase = "resume";
      await manager.send(chat.id, "Continue from the saved loop history."); if (fixtureError) throw fixtureError;
      assert.equal(store.get(chat.id).agentSessionId, session); assert.equal(launches.length, 2);
      assert.match(store.get(chat.id).messages.at(-1).text, /Saved loop history retained/);
      console.log(`PASS: native loop creation, immediate execution, real timed fire, ${sendNow ? "Send now cancellation and queue preservation" : "visible background reply"}, list/delete, idle protection and Stop/resume; ${requests.length} authored main replies.`);
    }
  } finally {
    release.resolve();
    await manager?.shutdown(); server.closeAllConnections(); gatewayServer?.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), ...(gatewayServer ? [new Promise(resolve => gatewayServer.close(resolve))] : [])]);
    await rm(root, { recursive: true, force: true });
  }
}
