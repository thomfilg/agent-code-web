import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { loadConfig } from "../src/config.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { ProviderGateway } from "../src/provider-gateway.mjs";
import { spawnWorker } from "../src/worker-process.mjs";

// Actual installed Workflow orchestration with authored model/structured-output
// replies. Sources and findings are invented fixture data, not web research.
// No public network, real inference/account, live service or policy changes.
const exec = promisify(execFile);
for (const option of process.argv.slice(2)) assert(["--network-isolated", "--trace", "--interrupt", "--send-now", "--report", "--drain", "--application", "--early"].includes(option));
assert(!process.argv.includes("--report") || process.argv.includes("--send-now") || process.argv.includes("--interrupt"));
assert(!process.argv.includes("--drain") || !process.argv.includes("--send-now") && !process.argv.includes("--interrupt"));
assert(!process.argv.includes("--early") || !process.argv.includes("--send-now") && !process.argv.includes("--interrupt"));
if (!process.argv.includes("--network-isolated")) {
  const result = await exec("/usr/bin/unshare", ["--user", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL", "--", process.execPath, process.argv[1], ...process.argv.slice(2), "--network-isolated"], { timeout: 90000, killSignal: "SIGKILL", maxBuffer: 40000 }).catch(error => {
    process.stdout.write(error.stdout || ""); process.stderr.write(error.stderr || error.message); process.exit(1);
  });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); assert.match(result.stdout, /^PASS:/m);
} else {
  await exec("/usr/bin/ip", ["link", "set", "lo", "up"]);
  assert.deepEqual(JSON.parse((await exec("/usr/bin/ip", ["-j", "link", "show"])).stdout).map(item => item.ifname), ["lo"]);
  assert.equal((await exec("/usr/bin/ip", ["route", "show"])).stdout.trim(), "");
  const root = await mkdtemp("/tmp/relay-claude-research-"), requests = [], native = [], launches = [], phases = [];
  const trace = process.argv.includes("--trace"), sendNow = process.argv.includes("--send-now"), interrupt = sendNow || process.argv.includes("--interrupt");
  const report = process.argv.includes("--report"), releaseReport = Promise.withResolvers();
  const drain = process.argv.includes("--drain"), application = process.argv.includes("--application");
  const early = process.argv.includes("--early"), workflowFinished = Promise.withResolvers();
  const release = Promise.withResolvers(), question = "Compare the authored alpha and beta fixture records.\nPreserve ação and this second line.";
  const sources = ["https://alpha.example.test/record", "https://beta.example.test/record"];
  let manager, store, gatewayServer, chat, failure, titles = 0, held = false, reportHeld = false, launched = false, resuming = false, appUrl, appState;
  let appStep = application ? 0 : null;
  const mainText = body => body.messages.flatMap(message => typeof message.content === "string" ? [message.content] : (message.content || []).map(block => block.text || "")).join("\n");
  const respond = async (request, response) => {
    if (request.url.includes("count_tokens")) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"input_tokens":100}'); return; }
    if (request.method !== "POST" || !/\/messages(?:\?|$)/.test(request.url)) { response.writeHead(404); response.end(); return; }
    assert.equal(request.headers["x-api-key"], "controller-only-research-fixture");
    let raw = ""; for await (const part of request) raw += part;
    const body = JSON.parse(raw), prompt = mainText(body), last = body.messages.at(-1);
    let content;
    if (!body.tools?.length && prompt.includes("Write the title in the predominant language")) { titles++; content = [{ type: "text", text: "Native research fixture" }]; }
    else {
      requests.push(body); assert(requests.length <= 40, "Unexpected native research inference loop");
      const schema = body.tools?.find(tool => tool.name === "StructuredOutput")?.input_schema;
      if (trace) console.log("MODEL", requests.length, schema?.required || "main");
      const toolResult = Array.isArray(last?.content) && last.content.find(block => block.type === "tool_result");
      if (appStep === 0) {
        assert(prompt.includes("Start the fixture HTTP application"));
        content = [{ type: "tool_use", id: "fixture_app", name: "Bash", input: { command: "node server.mjs", description: "Start the disposable HTTP app", run_in_background: true } }]; appStep++;
      } else if (appStep === 1) {
        assert(toolResult && !toolResult.is_error);
        content = [{ type: "text", text: "The fixture HTTP application is running." }]; appStep = null;
      } else if (schema) {
        if (toolResult) { assert(!toolResult.is_error, JSON.stringify(toolResult)); content = [{ type: "text", text: "Fixture structured result supplied." }]; }
        else {
          let data;
          if (schema.properties.angles) {
            assert(prompt.includes(question)); held = true; await release.promise;
            data = { question, summary: "Compare deterministic fixture sources.", angles: ["primary", "secondary", "contrarian"].map(label => ({ label, query: `fixture ${label}` })) }; phases.push("Scope");
          } else if (schema.properties.results) {
            data = { results: sources.map(url => ({ url, title: "Authored fixture record", relevance: "high" })) }; phases.push("Search");
          } else if (schema.properties.claims) {
            const alpha = prompt.includes(sources[0]);
            data = { sourceQuality: "primary", claims: [{ claim: alpha ? "ALPHA fixture has value 7." : "BETA fixture has value 99.", quote: "Invented fixture quote.", importance: "central" }] }; phases.push("Fetch");
          } else if (schema.properties.refuted) {
            data = { refuted: prompt.includes("BETA fixture"), evidence: "Authored verification vote.", confidence: "high" }; phases.push("Verify");
          } else if (schema.properties.findings) {
            assert(prompt.includes("ALPHA fixture"));
            data = { summary: "Authored research fixture completed.", findings: [{ claim: "ALPHA fixture has value 7.", confidence: "high", sources: [sources[0]], evidence: "Three authored fixture votes." }], caveats: "This is deterministic test data, not actual research." }; phases.push("Synthesize");
          } else throw Error(`Unexpected workflow schema: ${JSON.stringify(schema.required)}`);
          content = [{ type: "tool_use", id: `structured_${requests.length}`, name: "StructuredOutput", input: data }];
        }
      } else if (resuming) {
        assert(prompt.includes(question)); content = [{ type: "text", text: "Saved native research context retained." }];
      } else if (prompt.includes("Run queued input after the research report")) {
        const messages = store.get(chat.id).messages, reportIndex = messages.findIndex(message => message.text?.startsWith("Native research fixture completed:"));
        assert(reportIndex >= 0); assert(reportIndex < messages.findIndex(message => message.role === "user" && message.text === "Run queued input after the research report"));
        content = [{ type: "text", text: "Queued input completed after the native report." }];
      } else if (!launched) {
        assert(prompt.includes('Run the "deep-research" workflow.')); assert(prompt.includes(JSON.stringify(question)));
        assert(body.tools.some(tool => tool.name === "Workflow")); launched = true;
        content = [{ type: "tool_use", id: "research_workflow", name: "Workflow", input: { name: "deep-research", args: question } }];
      } else if (toolResult) {
        assert(!toolResult.is_error, JSON.stringify(toolResult)); assert.match(JSON.stringify(toolResult), /Workflow launched in background/);
        if (early) { release.resolve(); await workflowFinished.promise; }
        content = [{ type: "text", text: "Research is running in the native workflow." }];
      } else {
        assert.match(prompt, /Dynamic workflow/); assert.match(prompt, /ALPHA fixture/);
        assert.match(prompt, /&quot;confirmed&quot;:1|"confirmed":1/); assert.match(prompt, /&quot;killed&quot;:1|"killed":1/);
        if (report || early) { reportHeld = true; await releaseReport.promise; }
        content = [{ type: "text", text: `Native research fixture completed: one confirmed claim, one refuted claim, duplicated sources fetched once. [Fixture source](${sources[0]}). Not real research.` }];
      }
    }
    const block = content[0], tool = block.type === "tool_use";
    const message = { id: `msg_research_${requests.length + titles}`, type: "message", role: "assistant", model: body.model, content, stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } };
    if (!body.stream) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(message)); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
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
    failure ||= error; if (!response.headersSent) response.writeHead(500); response.end(); void manager?.shutdown();
  }); });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const config = loadConfig({ AGENT_DATA_DIR: root, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", AGENT_IDLE_TIMEOUT_MS: "60000", CLAUDE_AUTH_MODE: "gateway", ANTHROPIC_API_KEY: "controller-only-research-fixture" });
    store = new ChatStore(root); await store.initialize(); const broker = new CapabilityBroker({ ttlMs: 120000 });
    const gateway = new ProviderGateway({ config, broker, fetchImpl: (url, options) => fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}${new URL(url).search}`, options) });
    gatewayServer = http.createServer((request, response) => { void gateway.handle(request, response, new URL(request.url, "http://fixture")); });
    await new Promise(resolve => gatewayServer.listen(0, "127.0.0.1", resolve)); const gatewayOrigin = `http://127.0.0.1:${gatewayServer.address().port}`;
    const workerBackend = { sleep: async () => {}, shutdown: async () => {}, acquire: async current => ({
      workspace: current.workspace, runtimeHome: store.runtimeHome(current.id), metadata: { backend: "local" }, mkdir: directory => mkdir(directory, { recursive: true, mode: 0o700 }),
      spawn(command, args, options) {
        assert(!JSON.stringify([args, options.env]).includes(config.claude.providerKey));
        const child = spawnWorker(command, args, options);
        if (command !== config.claude.bin || !args.includes("--print")) return child;
        launches.push(child);
        let buffer = ""; child.stdout.on("data", chunk => {
          buffer += chunk; const lines = buffer.split("\n"); buffer = lines.pop();
          for (const line of lines) try {
            const event = JSON.parse(line); native.push(event);
            if (event.type === "system" && event.subtype === "task_notification" && event.status === "completed") workflowFinished.resolve();
            if (trace && (event.type === "result" || event.type === "command_lifecycle" || event.type === "system" && event.subtype.startsWith("task_"))) console.log("NATIVE", JSON.stringify({ type: event.type, subtype: event.subtype, task_id: event.task_id, task_type: event.task_type, state: event.state, status: event.status, origin: event.origin, command_uuid: event.command_uuid }));
            if (trace && event.type === "user") console.log("NATIVE-USER", JSON.stringify({ keys: Object.keys(event), origin: event.origin, content: JSON.stringify(event.message?.content).slice(0, 180) }));
          } catch {}
        }); return child;
      },
    }) };
    manager = new RuntimeManager({ store, config, broker, gatewayOrigin, workerBackend, adapterFactory: params => new ClaudeAdapter({ ...params, store, config, broker, gatewayOrigin }) });
    chat = await manager.createChat({ agent: "claude", title: "Native research fixture" }); await manager.setMode(chat.id, "accept_edits");
    await mkdir(`${store.runtimeHome(chat.id)}/claude`, { recursive: true });
    await writeFile(`${store.runtimeHome(chat.id)}/claude/settings.json`, JSON.stringify({ permissions: { allow: ["Workflow(deep-research)", ...(application ? ["Bash(node server.mjs)"] : [])] } }));
    const wait = async predicate => { const deadline = Date.now() + 25000; while (!predicate() && !failure && Date.now() < deadline) await delay(25); if (failure) throw failure; assert(predicate(), "Native fixture condition did not settle"); };
    if (application) {
      await writeFile(`${chat.workspace}/server.mjs`, "import http from 'node:http';import {writeFile} from 'node:fs/promises';const state={pid:process.pid,value:'Preserve ação and app state'};const server=http.createServer((req,res)=>res.end(JSON.stringify(state)));server.listen(0,'127.0.0.1',async()=>{await writeFile('.runtime.json',JSON.stringify({port:server.address().port}));console.log('HTTP fixture ready');});");
      await manager.send(chat.id, "Start the fixture HTTP application with node server.mjs and keep it running."); if (failure) throw failure;
      const deadline = Date.now() + 10000;
      while (!appUrl && Date.now() < deadline) {
        try { const { port } = JSON.parse(await readFile(`${chat.workspace}/.runtime.json`, "utf8")); appUrl = `http://127.0.0.1:${port}`; appState = await (await fetch(appUrl, { signal: AbortSignal.timeout(1000) })).json(); }
        catch { appUrl = null; await delay(25); }
      }
      assert(appUrl);
    }
    const checkApp = async () => { if (application) assert.deepEqual(await (await fetch(appUrl, { signal: AbortSignal.timeout(1000) })).json(), appState); };
    await manager.send(chat.id, `/deep-research ${question}`); if (failure) throw failure;
    await wait(() => held);
    const session = store.get(chat.id).agentSessionId;
    assert.equal(launches[0].exitCode ?? launches[0].signalCode, null, "Reply completion must not kill the native workflow owner");
    assert.equal(manager.isBusy(chat.id), true, "The live native workflow must remain busy after its launching reply");
    await checkApp();
    await store.update(chat.id, { queuePaused: !drain });
    await manager.enqueue(chat.id, drain ? "Run queued input after the research report" : "Keep this unrelated queued input");
    if (early && !report) releaseReport.resolve();
    if (report) { release.resolve(); await wait(() => reportHeld); assert.equal(manager.isBusy(chat.id), true); }
    if (interrupt) {
      if (sendNow) {
        const queued = await manager.enqueue(chat.id, "Continue saved research context now"); resuming = true;
        await manager.sendQueuedNow(chat.id, queued.queuedMessages.at(-1).id); await wait(() => !manager.isBusy(chat.id));
        assert.equal(launches.length, 1, "Send now must use a native task stop, not replace the worker");
        await checkApp();
      } else { await manager.stop(chat.id); resuming = true; await manager.send(chat.id, "Continue saved research context after Stop"); }
      release.resolve(); releaseReport.resolve();
      assert.equal(store.get(chat.id).agentSessionId, session);
      assert.match(store.get(chat.id).messages.at(-1).text, /Saved native research context retained/);
      assert.equal(phases.includes("Synthesize"), report);
      if (application && !sendNow) await assert.rejects(fetch(appUrl, { signal: AbortSignal.timeout(1000) }));
      if (application && sendNow) {
        await manager.stop(chat.id); await assert.rejects(fetch(appUrl, { signal: AbortSignal.timeout(1000) }));
        await manager.send(chat.id, "Continue saved research context after explicitly stopping the application");
        assert.equal(store.get(chat.id).agentSessionId, session);
      }
    } else {
      release.resolve();
      await wait(() => store.get(chat.id).messages.some(message => message.text?.startsWith("Native research fixture completed:")));
      await wait(() => !manager.isBusy(chat.id));
      if (drain) await wait(() => store.get(chat.id).messages.some(message => message.text === "Queued input completed after the native report."));
      for (const [phase, count] of [["Scope", 1], ["Search", 3], ["Fetch", 2], ["Verify", 6], ["Synthesize", 1]]) assert.equal(phases.filter(value => value === phase).length, count, `${phase} must run the actual native fan-out/dedup/voting`);
      assert.equal(launches.length, 1); await checkApp(); await manager.stop(chat.id); resuming = true;
      if (application) await assert.rejects(fetch(appUrl, { signal: AbortSignal.timeout(1000) }));
      await manager.send(chat.id, "Continue saved research context after completion"); assert.equal(store.get(chat.id).agentSessionId, session);
    }
    assert.deepEqual(store.get(chat.id).queuedMessages.map(item => item.text), drain ? [] : ["Keep this unrelated queued input"]);
    assert(!store.get(chat.id).messages.some(message => message.kind === "error"), JSON.stringify(store.get(chat.id).messages));
    console.log(`PASS: native deep-research ${interrupt ? `${report ? "in-flight report " : ""}${sendNow ? "Send now" : "Stop/resume"}` : "background lifetime, deterministic scope/search/dedup/fetch/vote/synthesis and final report"}, same native history and ${drain ? "FIFO after the report" : "unrelated queue preservation"}${application ? "; real HTTP app/state retained until explicit Stop" : ""}; ${requests.length} authored model replies, ${titles} titles.`);
  } finally {
    release.resolve(); releaseReport.resolve(); workflowFinished.resolve(); await manager?.shutdown(); server.closeAllConnections(); gatewayServer?.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); if (gatewayServer) await new Promise(resolve => gatewayServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
