import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { loadConfig } from "../src/config.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { ProviderGateway } from "../src/provider-gateway.mjs";
import { spawnWorker } from "../src/worker-process.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { ModelCatalog } from "../src/models.mjs";

// Installed Claude and a disposable HTTP application. The model is authored;
// the native tools, application process and requests are real and loopback-only.
const exec = promisify(execFile);
const options = new Set(["--network-isolated", "--trace", "--background-exit", "--send-now", "--first-send-now", "--approve-recipe", "--questions", "--skip-questions", "--stop-approval"]);
for (const argument of process.argv.slice(2)) assert(options.has(argument), `Unsupported fixture option: ${argument}`);
if (!process.argv.includes("--network-isolated")) {
  const result = await exec("/usr/bin/unshare", ["--user", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL", "--", process.execPath, process.argv[1], ...process.argv.slice(2), "--network-isolated"], { timeout: 90000, maxBuffer: 60000 }).catch(error => {
    process.stdout.write(error.stdout || ""); process.stderr.write(error.stderr || error.message); process.exit(1);
  });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  assert.match(result.stdout, /^PASS:/m);
} else {
  await exec("/usr/bin/ip", ["link", "set", "lo", "up"]);
  assert.deepEqual(JSON.parse((await exec("/usr/bin/ip", ["-j", "link", "show"])).stdout).map(item => item.ifname), ["lo"]);
  assert.equal((await exec("/usr/bin/ip", ["route", "show"])).stdout.trim(), "");
  const root = await mkdtemp("/tmp/relay-claude-run-"), requests = [];
  const backgroundExit = process.argv.includes("--background-exit"), firstSendNow = process.argv.includes("--first-send-now"), sendNow = firstSendNow || process.argv.includes("--send-now");
  const approveRecipe = process.argv.includes("--approve-recipe");
  const stopApproval = process.argv.includes("--stop-approval"), skipQuestions = process.argv.includes("--skip-questions");
  const askQuestions = skipQuestions || process.argv.includes("--questions");
  const held = Promise.withResolvers(), release = Promise.withResolvers();
  const recipe = "---\nname: verify\ndescription: Drive the fixture HTTP app\ndisable-model-invocation: true\n---\nRELAY_HTTP_RECIPE_CANARY\nRead package.json. Start node server.mjs in the background if .runtime.json is not reachable. Run node verify.mjs to probe the actual HTTP route. Report response statuses and bodies.\n";
  let manager, gatewayServer, chat, fixtureError, failureStop, nativeSession, phase = "run", step = 0, titleRequests = 0;
  const respond = async (request, response) => {
    if (request.url.includes("count_tokens")) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"input_tokens":100}'); return; }
    if (request.method !== "POST" || !/\/messages(?:\?|$)/.test(request.url)) { response.writeHead(404); response.end(); return; }
    assert.equal(request.headers["x-api-key"], "controller-only-run-fixture");
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw), index = requests.push(body);
    assert(index <= 20, "Unexpected native workflow request loop");
    const titleRequest = !body.tools?.length && JSON.stringify(body.messages.at(-1)).includes("Write the title in the predominant language");
    if (phase === "held" && !titleRequest || firstSendNow && phase === "run" && step === 3) { held.resolve(); await release.promise; if (!response.destroyed) response.end(); return; }
    let content;
    if (titleRequest) {
      titleRequests++;
      content = [{ type: "text", text: "Fixture application verification" }];
    } else if (phase === "background") {
      content = [{ type: "text", text: "The fixture HTTP server stopped." }];
    } else {
      const text = JSON.stringify(body.messages);
      const results = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === "tool_result");
      const tool = (name, input) => [{ type: "tool_use", id: `tool_run_${index}`, name, input }];
      if (phase === "resume") {
        assert(text.includes("Start the HTTP app and create an item titled ação."), "Stop/resume must retain the original native application context");
        if (askQuestions && step === 0) {
          assert(body.tools.some(tool => tool.name === "AskUserQuestion"), "Interactive native questions must be available");
          content = tool("AskUserQuestion", { questions: [
            { question: "Which sections?", header: "Sections", multiSelect: true, options: [{ label: "Intro", description: "Include the introduction" }, { label: "Conclusion", description: "Include the conclusion" }] },
            { question: "Which name?", header: "Name", multiSelect: false, options: [{ label: "Fixture", description: "Use the fixture name" }, { label: "Sample", description: "Use the sample name" }] },
          ] });
        } else {
          if (askQuestions) {
            assert.equal(step, 1); assert.equal(results.at(-1).is_error === true, skipQuestions, JSON.stringify(results.at(-1)));
            if (skipQuestions) assert.match(JSON.stringify(results.at(-1)), /skipped/);
            else { assert.match(JSON.stringify(results.at(-1)), /Intro, Conclusion/); assert.match(JSON.stringify(results.at(-1)), /ação/); }
          }
          content = [{ type: "text", text: "Saved application context retained after Stop; the server has not been restarted." }];
        }
      } else if (phase === "continue") {
        assert(text.includes("Verify now without stopping the app"), "The native query must include the selected follow-up");
        if (step === 0) content = tool("Bash", { command: "node verify.mjs", description: "Drive the same app after Send now interrupted the previous query" });
        else if (step === 1) {
          assert(!results.at(-1).is_error); assert.match(JSON.stringify(results.at(-1)), /title_required/);
          content = [{ type: "text", text: "Send now retained the original running application and its data." }];
        } else throw Error(`Unexpected continuation step ${step}`);
      } else if (phase === "verify") {
        if (step === 0) {
          assert.match(text, /## Surface/); assert.match(text, /## Push on it/);
          content = tool("Bash", { command: "git diff -- server.mjs", description: "Inspect the actual route-validation change" });
        } else if (step === 1) {
          assert(!results.at(-1).is_error); assert.match(JSON.stringify(results.at(-1)), /title_required/);
          content = tool("Bash", { command: "ls .claude/skills", description: "Check for an existing project verification recipe" });
        } else if (step === 2) {
          assert(!results.at(-1).is_error, JSON.stringify(results.at(-1)));
          content = tool("Bash", { command: "node verify.mjs", description: "Probe actual HTTP validation and retained item state" });
        } else if (step === 3) {
          assert(!results.at(-1).is_error); assert.match(JSON.stringify(results.at(-1)), /title_required/); assert.match(JSON.stringify(results.at(-1)), /invalid_json/); assert.match(JSON.stringify(results.at(-1)), /400/);
          content = tool("Write", { file_path: `${chat.workspace}/.claude/skills/verify/SKILL.md`, content: recipe });
        } else if (step === 4) {
          assert.equal(results.at(-1).is_error === true, !approveRecipe, JSON.stringify(results.at(-1)));
          if (!approveRecipe) assert.match(JSON.stringify(results.at(-1)), /user denied/i);
          content = [{ type: "text", text: `PASS: actual POST /items rejected an empty title and malformed JSON with status 400; GET /items retained ação. ${approveRecipe ? "The explicitly approved recipe was saved." : "The user denied recipe creation; no recipe was saved."}` }];
        } else throw Error(`Unexpected verify step ${step}`);
      } else if (phase === "recipe") {
        if (step === 0) {
          assert.match(text, /RELAY_HTTP_RECIPE_CANARY/); assert.match(body.model, /haiku/);
          content = tool("Bash", { command: "node verify.mjs", description: "Repeat verification using the saved native recipe" });
        } else if (step === 1) {
          assert(!results.at(-1).is_error); assert.match(JSON.stringify(results.at(-1)), /title_required/);
          content = [{ type: "text", text: "Saved recipe reused; the real HTTP responses still match." }];
        } else throw Error(`Unexpected recipe step ${step}`);
      } else if (step === 0) {
        assert.match(text, /Running means launching the actual app/);
        content = tool("Read", { file_path: `${chat.workspace}/package.json` });
      }
      else if (step === 1) {
        assert(!results.at(-1).is_error); assert.match(JSON.stringify(results.at(-1)), /relay-run-fixture/);
        content = tool("Bash", { command: "node server.mjs", description: "Start the disposable HTTP application", run_in_background: true });
      } else if (step === 2) {
        assert(!results.at(-1).is_error);
        content = tool("Bash", { command: "node drive.mjs", description: "Create and read an item through the running application" });
      } else if (step === 3) {
        assert(!results.at(-1).is_error, JSON.stringify(results.at(-1))); assert.match(JSON.stringify(results.at(-1)), /201/); assert.match(JSON.stringify(results.at(-1)), /ação/);
        content = [{ type: "text", text: "The actual HTTP application created ação with status 201 and returned it through GET /items." }];
      } else throw Error(`Unexpected ${phase} step ${step}`);
      step++;
    }
    const message = { id: `msg_run_${index}`, type: "message", role: "assistant", model: body.model, content, stop_reason: content[0].type === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } };
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
  const server = http.createServer((request, response) => { void respond(request, response).catch(error => {
    console.error(`Fixture ${phase}/${step}: ${error.message.slice(0, 1500)}`);
    fixtureError = error; response.writeHead(500); response.end(); failureStop = manager.stop(chat.id);
  }); });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const config = loadConfig({ AGENT_DATA_DIR: root, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", AGENT_IDLE_TIMEOUT_MS: "60000", CLAUDE_AUTH_MODE: "gateway", ANTHROPIC_API_KEY: "controller-only-run-fixture" });
    const store = new ChatStore(root); await store.initialize(); const broker = new CapabilityBroker({ ttlMs: 120000 });
    const gateway = new ProviderGateway({ config, broker, fetchImpl: (url, options) => fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}${new URL(url).search}`, options) });
    gatewayServer = http.createServer((request, response) => { void gateway.handle(request, response, new URL(request.url, "http://fixture")); });
    await new Promise(resolve => gatewayServer.listen(0, "127.0.0.1", resolve));
    const gatewayOrigin = `http://127.0.0.1:${gatewayServer.address().port}`;
    const workerBackend = { sleep: async () => {}, shutdown: async () => {}, acquire: async current => ({
      workspace: current.workspace, runtimeHome: store.runtimeHome(current.id), metadata: { backend: "local" },
      mkdir: directory => mkdir(directory, { recursive: true, mode: 0o700 }),
      spawn(command, args, options) {
        assert(!JSON.stringify([args, options.env]).includes(config.claude.providerKey));
        if (args.includes("--session-id")) nativeSession = args[args.indexOf("--session-id") + 1];
        const child = spawnWorker(command, args, options);
        if (process.argv.includes("--trace")) {
          let buffer = ""; child.stdout.on("data", chunk => {
            buffer += chunk; const lines = buffer.split("\n"); buffer = lines.pop();
            for (const line of lines) { try { const event = JSON.parse(line); if (event.type === "command_lifecycle") console.log(JSON.stringify({ phase, lifecycle: event })); else if (event.type === "result") console.log(JSON.stringify({ phase, subtype: event.subtype, usage: event.usage, models: event.modelUsage, cost: event.total_cost_usd })); } catch {} }
          });
        }
        return child;
      },
    }) };
    manager = new RuntimeManager({ store, config, broker, gatewayOrigin, workerBackend, models: new ModelCatalog(config), adapterFactory: params => new ClaudeAdapter({ ...params, store, config, broker, gatewayOrigin }) });
    chat = await manager.createChat({ agent: "claude", title: "Native run and verify fixture" });
    await manager.setMode(chat.id, "accept_edits");
    await manager.setModel(chat.id, { model: "sonnet", effort: "high" });
    await writeFile(`${chat.workspace}/package.json`, JSON.stringify({ name: "relay-run-fixture", type: "module", scripts: { start: "node server.mjs" } }));
    const original = `import http from 'node:http';
import {writeFile} from 'node:fs/promises';
const items = [];
const server = http.createServer(async (req,res) => {
  res.setHeader('content-type','application/json');
  if (req.url === '/items' && req.method === 'GET') return res.end(JSON.stringify(items));
  if (req.url === '/items' && req.method === 'POST') {
    let text = ''; for await (const part of req) text += part;
    const item = JSON.parse(text); items.push(item); res.statusCode = 201; return res.end(JSON.stringify(item));
  }
  res.statusCode = 404; res.end('{}');
});
server.listen(0,'127.0.0.1', async () => { await writeFile('.runtime.json',JSON.stringify({port:server.address().port,pid:process.pid})); console.log('Fixture HTTP application listening'); });
`;
    await writeFile(`${chat.workspace}/server.mjs`, original);
    const env = { HOME: root, PATH: process.env.PATH, LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    await exec("git", ["-C", chat.workspace, "add", "server.mjs", "package.json"], { env });
    await exec("git", ["-C", chat.workspace, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "Fixture route baseline"], { env });
    const changed = original.replace("const item = JSON.parse(text);", "let item; try { item = JSON.parse(text); } catch { res.statusCode=400; return res.end(JSON.stringify({error:'invalid_json'})); }\n    if (typeof item.title !== 'string' || !item.title.trim()) { res.statusCode=400; return res.end(JSON.stringify({error:'title_required'})); }");
    await writeFile(`${chat.workspace}/server.mjs`, changed);
    await writeFile(`${chat.workspace}/drive.mjs`, `import {readFile} from 'node:fs/promises';
let runtime; const deadline=Date.now()+10000;
while (!runtime && Date.now()<deadline) { try { runtime=JSON.parse(await readFile('.runtime.json','utf8')); } catch { await new Promise(resolve=>setTimeout(resolve,25)); } }
if (!runtime) throw Error('Application did not become ready');
const {port} = runtime;
const origin = 'http://127.0.0.1:' + port;
const created = await fetch(origin+'/items',{method:'POST',body:JSON.stringify({title:'ação'})});
const items = await (await fetch(origin+'/items')).json();
console.log(JSON.stringify({created:created.status,items}));
`);
    await writeFile(`${chat.workspace}/verify.mjs`, `import {readFile} from 'node:fs/promises';
const {port} = JSON.parse(await readFile('.runtime.json','utf8'));
const origin = 'http://127.0.0.1:' + port, responses=[];
for (const body of ['{}','{invalid']) { const result=await fetch(origin+'/items',{method:'POST',body}); responses.push({status:result.status,body:await result.json()}); }
responses.push({items:await (await fetch(origin+'/items')).json()}); console.log(JSON.stringify(responses));
`);
    await mkdir(`${chat.workspace}/.claude/skills`, { recursive: true });
    await mkdir(`${store.runtimeHome(chat.id)}/claude`, { recursive: true });
    await writeFile(`${store.runtimeHome(chat.id)}/claude/settings.json`, JSON.stringify({ permissions: { allow: ["Bash(node server.mjs)", "Bash(node drive.mjs)", "Bash(node verify.mjs)"] } }));
    const firstRun = manager.send(chat.id, "/run Start the HTTP app and create an item titled ação.");
    if (firstSendNow) {
      let timer;
      try { await Promise.race([held.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("First native run query was not reached")), 15000); })]); }
      finally { clearTimeout(timer); }
      assert.equal(store.get(chat.id).agentSessionId, null, "No native result has checkpointed the first run yet");
    } else await firstRun;
    if (fixtureError) throw fixtureError;
    assert.deepEqual(store.get(chat.id).messages.filter(message => message.kind === "error").map(message => message.text), []);
    const session = firstSendNow ? nativeSession : store.get(chat.id).agentSessionId;
    const { port, pid } = JSON.parse(await readFile(`${chat.workspace}/.runtime.json`, "utf8"));
      const items = await (await fetch(`http://127.0.0.1:${port}/items`, { signal: AbortSignal.timeout(3000) })).json();
      assert.deepEqual(items, [{ title: "ação" }]);
      if (!firstSendNow) assert.match(store.get(chat.id).messages.at(-1).text, /actual HTTP application/);
    if (sendNow) {
      phase = "held";
      const running = firstSendNow ? firstRun : manager.send(chat.id, "Wait while I choose which message to send now."); let timer;
      try {
        await Promise.race([held.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Native held query was not reached")), 15000); })]);
        await manager.enqueue(chat.id, "Retain this follow-up"); await store.update(chat.id, { queuePaused: true });
        const queued = await manager.enqueue(chat.id, "Verify now without stopping the app");
        phase = "continue"; step = 0;
        await manager.sendQueuedNow(chat.id, queued.queuedMessages.at(-1).id).catch(error => { throw fixtureError || error; }); await running;
        const deadline = Date.now() + 15000;
        while (manager.isBusy(chat.id) && Date.now() < deadline) await delay(25);
        if (fixtureError) throw fixtureError;
        assert.equal(manager.isBusy(chat.id), false); assert.equal(store.get(chat.id).agentSessionId, session);
        assert.match(store.get(chat.id).messages.at(-1).text, /Send now retained/);
        assert.deepEqual(store.get(chat.id).queuedMessages.map(item => item.text), ["Retain this follow-up"]);
        assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/items`)).json(), items);
        assert.equal(requests.length, (firstSendNow ? 6 : 7) + titleRequests);
        assert.equal(store.get(chat.id).usage.totals.inputTokens, (requests.length - 1) * 100);
        assert.equal(store.get(chat.id).usage.totals.outputTokens, (requests.length - 1) * 10);
        await manager.stop(chat.id);
        await assert.rejects(fetch(`http://127.0.0.1:${port}/items`, { signal: AbortSignal.timeout(3000) }));
      } finally { clearTimeout(timer); release.resolve(); }
    } else if (backgroundExit) {
      const userMessages = store.get(chat.id).messages.filter(message => message.role === "user");
      phase = "background"; process.kill(pid, "SIGTERM");
      const deadline = Date.now() + 15000;
      while (!store.get(chat.id).messages.some(message => message.text === "The fixture HTTP server stopped.") && Date.now() < deadline) await delay(25);
      if (fixtureError) throw fixtureError;
      assert.equal(requests.length, 5);
      assert.equal(store.get(chat.id).messages.filter(message => message.text === "The fixture HTTP server stopped." && message.role === "assistant").length, 1);
      assert.deepEqual(store.get(chat.id).messages.filter(message => message.role === "user"), userMessages);
      assert.equal(store.get(chat.id).usage.totals.inputTokens, 500);
      assert.equal(store.get(chat.id).usage.totals.outputTokens, 50);
      await manager.stop(chat.id);
    } else {
      phase = "verify"; step = 0;
      const verification = manager.send(chat.id, "/verify Check the new POST /items validation and preserved item listing.");
      const deadline = Date.now() + 15000;
      while (!store.get(chat.id).pendingRequest && !fixtureError && Date.now() < deadline) await delay(25);
      if (fixtureError) throw fixtureError;
      const approval = store.get(chat.id).pendingRequest;
      assert(approval, "The actual native tool must ask before writing its protected recipe");
      assert.equal(approval.method, "claude/tool/requestApproval");
      assert.deepEqual(approval.availableDecisions, ["accept", "decline"]);
      assert.match(approval.command, /\.claude\/skills\/verify\/SKILL.md/);
      await assert.rejects(readFile(`${chat.workspace}/.claude/skills/verify/SKILL.md`, "utf8"), { code: "ENOENT" });
      await assert.rejects(manager.respond(chat.id, approval.requestId, { decision: "acceptForSession" }), /not available/);
      if (stopApproval) {
        await manager.enqueue(chat.id, "Retain this task after the approval is canceled");
        await store.update(chat.id, { queuePaused: true });
        await manager.stop(chat.id); await verification;
        await assert.rejects(manager.respond(chat.id, approval.requestId, { decision: "accept" }), /not active|no longer active/);
        assert.equal(store.get(chat.id).pendingRequest, null);
        assert.deepEqual(store.get(chat.id).queuedMessages.map(item => item.text), ["Retain this task after the approval is canceled"]);
        await assert.rejects(readFile(`${chat.workspace}/.claude/skills/verify/SKILL.md`, "utf8"), { code: "ENOENT" });
      } else {
        await manager.respond(chat.id, approval.requestId, { decision: approveRecipe ? "accept" : "decline" });
        await verification; if (fixtureError) throw fixtureError;
        await assert.rejects(manager.respond(chat.id, approval.requestId, { decision: "accept" }), /no longer active/);
        assert.match(store.get(chat.id).messages.at(-1).text, /PASS: actual POST/);
        if (approveRecipe) assert.equal(await readFile(`${chat.workspace}/.claude/skills/verify/SKILL.md`, "utf8"), recipe);
        else await assert.rejects(readFile(`${chat.workspace}/.claude/skills/verify/SKILL.md`, "utf8"), { code: "ENOENT" });
        assert.equal(store.get(chat.id).agentSessionId, session);
        // In the denial variant only, separately install a user-authored
        // fixture recipe. That variant proves reuse, not native creation.
        if (!approveRecipe) {
          await mkdir(`${chat.workspace}/.claude/skills/verify`, { recursive: true });
          await writeFile(`${chat.workspace}/.claude/skills/verify/SKILL.md`, recipe);
        }
        phase = "recipe"; step = 0;
        await manager.send(chat.id, "/reload-skills");
        await manager.setModel(chat.id, { model: "haiku", effort: null });
        await manager.send(chat.id, "/verify Recheck using the saved recipe."); if (fixtureError) throw fixtureError;
        assert.match(store.get(chat.id).messages.at(-1).text, /Saved recipe reused/);
        assert.equal(store.get(chat.id).agentSessionId, session);
        assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/items`)).json(), items);
        assert.equal(store.get(chat.id).usage.totals.inputTokens, requests.length * 100);
        assert.equal(store.get(chat.id).usage.totals.outputTokens, requests.length * 10);
        await manager.stop(chat.id);
      }
      await assert.rejects(fetch(`http://127.0.0.1:${port}/items`, { signal: AbortSignal.timeout(3000) }));
    }
    phase = "resume"; step = 0;
    const resumed = manager.send(chat.id, "Continue from the saved application context without restarting the server.");
    if (askQuestions) {
      const deadline = Date.now() + 15000;
      while (!store.get(chat.id).pendingRequest && !fixtureError && Date.now() < deadline) await delay(25);
      if (fixtureError) throw fixtureError;
      const request = store.get(chat.id).pendingRequest;
      assert(request, "Actual native AskUserQuestion must reach the controller");
      assert.equal(request.method, "claude/tool/requestUserInput"); assert.equal(request.questions.length, 2);
      assert.equal(request.questions[0].multiSelect, true);
      await assert.rejects(manager.respond(chat.id, request.requestId, { answers: { foreign: "Do not answer another question" } }), /requested question/);
      await manager.respond(chat.id, request.requestId, { answers: skipQuestions ? {} : { question_1: ["Intro", "Conclusion"], question_2: "ação\nKeep it literal" } });
      await assert.rejects(manager.respond(chat.id, request.requestId, { answers: {} }), /no longer active/);
    }
    await resumed; if (fixtureError) throw fixtureError;
    assert.equal(store.get(chat.id).agentSessionId, session);
    assert.match(store.get(chat.id).messages.at(-1).text, /Saved application context retained after Stop/);
    assert.equal(store.get(chat.id).usage.totals.inputTokens, (requests.length - (sendNow ? 1 : 0)) * 100);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/items`, { signal: AbortSignal.timeout(3000) }));
    if (stopApproval) await assert.rejects(readFile(`${chat.workspace}/.claude/skills/verify/SKILL.md`, "utf8"), { code: "ENOENT" });
    console.log(`PASS: ${sendNow ? `native ${firstSendNow ? "first-command " : ""}Send now retained the running app/data and unselected queue entry` : backgroundExit ? "native background completion saved one independent answer, without synthetic user input" : stopApproval ? "Stop canceled the native approval without creating its recipe or consuming queued input" : `native run/verify drove the actual HTTP app across replies, changed model and ${approveRecipe ? "created/reused its recipe only after explicit approval" : "honored denial and reused a separately supplied recipe"}`}; Stop closed the app and restored the same native context without restarting it.${askQuestions ? ` Native questions ${skipQuestions ? "were skipped without invented answers" : "returned selected options and literal text"}.` : ""} ${requests.length} loopback requests; usage counted once.`);
  } finally {
    release.resolve(); await failureStop; await manager?.shutdown(); server.closeAllConnections(); gatewayServer?.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), ...(gatewayServer ? [new Promise(resolve => gatewayServer.close(resolve))] : [])]);
    await rm(root, { recursive: true, force: true });
  }
}
