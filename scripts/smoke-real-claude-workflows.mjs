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

// Real native skill expansion and tools against an authored disposable CLI.
// No real inference, GitHub operations, personal profiles or external network.
const exec = promisify(execFile);
if (!process.argv.includes("--network-isolated")) {
  const result = await exec("/usr/bin/unshare", ["--user", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL", "--", process.execPath, process.argv[1], ...process.argv.slice(2), "--network-isolated"], { timeout: 90000, killSignal: "SIGKILL", maxBuffer: 40000 });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  assert.match(result.stdout, /^PASS:/m, "The fixture must complete its assertions");
} else {
  await exec("/usr/bin/ip", ["link", "set", "lo", "up"]);
  assert.deepEqual(JSON.parse((await exec("/usr/bin/ip", ["-j", "link", "show"])).stdout).map(item => item.ifname), ["lo"]);
  assert.equal((await exec("/usr/bin/ip", ["route", "show"])).stdout.trim(), "");
  const root = await mkdtemp("/tmp/relay-claude-workflows-"), requests = [], mainRequests = [], nativeResults = [], launches = [];
  let manager, gatewayServer, chat, fixtureError, firstSession, step = 0;
  const simplify = process.argv.includes("--simplify");
  const workflow = simplify ? "simplify" : "code-review";
  const fix = simplify || process.argv.includes("--fix");
  const application = process.argv.includes("--application");
  let applicationStep = application ? 0 : null, applicationUrl, applicationState;
  const plan = process.argv.includes("--plan"), empty = process.argv.includes("--empty");
  const sendNow = process.argv.includes("--send-now");
  const interrupt = process.argv.includes("--interrupt") || sendNow, held = Promise.withResolvers(), release = Promise.withResolvers();
  let resuming = false;
  const original = simplify
    ? 'const [left, right] = process.argv.slice(2).map(Number);\nconst total = left + right;\nconsole.log(JSON.stringify({ total }));\n'
    : 'const [left, right] = process.argv.slice(2).map(Number);\nconsole.log(JSON.stringify({ total: left + right }));\n';
  const broken = simplify ? original.replace("{ total }", "{ total: total }") : original.replace("left + right", "left - right");
  const respond = async (request, response) => {
    if (request.url.includes("count_tokens")) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"input_tokens":100}'); return; }
    if (request.method !== "POST" || !/\/messages(?:\?|$)/.test(request.url)) { response.writeHead(404); response.end(); return; }
    let raw = ""; for await (const chunk of request) raw += chunk;
    assert.equal(request.headers["x-api-key"], "controller-only-workflow-fixture");
    const body = JSON.parse(raw), index = requests.push(body);
    assert(index <= 20, "Unexpected native workflow inference loop");
    const title = !body.tools?.length && JSON.stringify(body.messages.at(-1)).includes("Write the title in the predominant language");
    if (!title) mainRequests.push(body);
    let content;
    if (title) content = [{ type: "text", text: "Review fixture with running application" }];
    else if (applicationStep === 0) {
      assert.match(JSON.stringify(body.messages), /Running means launching the actual app/);
      content = [{ type: "tool_use", id: `app_${index}`, name: "Bash", input: { command: "node application.mjs", description: "Start the disposable HTTP app", run_in_background: true } }];
      applicationStep++;
    } else if (applicationStep === 1) {
      const results = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === "tool_result");
      assert(results.length); assert(!results.at(-1).is_error, JSON.stringify(results.at(-1)));
      content = [{ type: "text", text: "The actual application is running." }]; applicationStep = null;
    } else if (resuming) {
      assert.match(JSON.stringify(body.messages), interrupt ? new RegExp(workflow) : simplify ? /native simplify fixture/ : empty ? /No findings were reported/ : fix && !plan ? /Actual invocation returned total 5/ : /CLI subtracts instead of adding/);
      content = [{ type: "text", text: "Saved review context retained." }];
    } else {
      const text = JSON.stringify(body.messages);
      const results = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === "tool_result");
      if (step === 0) {
        if (simplify) {
          assert.match(text, /Review target:.*total\.mjs/);
          assert.match(text, /reuse, simplification, efficiency, and altitude/);
          assert.match(text, /Do not look for correctness bugs/);
          assert.match(text, /Apply the fixes/);
        } else {
          assert.match(text, /reviewing a pull request for real bugs/);
          assert.match(text, /also restate the findings in your final reply/);
          if (fix) assert.match(text, /apply the.*findings to the working tree/);
        }
        content = [{ type: "tool_use", id: `tool_${index}`, name: "Bash", input: { command: "git diff -- total.mjs", description: "Inspect the disposable CLI diff" } }];
      } else if (step === 1) {
        assert(results.length); assert(!results.at(-1).is_error);
        if (!empty) assert.match(JSON.stringify(results.at(-1)), simplify ? /total: total/ : /left - right/);
        if (interrupt) { held.resolve(); await release.promise; response.end(); return; }
        content = [{ type: "tool_use", id: `tool_${index}`, name: "Read", input: { file_path: `${chat.workspace}/total.mjs` } }];
      } else if (simplify && step === 2) {
        assert(results.length); assert(!results.at(-1).is_error);
        assert.match(JSON.stringify(results.at(-1)), empty ? /JSON.stringify\(\{ total \}\)/ : /total: total/);
        content = empty ? [{ type: "text", text: "The native simplify fixture is already clean. No changes applied." }]
          : [{ type: "tool_use", id: `tool_${index}`, name: "Edit", input: { file_path: `${chat.workspace}/total.mjs`, old_string: "{ total: total }", new_string: "{ total }" } }];
      } else if (simplify && step === 3) {
        if (plan) {
          assert.equal(results.at(-1).is_error, true, "Plan mode must reject simplification edits too");
          content = [{ type: "text", text: "Plan mode denied the native simplify fixture edit; no changes applied." }];
        } else {
          assert(!results.at(-1).is_error);
          content = [{ type: "tool_use", id: `tool_${index}`, name: "Bash", input: { command: "node total.mjs 2 3", description: "Verify behavior after simplifying" } }];
        }
      } else if (simplify && step === 4) {
        assert(!results.at(-1).is_error); assert.match(JSON.stringify(results.at(-1)), /total.*5/);
        content = [{ type: "text", text: "Removed a redundant property name in the native simplify fixture. Actual invocation returned total 5, unchanged from before cleanup." }];
      } else if (step === 2) {
        assert(results.length); assert(!results.at(-1).is_error); assert.match(JSON.stringify(results.at(-1)), empty ? /left \+ right/ : /left - right/);
        content = [{ type: "tool_use", id: `tool_${index}`, name: "ReportFindings", input: { level: "high", findings: empty ? [] : [{ file: "total.mjs", line: 2, summary: "The CLI subtracts instead of adding the inputs.", short_summary: "Addition replaced with subtraction", failure_scenario: "Running node total.mjs 2 3 prints -1 instead of 5.", category: "correctness", verdict: "CONFIRMED" }] } }];
      } else if (step === 3) {
        assert(!results.at(-1).is_error); assert.match(JSON.stringify(results.at(-1)), empty ? /No findings reported/ : /1 finding reported/);
        content = fix ? [{ type: "tool_use", id: `tool_${index}`, name: "Edit", input: { file_path: `${chat.workspace}/total.mjs`, old_string: "left - right", new_string: "left + right" } }]
          : [{ type: "text", text: empty ? "No findings were reported by this review." : "total.mjs:2 — The CLI subtracts instead of adding the inputs. Running node total.mjs 2 3 prints -1 instead of 5." }];
      } else if (fix && step === 4) {
        if (plan) {
          assert.equal(results.at(-1).is_error, true, "Plan mode must reject the native edit");
          content = [{ type: "text", text: "total.mjs:2 — The CLI subtracts instead of adding. Plan mode denied the edit; no fixes were applied." }];
        } else {
          assert(!results.at(-1).is_error);
          content = [{ type: "tool_use", id: `tool_${index}`, name: "Bash", input: { command: "node total.mjs 2 3", description: "Run the corrected disposable CLI" } }];
        }
      } else if (fix && step === 5) {
        assert(!results.at(-1).is_error); assert.match(JSON.stringify(results.at(-1)), /total.*5/);
        content = [{ type: "text", text: "Fixed total.mjs:2; the CLI now adds the inputs. Actual invocation returned total 5." }];
      } else throw Error(`Unexpected native workflow request ${step}`);
      step++;
    }
    const message = { id: `msg_workflow_${index}`, type: "message", role: "assistant", model: body.model, content, stop_reason: content.some(block => block.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } };
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
    fixtureError = error; response.writeHead(500); response.end(); void manager.stop(chat.id);
  }); });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const config = loadConfig({ AGENT_DATA_DIR: root, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", AGENT_IDLE_TIMEOUT_MS: "60000", CLAUDE_AUTH_MODE: "gateway", ANTHROPIC_API_KEY: "controller-only-workflow-fixture" });
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
        if (command === config.claude.bin && args.includes("--print")) launches.push(args);
        if (args.includes("--session-id") && !firstSession) firstSession = args[args.indexOf("--session-id") + 1];
        const child = spawnWorker(command, args, options);
        let buffer = "";
        child.stdout.on("data", chunk => {
          buffer += chunk; const lines = buffer.split("\n"); buffer = lines.pop();
          for (const line of lines) { try { const event = JSON.parse(line); if (event.type === "result") nativeResults.push(event.subtype); } catch {} }
        });
        return child;
      },
    }) };
    manager = new RuntimeManager({ store, config, broker, gatewayOrigin, workerBackend, adapterFactory: params => new ClaudeAdapter({ ...params, store, config, broker, gatewayOrigin }) });
    chat = await manager.createChat({ agent: "claude", title: "Native workflow fixture" });
    await manager.setMode(chat.id, plan && !application ? "plan" : "accept_edits");
    const env = { HOME: root, PATH: process.env.PATH, LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    await writeFile(`${chat.workspace}/total.mjs`, original);
    await exec("git", ["-C", chat.workspace, "add", "total.mjs"], { env });
    await exec("git", ["-C", chat.workspace, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "Fixture CLI baseline"], { env });
    await writeFile(`${chat.workspace}/total.mjs`, empty ? original : broken);
    await mkdir(`${store.runtimeHome(chat.id)}/claude`, { recursive: true });
    await writeFile(`${store.runtimeHome(chat.id)}/claude/settings.json`, JSON.stringify({ permissions: { allow: ["Bash(node total.mjs 2 3)", ...(application ? ["Bash(node application.mjs)"] : [])] } }));
    const checkApplication = async () => {
      assert.deepEqual(await (await fetch(applicationUrl, { signal: AbortSignal.timeout(2000) })).json(), applicationState);
      assert.equal(launches.length, 1, "Review must not replace the native process owning the app");
      assert.equal(store.get(chat.id).agentSessionId, firstSession);
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
      await manager.send(chat.id, "/run Start the actual HTTP application before reviewing the CLI."); if (fixtureError) throw fixtureError;
      let port; const deadline = Date.now() + 10000;
      while (!port && Date.now() < deadline) { try { port = JSON.parse(await readFile(`${chat.workspace}/.application.json`, "utf8")).port; } catch { await delay(25); } }
      assert(port, "The application must actually be running"); applicationUrl = `http://127.0.0.1:${port}`;
      applicationState = await (await fetch(applicationUrl, { method: "POST", body: "preserve ação" })).json();
      await checkApplication(); if (plan) await manager.setMode(chat.id, "plan");
    }
    if (simplify) assert.equal((await exec(process.execPath, ["total.mjs", "2", "3"], { cwd: chat.workspace, env })).stdout.trim(), '{"total":5}', "The cleanup fixture must already have correct behavior");
    const command = simplify ? "/simplify total.mjs" : `/code-review high ${fix ? "--fix " : ""}total.mjs`;
    if (interrupt) {
      const running = manager.send(chat.id, command); let timer;
      try {
        await Promise.race([held.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("The actual review turn was not reached")), 15000); })]);
        if (!simplify) assert.equal(store.get(chat.id).agentSessionId, application ? firstSession : null, "Keep an existing application journal; do not invent a first-review checkpoint");
        if (application) await checkApplication();
        await manager.enqueue(chat.id, "Retain the queued follow-up");
        if (sendNow) {
          await store.update(chat.id, { queuePaused: true });
          const queued = await manager.enqueue(chat.id, "Continue after the interrupted review.");
          resuming = true;
          await manager.sendQueuedNow(chat.id, queued.queuedMessages.at(-1).id);
        } else await manager.stop(chat.id);
        await running;
      } finally { clearTimeout(timer); release.resolve(); }
      if (!sendNow) assert.equal(store.get(chat.id).status, "stopped");
      assert.equal(store.get(chat.id).queuedMessages[0].text, "Retain the queued follow-up");
      if (!simplify) assert.equal(nativeResults.at(-1), "success", "The cancelled native handler still checkpoints its journal");
      assert.equal(store.get(chat.id).agentSessionId, firstSession);
      resuming = true;
      if (!sendNow) await manager.send(chat.id, "Continue after the interrupted review.");
      const deadline = Date.now() + 15000;
      while (manager.isBusy(chat.id) && Date.now() < deadline) await delay(20);
      assert.equal(manager.isBusy(chat.id), false); if (fixtureError) throw fixtureError;
      assert.equal(store.get(chat.id).agentSessionId, firstSession);
      assert.match(store.get(chat.id).messages.at(-1).text, /Saved review context retained/);
      assert.equal(await readFile(`${chat.workspace}/total.mjs`, "utf8"), broken);
      assert.deepEqual(store.get(chat.id).queuedMessages.map(item => item.text), ["Retain the queued follow-up"]);
      assert.equal(mainRequests.length, application ? 5 : 3);
      if (application) {
        if (sendNow) {
          await checkApplication(); await manager.stop(chat.id);
          await manager.send(chat.id, "Continue from the saved review after explicitly stopping the app."); if (fixtureError) throw fixtureError;
        }
        await assert.rejects(fetch(applicationUrl, { signal: AbortSignal.timeout(2000) }));
        assert.equal(launches.length, 2); assert.equal(store.get(chat.id).agentSessionId, firstSession);
      }
      console.log(`PASS: actual ${application ? "retained-application" : "first-command"} ${workflow} ${sendNow ? "Send now" : "Stop"} interruption, queued-input preservation and same-session continuation${application ? "; the same HTTP app/data survived until explicit Stop" : ""}; ${mainRequests.length} main and ${requests.length - mainRequests.length} title loopback requests.`);
    } else {
      const running = manager.send(chat.id, command);
      if (simplify && plan && !empty) {
        // In SDK mode native Plan can ask for an explicit edit exception.
        // Refuse that request; never count a pending approval as a refusal.
        let complete = false; void running.then(() => { complete = true; }, () => { complete = true; });
        const deadline = Date.now() + 15000;
        while (!complete && !store.get(chat.id).pendingRequest && Date.now() < deadline) await delay(20);
        const pending = store.get(chat.id).pendingRequest;
        if (pending) {
          assert.match(pending.command, /total\.mjs/);
          assert.match(pending.command, /new_string/);
          assert.equal(await readFile(`${chat.workspace}/total.mjs`, "utf8"), broken);
          await manager.respond(chat.id, pending.requestId, { decision: "decline" });
        }
      }
      await running;
      if (fixtureError) throw fixtureError;
      assert.deepEqual(store.get(chat.id).messages.filter(message => message.kind === "error").map(message => message.text), []);
      assert.equal(mainRequests.length, (simplify ? empty ? 3 : plan ? 4 : 5 : fix ? plan ? 5 : 6 : 4) + (application ? 2 : 0));
      assert.equal(await readFile(`${chat.workspace}/total.mjs`, "utf8"), empty || fix && !plan ? original : broken, fix && !plan ? "Explicit --fix must actually change the file" : "Read-only review must not apply fixes");
      assert.match(store.get(chat.id).messages.at(-1).text, simplify ? /native simplify fixture/ : empty ? /No findings were reported/ : fix && !plan ? /Actual invocation returned total 5/ : /CLI subtracts instead of adding/);
      {
        const session = store.get(chat.id).agentSessionId; resuming = true;
        if (application) {
          await checkApplication();
          await manager.send(chat.id, "Continue from this review without restarting the app."); if (fixtureError) throw fixtureError;
          await checkApplication();
        }
        await manager.stop(chat.id);
        await manager.send(chat.id, "Continue from the saved review."); if (fixtureError) throw fixtureError;
        assert.equal(store.get(chat.id).agentSessionId, session);
        assert.match(store.get(chat.id).messages.at(-1).text, /Saved review context retained/);
        if (application) {
          await assert.rejects(fetch(applicationUrl, { signal: AbortSignal.timeout(2000) })); assert.equal(launches.length, 2);
        }
      }
      console.log(`PASS: native ${workflow} instructions, actual diff/read${simplify ? "" : "/report"} tools, final findings, same-session Stop/resume and ${empty ? "empty findings" : fix ? plan ? "native Plan-mode edit refusal" : "applied/observed fixes" : "read-only review"} verified${application ? "; review/follow-up retained the same real HTTP app/data until explicit Stop" : ""}; ${mainRequests.length} main and ${requests.length - mainRequests.length} title loopback replies.`);
    }
  } finally {
    await manager?.shutdown(); server.closeAllConnections(); gatewayServer?.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), ...(gatewayServer ? [new Promise(resolve => gatewayServer.close(resolve))] : [])]);
    await rm(root, { recursive: true, force: true });
  }
}
