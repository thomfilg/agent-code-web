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

// Actual local marketplace installation, native command/skill expansion and
// tools. Only inference is authored; all profiles and network access are private.
const exec = promisify(execFile);
for (const option of process.argv.slice(2)) assert(["--network-isolated", "--trace", "--plan", "--application"].includes(option));
assert(!(process.argv.includes("--plan") && process.argv.includes("--application")));
if (!process.argv.includes("--network-isolated")) {
  const result = await exec("/usr/bin/unshare", ["--user", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL", "--", process.execPath, process.argv[1], ...process.argv.slice(2), "--network-isolated"], { timeout: 150000, killSignal: "SIGKILL", maxBuffer: 40000 }).catch(error => {
    process.stdout.write(error.stdout || ""); process.stderr.write(error.stderr || error.message); process.exit(1);
  });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); assert.match(result.stdout, /^PASS:/m);
} else {
  await exec("/usr/bin/ip", ["link", "set", "lo", "up"]);
  assert.deepEqual(JSON.parse((await exec("/usr/bin/ip", ["-j", "link", "show"])).stdout).map(item => item.ifname), ["lo"]);
  assert.equal((await exec("/usr/bin/ip", ["route", "show"])).stdout.trim(), "");
  const root = await mkdtemp("/tmp/relay-claude-plugins-"), requests = [], expected = [], launches = [];
  const plan = process.argv.includes("--plan"), trace = process.argv.includes("--trace");
  const application = process.argv.includes("--application");
  const market = "relay-fixture-market", alpha = "relay-fixture-alpha", beta = "relay-fixture-beta";
  const commandFor = name => `${name}:${name === beta ? "cu" : "stamp"}`;
  const release = Promise.withResolvers();
  let manager, gatewayServer, chat, failure, active, held = false, titles = 0, appUrl, appState, configured = false;
  const respond = async (request, response) => {
    if (request.url.includes("count_tokens")) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"input_tokens":100}'); return; }
    if (request.method !== "POST" || !/\/messages(?:\?|$)/.test(request.url)) { response.writeHead(404); response.end(); return; }
    assert.equal(request.headers["x-api-key"], "controller-only-plugins-fixture");
    let raw = ""; for await (const part of request) raw += part;
    const body = JSON.parse(raw), last = body.messages.findLast(message => message.role === "user");
    const lastText = typeof last?.content === "string" ? last.content : (last?.content || []).map(block => block.text || "").join("\n");
    let content;
    if (!body.tools?.length && lastText.includes("Write the title in the predominant language")) { titles++; content = [{ type: "text", text: "Native plugin fixture" }]; }
    else {
      requests.push(body); assert(requests.length <= 25, "Unexpected native inference loop");
      if (trace) console.log("NATIVE-INPUT", lastText.slice(-2000));
      if (!active) {
        active = expected.shift(); assert(active, "Unexpected inference from a local command");
        assert(lastText.includes(active.canary), "The selected plugin must expand its own instructions");
        assert(lastText.includes(active.args), "Native plugin arguments must preserve Unicode and newlines");
        if (active.hold) {
          held = true; await release.promise; content = [{ type: "text", text: "The held task completed." }]; active = null;
        } else content = [{ type: "tool_use", id: `plugin_${requests.length}`, name: active.launch ? "Bash" : "Write", input: active.launch
          ? { command: "node server.mjs", run_in_background: true, description: "Keep a real HTTP app alive across plugin reload" }
          : { file_path: `${chat.workspace}/${active.file}`, content: active.args } }];
      } else {
        const result = (last?.content || []).find(block => block.type === "tool_result"); assert(result);
        assert.equal(Boolean(result.is_error), plan, JSON.stringify(result));
        content = [{ type: "text", text: active.launch ? "The native HTTP application was started in the background." : `${plan ? "Native policy refused" : "Native plugin wrote"} ${active.file}.` }]; active = null;
      }
    }
    const block = content[0], tool = block.type === "tool_use";
    const message = { id: `msg_plugin_${requests.length + titles}`, type: "message", role: "assistant", model: body.model, content, stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } };
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
    const config = loadConfig({ AGENT_DATA_DIR: root, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", AGENT_IDLE_TIMEOUT_MS: "60000", CLAUDE_AUTH_MODE: "gateway", ANTHROPIC_API_KEY: "controller-only-plugins-fixture" });
    const store = new ChatStore(root); await store.initialize(); const broker = new CapabilityBroker({ ttlMs: 180000 }), commands = new CommandCatalog({ ...config, workerBackend: "ec2" }, null, {
      installed: async () => configured ? [{ name: commandFor(beta), aliases: ["cu"], description: "Configured arbitrary alias fixture" }] : [],
    });
    const gateway = new ProviderGateway({ config, broker, fetchImpl: (url, options) => fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}${new URL(url).search}`, options) });
    gatewayServer = http.createServer((request, response) => { void gateway.handle(request, response, new URL(request.url, "http://fixture")); });
    await new Promise(resolve => gatewayServer.listen(0, "127.0.0.1", resolve)); const gatewayOrigin = `http://127.0.0.1:${gatewayServer.address().port}`;
    const workerBackend = { sleep: async () => {}, shutdown: async () => {}, acquire: async current => ({
      workspace: current.workspace, runtimeHome: store.runtimeHome(current.id), metadata: { backend: "local" }, mkdir: directory => mkdir(directory, { recursive: true, mode: 0o700 }),
      spawn(bin, args, options) {
        assert(!JSON.stringify([args, options.env]).includes(config.claude.providerKey));
        const child = spawnWorker(bin, args, options); if (bin === config.claude.bin && args.includes("--print")) launches.push(child); return child;
      },
    }) };
    manager = new RuntimeManager({ store, config, broker, gatewayOrigin, commands, workerBackend, adapterFactory: params => new ClaudeAdapter({ ...params, store, config, broker, gatewayOrigin }) });
    chat = await manager.createChat({ agent: "claude", title: "Native plugin namespaces" });
    if (plan) manager.on("event", event => {
      if (event.type === "request") void manager.respond(chat.id, event.request.requestId, { decision: "decline" }).catch(error => { failure ||= error; });
    });
    const other = await manager.createChat({ agent: "claude", title: "No plugin installation" });
    await manager.setMode(chat.id, plan ? "plan" : "accept_edits");
    const environment = await commands.env("claude", chat);
    const cli = async args => {
      const result = await exec(config.claude.bin, ["plugin", ...args], { cwd: chat.workspace, env: environment, timeout: 20000, maxBuffer: 10000 });
      if (trace) console.log("NATIVE-PLUGIN", args[0], result.stdout.trim()); return result.stdout;
    };
    const submit = async text => {
      const before = store.get(chat.id).messages.length; await manager.send(chat.id, text); if (failure) throw failure;
      const added = store.get(chat.id).messages.slice(before); assert(!added.some(message => message.kind === "error"), JSON.stringify(added));
      assert(added.some(message => message.role === "assistant" || message.kind === "notice"), "Native commands need visible completion");
    };
    const local = async text => {
      const before = requests.length; await submit(text); assert.equal(requests.length, before, "Local plugin reload must not call a model");
      assert.match(store.get(chat.id).messages.at(-1).text, /^Reloaded \d+ plugin\(s\),/);
      if (trace) console.log("NATIVE-CATALOG", JSON.stringify(store.get(chat.id).commandCatalog.map(command => command.name)));
    };
    const visible = async target => (await commands.list(store.get(target.id))).commands.map(command => command.name);
    assert(!(await visible(chat)).some(name => name.startsWith("relay-fixture-")));
    const otherCatalog = await commands.list(other);
    await local("/reload-plugins");
    assert.equal(store.get(chat.id).agentSessionId, null);
    await manager.stop(chat.id);
    assert.notEqual(launches[0].exitCode ?? launches[0].signalCode, null);
    await local("/reload-plugins");
    assert.equal(launches.length, 2, "A control-only first session must restart without attempting a missing native journal");
    const checkApp = async () => { if (application) assert.deepEqual(await (await fetch(appUrl, { signal: AbortSignal.timeout(2000) })).json(), appState); };
    const marketplace = `${root}/marketplace`; await mkdir(`${marketplace}/.claude-plugin`, { recursive: true });
    await writeFile(`${marketplace}/.claude-plugin/marketplace.json`, JSON.stringify({ name: market, owner: { name: "Disposable fixture" }, plugins: [alpha, beta].map(name => ({ name, source: `./plugins/${name}` })) }));
    for (const name of [alpha, beta]) {
      const plugin = `${marketplace}/plugins/${name}`;
      await mkdir(`${plugin}/.claude-plugin`, { recursive: true }); await writeFile(`${plugin}/.claude-plugin/plugin.json`, JSON.stringify({ name, version: "1.0.0", description: "Disposable namespace acceptance" }));
      const folder = name === alpha ? "commands" : "skills/cu"; await mkdir(`${plugin}/${folder}`, { recursive: true });
      await writeFile(`${plugin}/${folder}/${name === alpha ? "stamp.md" : "SKILL.md"}`, `---\nname: ${name === beta ? "cu" : "stamp"}\ndescription: Write this plugin's supplied fixture text\nuser-invocable: true\n---\nRELAY_PLUGIN_CANARY_${name}\nWrite the exact supplied arguments to the requested workspace file, preserving native permission policy.\nArguments:\n$ARGUMENTS\n`);
    }
    await cli(["marketplace", "add", marketplace]);
    for (const name of [alpha, beta]) await cli(["install", `${name}@${market}`, "--scope", "local"]);
    configured = true;
    // Skills are loaded at native process startup. Production installs them
    // before starting the worker, so reproduce that boundary exactly.
    await manager.stop(chat.id);
    await local("/reload-plugins");
    assert.equal(launches.length, 3, "Installed skills must be discovered by the new native owner");
    const owner = launches[2];
    assert.equal(owner.exitCode ?? owner.signalCode, null);
    if (application) {
      await writeFile(`${store.runtimeHome(chat.id)}/claude/settings.json`, JSON.stringify({ permissions: { allow: ["Bash(node server.mjs)"] } }));
      await writeFile(`${chat.workspace}/server.mjs`, "import http from 'node:http';import {writeFile} from 'node:fs/promises';const state={pid:process.pid,value:'Keep this app and its state'};const server=http.createServer((req,res)=>res.end(JSON.stringify(state)));server.listen(0,'127.0.0.1',async()=>{await writeFile('.runtime.json',JSON.stringify({port:server.address().port}));console.log('HTTP fixture ready');});");
      expected.push({ canary: "Start this fixture HTTP app", args: "Start this fixture HTTP app", launch: true });
      await submit("Start this fixture HTTP app with node server.mjs and keep it running.");
      const ready = Date.now() + 10000;
      while (!appUrl && Date.now() < ready) {
        try { const { port } = JSON.parse(await readFile(`${chat.workspace}/.runtime.json`, "utf8")); const url = `http://127.0.0.1:${port}`; appState = await (await fetch(url, { signal: AbortSignal.timeout(1000) })).json(); appUrl = url; }
        catch { await delay(25); }
      }
      assert(appUrl);
    }
    await checkApp();
    for (const name of [alpha, beta]) assert((await visible(chat)).includes(commandFor(name)), `Native installation must expose ${commandFor(name)}`);
    assert((await visible(chat)).includes("cu"), "Configured arbitrary aliases must be restored even when native discovery omits them");
    assert((await visible(chat)).includes("reload-plugins"), "The implemented SDK control must be offered even when native terminal discovery omits it");
    assert.equal(await commands.list(other), otherCatalog, "The other chat's catalog must not be invalidated");
    assert(!(await commands.claude(other)).some(command => command.name.startsWith("relay-fixture-")), "Private plugin installation must not cross chats");
    if (!application) assert.equal(store.get(chat.id).agentSessionId, null, "A control-only reload must not publish an unjournaled resume ID");
    const instruction = (name, file) => ({ canary: `RELAY_PLUGIN_CANARY_${name}`, args: `Target: ${file}\nKeep ${name}; ação, café and the next line.\nDo not change any other file.`, file });
    const checkFile = async item => {
      if (plan) return assert.rejects(readFile(`${chat.workspace}/${item.file}`), { code: "ENOENT" });
      try { assert.equal(await readFile(`${chat.workspace}/${item.file}`, "utf8"), item.args); }
      catch (error) {
        if (trace) console.log("FAILED-COMMAND", JSON.stringify({ item, messages: store.get(chat.id).messages.slice(-6) }));
        throw error;
      }
    };
    for (const name of [alpha, beta]) {
      const item = instruction(name, `${name}.txt`), command = name === beta ? "cu" : commandFor(name);
      expected.push(item); await submit(`/${command} ${item.args}`); await checkFile(item);
    }
    const session = store.get(chat.id).agentSessionId;
    expected.push({ canary: "Hold this ordinary task", args: "Hold this ordinary task", hold: true });
    const current = submit("Hold this ordinary task while I queue two plugin commands.");
    const deadline = Date.now() + 15000; while (!held && !failure && Date.now() < deadline) await delay(25); if (failure) throw failure; assert(held);
    const queued = [instruction(beta, "queued-beta.txt"), instruction(alpha, "queued-alpha.txt")];
    for (const [index, name] of [beta, alpha].entries()) { expected.push(queued[index]); await manager.enqueue(chat.id, `/${commandFor(name)} ${queued[index].args}`); }
    assert.equal(store.get(chat.id).queuedMessages.length, 2); release.resolve(); await current;
    const drained = Date.now() + 20000; while ((manager.isBusy(chat.id) || store.get(chat.id).queuedMessages.length) && !failure && Date.now() < drained) await delay(25);
    if (failure) throw failure; assert.equal(manager.isBusy(chat.id), false); assert.equal(store.get(chat.id).queuedMessages.length, 0);
    for (const item of queued) await checkFile(item);
    assert.equal(launches.length, 3, "Native installed commands must run on the owner that loaded them");
    await checkApp();
    await manager.stop(chat.id);
    if (application) await assert.rejects(fetch(appUrl, { signal: AbortSignal.timeout(2000) }));
    const resumed = instruction(alpha, "resumed-alpha.txt"); expected.push(resumed); await submit(`/${commandFor(alpha)} ${resumed.args}`); await checkFile(resumed);
    assert.equal(store.get(chat.id).agentSessionId, session);
    await cli(["disable", `${alpha}@${market}`, "--scope", "local"]); await local("/reload-plugins");
    const disabled = await visible(chat); assert(!disabled.includes(commandFor(alpha))); assert(disabled.includes(commandFor(beta)));
    const beforeEnable = launches.length;
    await cli(["enable", `${alpha}@${market}`, "--scope", "local"]); await manager.stop(chat.id); await local("/reload-plugins --force");
    const reloadOwner = launches.at(-1); assert((await visible(chat)).includes(commandFor(alpha)));
    const enabled = instruction(alpha, "re-enabled-alpha.txt"); expected.push(enabled); await submit(`/${commandFor(alpha)} ${enabled.args}`); await checkFile(enabled);
    assert.equal(launches.length, beforeEnable + 1); assert.equal(reloadOwner.exitCode ?? reloadOwner.signalCode, null);
    assert.equal(expected.length, 0); assert.equal(active, null); assert.equal(store.get(chat.id).mode, plan ? "plan" : "accept_edits");
    assert.equal(store.get(other.id).messages.length, 0);
    console.log(`PASS: installed legacy-command and skill namespaces, actual ${plan ? "native Plan refusals" : "file effects"}, FIFO, Stop/resume, reload/disable/enable and other-chat isolation${application ? "; same HTTP app/state survive reload until explicit Stop" : ""}; ${requests.length} authored main replies, ${titles} titles.`);
  } finally {
    release.resolve(); await manager?.shutdown(); server.closeAllConnections(); gatewayServer?.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); if (gatewayServer) await new Promise(resolve => gatewayServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
