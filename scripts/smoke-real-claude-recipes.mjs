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
import { CommandCatalog } from "../src/command-catalog.mjs";
import { spawnWorker } from "../src/worker-process.mjs";

// Installed command/skill expansion and tools; only inference is authored.
// The generator writes its own driver/recipe through native approval. No
// fixture-side recipe creation, real accounts or external-network access.
const exec = promisify(execFile);
for (const argument of process.argv.slice(2)) assert(["--network-isolated", "--trace", "--deny", "--stop", "--send-now", "--plain-run"].includes(argument));
assert(process.argv.filter(value => ["--deny", "--stop", "--send-now"].includes(value)).length <= 1);
if (!process.argv.includes("--network-isolated")) {
  const result = await exec("/usr/bin/unshare", ["--user", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL", "--", process.execPath, process.argv[1], ...process.argv.slice(2), "--network-isolated"], { timeout: 120000, maxBuffer: 60000 }).catch(error => {
    process.stdout.write(error.stdout || ""); process.stderr.write(error.stderr || error.message); process.exit(1);
  });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); assert.match(result.stdout, /^PASS:/m);
} else {
  await exec("/usr/bin/ip", ["link", "set", "lo", "up"]);
  assert.deepEqual(JSON.parse((await exec("/usr/bin/ip", ["-j", "link", "show"])).stdout).map(item => item.ifname), ["lo"]);
  assert.equal((await exec("/usr/bin/ip", ["route", "show"])).stdout.trim(), "");
  const root = await mkdtemp("/tmp/relay-claude-recipes-"), main = [], launches = [], tasks = [];
  const deny = process.argv.includes("--deny"), stop = process.argv.includes("--stop"), sendNow = process.argv.includes("--send-now");
  const plainRun = process.argv.includes("--plain-run");
  const recipePath = ".claude/skills/run-fixture/SKILL.md", driverPath = ".claude/skills/run-fixture/driver.mjs";
  const recipe = `---\nname: run-fixture\ndescription: Launch and drive the fixture HTTP app with its verified driver\n---\nRELAY_GENERATED_RECIPE_CANARY\nAll paths are relative to the repository root. Node is the only dependency.\nStart the actual app if its .runtime.json endpoint is not reachable:\n\n\`\`\`sh\nnode server.mjs\n\`\`\`\n\nKeep that command in the background. Drive the running app with:\n\n\`\`\`sh\nnode ${driverPath}\n\`\`\`\n\nThe driver appends ação through HTTP, rejects an empty name with 400, and reads the result. The app's port is random; read .runtime.json rather than assuming port 3000. Stop the owning background task when explicitly requested.\n`;
  const driver = `import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
let url; const deadline=Date.now()+10000;
while (!url && Date.now()<deadline) {
  try { const {port}=JSON.parse(await readFile('.runtime.json','utf8')); const candidate='http://127.0.0.1:'+port; await fetch(candidate,{signal:AbortSignal.timeout(1000)}); url=candidate; }
  catch { await new Promise(resolve=>setTimeout(resolve,25)); }
}
assert(url,'The app must become reachable before driving it');
const created=await fetch(url,{method:'POST',body:JSON.stringify({name:'ação'})});assert.equal(created.status,201);
const invalid=await fetch(url,{method:'POST',body:'{}'});assert.equal(invalid.status,400);
const state=await (await fetch(url)).json();assert.equal(state.items.at(-1).name,'ação');
console.log(JSON.stringify({created:created.status,invalid:invalid.status,...state}));
`;
  let manager, gatewayServer, chat, fixtureError, shutdown, phase = "generate", step = 0, titles = 0, taskId, expectedResume;
  const respond = async (request, response) => {
    if (request.url.includes("count_tokens")) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"input_tokens":100}'); return; }
    if (request.method !== "POST" || !/\/messages(?:\?|$)/.test(request.url)) { response.writeHead(404); response.end(); return; }
    assert.equal(request.headers["x-api-key"], "controller-only-recipes-fixture");
    let raw = ""; for await (const part of request) raw += part;
    const body = JSON.parse(raw), text = JSON.stringify(body.messages), last = JSON.stringify(body.messages.findLast(message => message.role === "user"));
    const title = !body.tools?.length && last.includes("Write the title in the predominant language");
    let content;
    if (title) { titles++; content = [{ type: "text", text: "Generated application recipe" }]; }
    else {
      assert(body.tools?.some(tool => tool.name === "Bash"), "Unknown auxiliary query");
      main.push(body); assert(main.length <= 35, "Unexpected native query loop");
      const results = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === "tool_result");
      const result = results.at(-1), check = pattern => { assert(result); assert(!result.is_error, JSON.stringify(result)); if (pattern) assert.match(JSON.stringify(result), pattern); };
      const tool = (name, input) => [{ type: "tool_use", id: `recipe_${main.length}`, name, input }];
      const done = text => [{ type: "text", text }];
      if (phase === "generate") {
        if (step === 0) { assert.match(last, /Your job is to produce a/); assert.match(last, /run-skill-generator/); content = tool("Read", { file_path: `${chat.workspace}/package.json` }); }
        else if (step === 1) { check(/relay-recipe-fixture/); content = tool("Read", { file_path: `${chat.workspace}/server.mjs` }); }
        else if (step === 2) { check(/items/); content = tool("Bash", { command: "node server.mjs", run_in_background: true, description: "Launch the real disposable HTTP app" }); }
        else if (step === 3) { check(); assert(taskId, "Native Bash must report its background task"); content = tool("Write", { file_path: `${chat.workspace}/${driverPath}`, content: driver }); }
        else if (step === 4) {
          if (deny) { assert.equal(result.is_error, true); content = tool("TaskStop", { task_id: taskId }); }
          else { check(); content = tool("Bash", { command: `node ${driverPath}`, description: "Drive the real app before documenting any recipe" }); }
        } else if (step === 5) {
          check(deny ? undefined : /"?(created|invalid)/);
          content = deny ? done("Recipe creation was denied; neither the driver nor the skill was saved.") : tool("TaskStop", { task_id: taskId });
        } else if (step === 6) { check(); content = tool("Write", { file_path: `${chat.workspace}/${recipePath}`, content: recipe }); }
        else if (step === 7) { check(); content = done("The verified driver and run-fixture recipe were saved after explicit approval."); }
        else throw Error(`Unexpected generation step ${step}`);
      } else if (phase === "direct") {
        if (step === 0) { assert.match(last, plainRun ? /Start the actual app using the driver you just generated/ : /RELAY_GENERATED_RECIPE_CANARY/); content = tool("Bash", { command: "node server.mjs", run_in_background: true, description: "Launch through the generated project skill" }); }
        else if (step === 1) { check(); content = tool("Bash", { command: `node ${driverPath}`, description: "Use the generated driver through the native tool" }); }
        else if (step === 2) { check(/ação/); content = done("The generated recipe started and drove the actual app; it remains running."); }
        else throw Error(`Unexpected direct skill step ${step}`);
      } else if (phase === "run") {
        if (step === 0) { assert.match(last, /Running means launching the actual app/); content = tool("Skill", { skill: "run-fixture", args: "Reuse the existing HTTP application and run its driver." }); }
        else if (step === 1) { assert.match(last, /RELAY_GENERATED_RECIPE_CANARY/); content = tool("Bash", { command: `node ${driverPath}`, description: "Reuse the project recipe without replacing the app" }); }
        else if (step === 2) { check(/ação/); content = done("The bundled run command reused the generated recipe and the same HTTP app."); }
        else throw Error(`Unexpected run step ${step}`);
      } else if (phase === "verify") {
        if (step === 0) { assert.match(last, /## Surface/); content = tool("Read", { file_path: `${chat.workspace}/${recipePath}` }); }
        else if (step === 1) { check(/RELAY_GENERATED_RECIPE_CANARY/); content = tool("Bash", { command: `node ${driverPath}`, description: "Verify actual valid and invalid HTTP requests" }); }
        else if (step === 2) { check(/ação/); content = done("PASS: actual HTTP creation returned 201, invalid input 400, and the item was readable from the running app."); }
        else throw Error(`Unexpected verification step ${step}`);
      } else if (phase === "resume") {
        assert.equal(step, 0); assert(last.includes(expectedResume)); assert(text.includes("Author a run-fixture recipe"));
        content = done("Saved generator context retained without replaying any writes or launching the app.");
      } else throw Error(`Unknown phase ${phase}`);
      step++;
    }
    if (process.argv.includes("--trace")) console.log(JSON.stringify({ phase, step, title, model: body.model }));
    const block = content[0], tool = block.type === "tool_use";
    const message = { id: `msg_recipe_${main.length + titles}`, type: "message", role: "assistant", model: body.model, content, stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } };
    if (!body.stream) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(message)); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: tool ? { ...block, input: {} } : { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } }, { type: "message_stop" },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  };
  const server = http.createServer((request, response) => { void respond(request, response).catch(error => {
    fixtureError ||= error; if (!response.headersSent) response.writeHead(500); response.end(); shutdown ||= manager?.shutdown();
  }); });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const config = loadConfig({ AGENT_DATA_DIR: root, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", AGENT_IDLE_TIMEOUT_MS: "60000", CLAUDE_AUTH_MODE: "gateway", ANTHROPIC_API_KEY: "controller-only-recipes-fixture" });
    const store = new ChatStore(root); await store.initialize(); const broker = new CapabilityBroker({ ttlMs: 180000 });
    const gateway = new ProviderGateway({ config, broker, fetchImpl: (url, options) => fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}${new URL(url).search}`, options) });
    gatewayServer = http.createServer((request, response) => { void gateway.handle(request, response, new URL(request.url, "http://fixture")); });
    await new Promise(resolve => gatewayServer.listen(0, "127.0.0.1", resolve));
    const gatewayOrigin = `http://127.0.0.1:${gatewayServer.address().port}`;
    const workerBackend = { sleep: async () => {}, shutdown: async () => {}, acquire: async current => ({
      workspace: current.workspace, runtimeHome: store.runtimeHome(current.id), metadata: { backend: "local" },
      mkdir: directory => mkdir(directory, { recursive: true, mode: 0o700 }),
      spawn(bin, args, options) {
        assert(!JSON.stringify([args, options.env]).includes(config.claude.providerKey));
        if (bin === config.claude.bin && args.includes("--print")) launches.push(args);
        const child = spawnWorker(bin, args, options); let raw = "";
        child.stdout.on("data", chunk => { raw += chunk; const lines = raw.split("\n"); raw = lines.pop(); for (const line of lines) { try {
          const event = JSON.parse(line);
          if (event.type === "system" && event.subtype === "task_started") { tasks.push(event); taskId = event.task_id; if (process.argv.includes("--trace")) console.log(JSON.stringify({ nativeTask: event })); }
        } catch {} } }); return child;
      },
    }) };
    const commands = new CommandCatalog(config);
    manager = new RuntimeManager({ store, config, broker, gatewayOrigin, workerBackend, commands, adapterFactory: params => new ClaudeAdapter({ ...params, store, config, broker, gatewayOrigin }) });
    chat = await manager.createChat({ agent: "claude", title: "Generated native project recipe" }); await manager.setMode(chat.id, "accept_edits");
    await writeFile(`${chat.workspace}/package.json`, '{"name":"relay-recipe-fixture","type":"module","scripts":{"start":"node server.mjs"}}');
    await writeFile(`${chat.workspace}/server.mjs`, `import http from 'node:http';\nimport {writeFile} from 'node:fs/promises';\nconst items=[];\nconst server=http.createServer(async(req,res)=>{res.setHeader('content-type','application/json');if(req.method==='POST'){let raw='';for await(const part of req)raw+=part;const item=JSON.parse(raw);if(!item.name){res.statusCode=400;return res.end(JSON.stringify({error:'name_required'}));}items.push(item);res.statusCode=201;}res.end(JSON.stringify({pid:process.pid,items}));});\nserver.listen(0,'127.0.0.1',async()=>{await writeFile('.runtime.json',JSON.stringify({port:server.address().port,pid:process.pid}));console.log('Fixture HTTP ready');});\n`);
    const settings = { permissions: { allow: ["Bash(node server.mjs)", `Bash(node ${driverPath})`] } };
    await mkdir(`${store.runtimeHome(chat.id)}/claude`, { recursive: true });
    await writeFile(`${store.runtimeHome(chat.id)}/claude/settings.json`, JSON.stringify(settings));
    const until = async predicate => {
      const deadline = Date.now() + 20000;
      while (!predicate() && !fixtureError && Date.now() < deadline) await delay(25);
      if (fixtureError) throw fixtureError; assert(predicate(), `Timed out in ${phase}/${step}`);
    };
    const runtime = async () => JSON.parse(await readFile(`${chat.workspace}/.runtime.json`, "utf8"));
    const state = async () => (await fetch(`http://127.0.0.1:${(await runtime()).port}`, { signal: AbortSignal.timeout(2000) })).json();
    const ready = async () => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) { try { return await state(); } catch { await delay(25); } }
      return state();
    };
    const generation = manager.send(chat.id, "/run-skill-generator Author a run-fixture recipe and its driver after actually driving this HTTP app. Do not commit or push.");
    await until(() => Boolean(store.get(chat.id).pendingRequest));
    const first = store.get(chat.id).pendingRequest;
    assert.equal(JSON.parse(first.command).file_path, `${chat.workspace}/${driverPath}`);
    await assert.rejects(readFile(`${chat.workspace}/${driverPath}`), { code: "ENOENT" });
    const initial = await ready(), session = store.get(chat.id).agentSessionId;
    if (stop || sendNow) {
      await manager.enqueue(chat.id, "Retain this unselected task"); await store.update(chat.id, { queuePaused: true });
      if (stop) await manager.stop(chat.id);
      else {
        phase = "resume"; step = 0; expectedResume = "Keep the app running without creating the canceled recipe.";
        const queued = await manager.enqueue(chat.id, expectedResume);
        await manager.sendQueuedNow(chat.id, queued.queuedMessages.at(-1).id);
        await until(() => !manager.isBusy(chat.id)); assert.equal(step, 1);
        assert.deepEqual(await state(), initial);
      }
      await generation; await assert.rejects(manager.respond(chat.id, first.requestId, { decision: "accept" }));
    } else {
      await manager.respond(chat.id, first.requestId, { decision: deny ? "decline" : "accept" });
      if (!deny) {
        await until(() => Boolean(store.get(chat.id).pendingRequest)); const second = store.get(chat.id).pendingRequest;
        assert.equal(JSON.parse(second.command).file_path, `${chat.workspace}/${recipePath}`);
        assert.equal(await readFile(`${chat.workspace}/${driverPath}`, "utf8"), driver);
        await manager.respond(chat.id, second.requestId, { decision: "accept" });
      }
      await generation; if (fixtureError) throw fixtureError;
      assert.equal(store.get(chat.id).agentSessionId, session);
    }
    if (deny || stop || sendNow) {
      await assert.rejects(readFile(`${chat.workspace}/${driverPath}`), { code: "ENOENT" });
      await assert.rejects(readFile(`${chat.workspace}/${recipePath}`), { code: "ENOENT" });
    } else {
      assert.equal(await readFile(`${chat.workspace}/${recipePath}`, "utf8"), recipe);
      await assert.rejects(state(), "Generator must stop its verification app cleanly");
      await manager.stop(chat.id);
      await manager.send(chat.id, "/reload-skills");
      assert((await commands.list(store.get(chat.id))).commands.some(command => command.name === "run-fixture"), "The generated skill must be discoverable");
      phase = "direct"; step = 0; await manager.send(chat.id, plainRun ? "Start the actual app using the driver you just generated." : "/run-fixture Start and drive the app using the saved recipe."); if (fixtureError) throw fixtureError;
      const directState = await state(), retainedLaunches = launches.length;
      assert.deepEqual(directState.items, [{ name: "ação" }]); assert.notEqual(directState.pid, initial.pid);
      for (const [nextPhase, command] of [["run", "/run Reuse this project's generated recipe and its running app."], ["verify", "/verify Exercise the real HTTP input validation with the generated driver."]]) {
        phase = nextPhase; step = 0; await manager.send(chat.id, command); if (fixtureError) throw fixtureError;
        assert.equal((await state()).pid, directState.pid); assert.equal(launches.length, retainedLaunches);
      }
      assert.equal((await state()).items.length, 3);
      assert.equal(await readFile(`${chat.workspace}/${recipePath}`, "utf8"), recipe);
      assert.equal(await readFile(`${chat.workspace}/${driverPath}`, "utf8"), driver);
    }
    assert.equal(tasks.length, deny || stop || sendNow ? 1 : 2);
    await manager.stop(chat.id); await assert.rejects(state());
    phase = "resume"; step = 0; expectedResume = "Continue from the saved generator context without relaunching anything.";
    await manager.send(chat.id, expectedResume); if (fixtureError) throw fixtureError;
    assert.equal(store.get(chat.id).agentSessionId, session); await assert.rejects(state());
    assert.deepEqual(JSON.parse(await readFile(`${store.runtimeHome(chat.id)}/claude/settings.json`, "utf8")), settings);
    if (stop || sendNow) assert.deepEqual(store.get(chat.id).queuedMessages.map(item => item.text), ["Retain this unselected task"]);
    console.log(`PASS: native recipe ${deny ? "denial" : stop ? "Stop cancellation" : sendNow ? "Send now cancellation" : `generation, driver execution, discovery, ${plainRun ? "ordinary app launch" : "direct skill"}, run and verify`}; real HTTP effects, permissions and same-history Stop/resume. ${main.length} main and ${titles} title loopback replies.`);
  } finally {
    await shutdown; await manager?.shutdown(); server.closeAllConnections(); gatewayServer?.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), ...(gatewayServer ? [new Promise(resolve => gatewayServer.close(resolve))] : [])]);
    await rm(root, { recursive: true, force: true });
  }
}
