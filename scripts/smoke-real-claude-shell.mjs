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

// Actual installed shell tools and permissions, authored loopback responses.
// Only the exact disposable app bootstrap has an allow rule. Marker commands
// must cross the real native permission path, not a fixture-side execution.
const exec = promisify(execFile);
const modes = new Set(["default", "plan", "dont_ask", "accept_edits", "auto"]);
const mode = process.argv.find(value => value.startsWith("--mode="))?.slice(7) || "default";
const classifier = process.argv.find(value => value.startsWith("--classifier="))?.slice(13) || (mode === "plan" ? "block" : "allow");
const classified = mode === "auto" || mode === "plan";
assert(modes.has(mode));
assert(["allow", "block", "review", "invalid", "error"].includes(classifier));
assert(classified || !process.argv.some(value => value.startsWith("--classifier=")), "Classifier fixtures require Auto or Plan mode");
for (const argument of process.argv.slice(2)) assert(["--network-isolated", "--trace", "--stop", "--send-now", `--mode=${mode}`, `--classifier=${classifier}`].includes(argument), `Unknown fixture option: ${argument}`);
assert(!(process.argv.includes("--stop") && process.argv.includes("--send-now")));
assert(!(mode === "dont_ask" && process.argv.some(value => ["--stop", "--send-now"].includes(value))), "Deny prompts has no pending permission request to cancel");
if (!process.argv.includes("--network-isolated")) {
  const result = await exec("/usr/bin/unshare", ["--user", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL", "--", process.execPath, process.argv[1], ...process.argv.slice(2), "--network-isolated"], { timeout: 90000, maxBuffer: 60000 }).catch(error => {
    process.stdout.write(error.stdout || ""); process.stderr.write(error.stderr || error.message); process.exit(1);
  });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); assert.match(result.stdout, /^PASS:/m);
} else {
  await exec("/usr/bin/ip", ["link", "set", "lo", "up"]);
  assert.deepEqual(JSON.parse((await exec("/usr/bin/ip", ["-j", "link", "show"])).stdout).map(item => item.ifname), ["lo"]);
  assert.equal((await exec("/usr/bin/ip", ["route", "show"])).stdout.trim(), "");
  const root = await mkdtemp("/tmp/relay-claude-shell-"), mainRequests = [], classifierRequests = [], launches = [], nativeApprovals = [], resumedInputs = [];
  const command = "node marker.mjs", stop = process.argv.includes("--stop"), sendNow = process.argv.includes("--send-now");
  let manager, gatewayServer, chat, fixtureError, failureStop, releaseClassifier, expectedResume, phase = "run", step = 0, titleCount = 0, denied = false;
  const respond = async (request, response) => {
    if (request.url.includes("count_tokens")) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"input_tokens":100}'); return; }
    if (request.method !== "POST" || !/\/messages(?:\?|$)/.test(request.url)) { response.writeHead(404); response.end(); return; }
    assert.equal(request.headers["x-api-key"], "controller-only-shell-fixture");
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw), system = JSON.stringify(body.system), text = JSON.stringify(body.messages);
    const title = !body.tools?.length && text.includes("Write the title in the predominant language");
    const prefix = system.includes("commands that an AI coding agent wants to run");
    const safety = system.includes("You are a security monitor for autonomous AI coding agents.");
    let content;
    if (title) { titleCount++; content = [{ type: "text", text: "Native shell permissions fixture" }]; }
    else if (prefix) {
      assert(text.includes(command), "Only this fixture's literal marker command may reach prefix classification");
      classifierRequests.push(body); content = [{ type: "text", text: "none" }];
    } else if (safety) {
      assert.equal(phase, "shell"); assert(!body.tools?.length);
      const transcript = body.messages.at(-1).content.map(block => block.text || "").join("");
      assert.match(transcript, /User: Run the marker command once and report its actual result\./);
      assert.equal(transcript.split("</transcript>")[0].split("\n").slice(-2).join("\n"), `Bash ${command}\n`, "Classify only the exact disposable command, not an arbitrary action");
      assert(system.includes("<block>no</block>"), "Verify the installed classifier response contract");
      const stage = body.stop_sequences?.includes("</block>") ? "fast" : "thinking";
      classifierRequests.push({ stage, body });
      // Installed 2.1.222 retries an unparseable response four times in each
      // of its two stages (ten total); the fixture must cover that real budget.
      assert(classifierRequests.length <= 10, "Unexpected classifier retry loop");
      if (stop || sendNow) await new Promise(resolve => { releaseClassifier = resolve; });
      if (classifier === "error") {
        response.writeHead(403, { "content-type": "application/json", "x-should-retry": "false" });
        response.end(JSON.stringify({ type: "error", error: { type: "permission_error", message: "Disposable classifier failure" } })); return;
      }
      // These are authored upstream verdicts, not Relay approvals. Cover both
      // outcomes through the installed parser and native permission machinery.
      const block = classifier === "block" || classifier === "review" && stage === "fast";
      content = [{ type: "text", text: classifier === "invalid" ? "not a classifier verdict" : block
        ? "<block>yes</block><category>User Deny Rules</category><reason>[User Deny Rules] Disposable refusal fixture.</reason>"
        : "<block>no</block>" }];
    } else {
      if (!body.tools?.some(tool => tool.name === "Bash")) throw Error(`Unrecognized native auxiliary request: ${system.slice(0, 2200)} ${text.slice(-2500)}`);
      mainRequests.push(body); assert(mainRequests.length <= 20, "Unexpected main-query loop");
      const results = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === "tool_result");
      const tool = input => [{ type: "tool_use", id: `shell_${mainRequests.length}`, name: "Bash", input }];
      if (phase === "run") {
        if (step === 0) { assert.match(text, /Running means launching the actual app/); content = tool({ command: "node application.mjs", description: "Start the disposable HTTP app", run_in_background: true }); }
        else { assert.equal(step, 1); assert(!results.at(-1).is_error, JSON.stringify(results.at(-1))); content = [{ type: "text", text: "The actual HTTP application is running." }]; }
      } else if (phase === "resume") {
        assert.equal(step, 0, "Each resumed input must produce exactly one main reply");
        assert(text.includes("Keep the fixture application running"));
        assert(JSON.stringify(body.messages.findLast(message => message.role === "user")?.content).includes(expectedResume), "The selected/resumed input must actually reach the native model request");
        resumedInputs.push(expectedResume);
        content = [{ type: "text", text: "Saved shell context retained without repeating the command." }];
      } else if (step === 0) content = tool({ command, description: "Append one marker in the disposable workspace" });
      else {
        assert.equal(step, 1); assert.equal(results.at(-1).is_error === true, denied, JSON.stringify(results.at(-1)));
        if (!denied) assert.match(JSON.stringify(results.at(-1)), /marker appended/);
        content = [{ type: "text", text: denied ? "The native shell command was denied." : "The literal shell command appended its marker." }];
      }
      step++;
    }
    if (process.argv.includes("--trace")) console.log(JSON.stringify({ phase, prefix, safety, title, model: body.model }));
    const block = content[0], tool = block.type === "tool_use", index = mainRequests.length + classifierRequests.length + titleCount;
    const message = { id: `msg_shell_${index}`, type: "message", role: "assistant", model: body.model, content, stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } };
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
    fixtureError = error; if (!response.headersSent) response.writeHead(500); response.end(); failureStop ||= manager?.shutdown();
  }); });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const config = loadConfig({ AGENT_DATA_DIR: root, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", AGENT_IDLE_TIMEOUT_MS: "60000", CLAUDE_AUTH_MODE: "gateway", ANTHROPIC_API_KEY: "controller-only-shell-fixture" });
    const store = new ChatStore(root); await store.initialize(); const broker = new CapabilityBroker({ ttlMs: 120000 });
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
          const event = JSON.parse(line); if (event.type === "control_request") nativeApprovals.push(event);
        } catch {} } }); return child;
      },
    }) };
    manager = new RuntimeManager({ store, config, broker, gatewayOrigin, workerBackend, adapterFactory: params => new ClaudeAdapter({ ...params, store, config, broker, gatewayOrigin }) });
    chat = await manager.createChat({ agent: "claude", title: "Native shell permission acceptance" });
    await manager.setMode(chat.id, "accept_edits");
    await writeFile(`${chat.workspace}/application.mjs`, `import http from 'node:http';
import {writeFile} from 'node:fs/promises';
let value = 'initial'; const server = http.createServer(async (req,res) => {
  if (req.method === 'POST') { value = ''; for await (const part of req) value += part; }
  res.setHeader('content-type','application/json'); res.end(JSON.stringify({pid:process.pid,value}));
});
server.listen(0,'127.0.0.1',async()=>{await writeFile('.application.json',JSON.stringify({port:server.address().port}));console.log('Fixture app ready');});
`);
    await writeFile(`${chat.workspace}/marker.mjs`, "import {appendFile} from 'node:fs/promises';\nawait appendFile('marker.txt','ação\\n'); console.log('marker appended');\n");
    const settings = { permissions: { allow: ["Bash(node application.mjs)"] } };
    await mkdir(`${store.runtimeHome(chat.id)}/claude`, { recursive: true });
    await writeFile(`${store.runtimeHome(chat.id)}/claude/settings.json`, JSON.stringify(settings));
    await manager.send(chat.id, "/run Keep the fixture application running."); if (fixtureError) throw fixtureError;
    let port; const deadline = Date.now() + 10000;
    while (!port && Date.now() < deadline) { try { port = JSON.parse(await readFile(`${chat.workspace}/.application.json`, "utf8")).port; } catch { await delay(25); } }
    assert(port); const appUrl = `http://127.0.0.1:${port}`, session = store.get(chat.id).agentSessionId;
    const state = await (await fetch(appUrl, { method: "POST", body: "preserve shell ação", signal: AbortSignal.timeout(2000) })).json();
    const checkApp = async () => { assert.deepEqual(await (await fetch(appUrl, { signal: AbortSignal.timeout(2000) })).json(), state); assert.equal(launches.length, 1); assert.equal(store.get(chat.id).agentSessionId, session); };
    const pending = async () => {
      const deadline = Date.now() + 15000;
      while (!store.get(chat.id).pendingRequest && !fixtureError && Date.now() < deadline) await delay(25);
      if (fixtureError) throw fixtureError;
      const value = store.get(chat.id).pendingRequest; assert(value, "An actual native Bash approval must reach Relay");
      assert.equal(JSON.parse(value.command).command, command); return value;
    };
    const within = async promise => {
      let timer;
      try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Native ${mode} did not finish: ${JSON.stringify(store.get(chat.id).pendingRequest)}`)), 20000); })]); }
      finally { clearTimeout(timer); }
    };
    await manager.setMode(chat.id, mode); phase = "shell"; step = 0;
    denied = mode === "dont_ask" || classified && ["block", "invalid", "error"].includes(classifier) || stop || sendNow;
    const running = manager.send(chat.id, "Run the marker command once and report its actual result.");
    if (mode !== "dont_ask" && (!classified || stop || sendNow)) {
      let approval;
      if (classified) {
        await within((async () => { while (!releaseClassifier && !fixtureError) await delay(25); if (fixtureError) throw fixtureError; })());
      } else approval = await pending();
      await assert.rejects(readFile(`${chat.workspace}/marker.txt`, "utf8"), { code: "ENOENT" }); await checkApp();
      if (stop || sendNow) {
        await manager.enqueue(chat.id, "Keep this unselected queued follow-up");
        if (sendNow) {
          await store.update(chat.id, { queuePaused: true });
          expectedResume = "Continue without replaying the shell command.";
          const queued = await manager.enqueue(chat.id, expectedResume); phase = "resume"; step = 0;
          await within(manager.sendQueuedNow(chat.id, queued.queuedMessages.at(-1).id));
        } else await within(manager.stop(chat.id));
        releaseClassifier?.();
        if (sendNow) {
          await within((async () => { while (manager.isBusy(chat.id) && !fixtureError) await delay(25); if (fixtureError) throw fixtureError; })());
          assert.deepEqual(resumedInputs, [expectedResume], "Send now must finish the selected input before checking its outcome");
        }
      } else await manager.respond(chat.id, approval.requestId, { decision: denied ? "decline" : "accept", updatedInput: { command: "node forged.mjs" } });
      await within(running); if (approval) await assert.rejects(manager.respond(chat.id, approval.requestId, { decision: "accept" }));
    } else await within(running);
    if (fixtureError) throw fixtureError;
    assert.equal(store.get(chat.id).mode, mode, "A shell verdict must not silently change the selected permission mode");
    if (denied) await assert.rejects(readFile(`${chat.workspace}/marker.txt`, "utf8"), { code: "ENOENT" });
    else assert.equal(await readFile(`${chat.workspace}/marker.txt`, "utf8"), "ação\n");
    if (mode === "dont_ask" || classified) assert.equal(nativeApprovals.length, 0, "The selected native policy must not ask the user");
    if (classified) {
      assert(classifierRequests.length > 0, "Auto/Plan must reach the actual safety classifier");
      if (!(stop || sendNow) && ["allow", "block", "review"].includes(classifier)) assert.deepEqual(classifierRequests.map(item => item.stage), classifier === "allow" ? ["fast"] : ["fast", "thinking"]);
      if (!(stop || sendNow) && classifier === "invalid") assert.deepEqual(classifierRequests.map(item => item.stage), [...Array(5).fill("fast"), ...Array(5).fill("thinking")]);
      if (!(stop || sendNow) && classifier === "error") assert.equal(new Set(classifierRequests.map(item => item.body.model)).size, 2, "The native fallback model must also fail closed");
    }
    if (!stop) await checkApp();
    if (sendNow) {
      // Let the late upstream reply drain, then complete another native turn
      // before Stop could mask an accidentally replayed shell action.
      await delay(250);
      expectedResume = "Confirm the interrupted shell action remains canceled."; step = 0;
      await within(manager.send(chat.id, expectedResume));
      if (fixtureError) throw fixtureError;
      await assert.rejects(readFile(`${chat.workspace}/marker.txt`, "utf8"), { code: "ENOENT" }); await checkApp();
    }
    if (!denied && !classified) {
      phase = "shell"; step = 0; denied = true;
      const repeated = manager.send(chat.id, "Repeat the exact marker command, but ask again.");
      const approval = await pending(); await manager.respond(chat.id, approval.requestId, { decision: "decline" }); await repeated;
      if (fixtureError) throw fixtureError; assert.equal(await readFile(`${chat.workspace}/marker.txt`, "utf8"), "ação\n"); await checkApp();
    }
    assert.deepEqual(JSON.parse(await readFile(`${store.runtimeHome(chat.id)}/claude/settings.json`, "utf8")), settings, "Once approvals must not persist a shell allow rule");
    await manager.stop(chat.id); await assert.rejects(fetch(appUrl, { signal: AbortSignal.timeout(2000) }));
    phase = "resume"; step = 0; expectedResume = "Continue from the saved shell context without restarting the app.";
    await manager.send(chat.id, expectedResume); if (fixtureError) throw fixtureError;
    assert.equal(store.get(chat.id).agentSessionId, session); assert.equal(launches.length, 2);
    assert.equal(resumedInputs.length, sendNow ? 3 : 1);
    if (stop || sendNow) assert.deepEqual(store.get(chat.id).queuedMessages.map(message => message.text), ["Keep this unselected queued follow-up"]);
    console.log(`PASS: actual native Bash effects, ${mode}${classified ? ` (${classifier} classifier)` : ""} permission decisions${stop ? ", Stop cancellation" : sendNow ? ", Send now cancellation" : ""}, exact once-only inputs, no persistent rule, retained app/data and same-context Stop/resume. ${mainRequests.length} main, ${classifierRequests.length} classifier and ${titleCount} title loopback replies.`);
  } finally {
    releaseClassifier?.();
    await failureStop; await manager?.shutdown(); server.closeAllConnections(); gatewayServer?.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), ...(gatewayServer ? [new Promise(resolve => gatewayServer.close(resolve))] : [])]);
    await rm(root, { recursive: true, force: true });
  }
}
