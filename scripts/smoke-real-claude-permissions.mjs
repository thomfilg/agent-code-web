import assert from "node:assert/strict";
import http from "node:http";
import readline from "node:readline";
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
import { buildWorkerEnvironment, spawnWorker, terminateWorker } from "../src/worker-process.mjs";
import { ClaudeControlChannel } from "../src/claude-mcp.mjs";

// Actual native /fewer-permission-prompts and permission enforcement. Seeded
// history and model replies are authored fixture data, never real user history.
// No personal profiles, real credentials, public network or live data.
const exec = promisify(execFile);
for (const option of process.argv.slice(2)) assert(["--network-isolated", "--trace", "--deny", "--application", "--untrusted"].includes(option));
if (!process.argv.includes("--network-isolated")) {
  const result = await exec("/usr/bin/unshare", ["--user", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL", "--", process.execPath, process.argv[1], ...process.argv.slice(2), "--network-isolated"], { timeout: 120000, killSignal: "SIGKILL", maxBuffer: 40000 }).catch(error => {
    process.stdout.write(error.stdout || ""); process.stderr.write(error.stderr || error.message); process.exit(1);
  });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); assert.match(result.stdout, /^PASS:/m);
} else {
  await exec("/usr/bin/ip", ["link", "set", "lo", "up"]);
  assert.deepEqual(JSON.parse((await exec("/usr/bin/ip", ["-j", "link", "show"])).stdout).map(item => item.ifname), ["lo"]);
  assert.equal((await exec("/usr/bin/ip", ["route", "show"])).stdout.trim(), "");
  const root = await mkdtemp("/tmp/relay-claude-permissions-"), requests = [], decisions = [], owners = [];
  const trace = process.argv.includes("--trace"), deny = process.argv.includes("--deny"), application = process.argv.includes("--application");
  const untrusted = process.argv.includes("--untrusted"), mustAsk = deny || untrusted;
  const readCommand = "relay-fixture-read list", rule = `Bash(${readCommand})`;
  const extraCommand = `${readCommand} --extra`, askCommand = "relay-fixture-read inspect", deniedCommand = "relay-fixture-remove fixture.txt";
  const initial = { env: { RELAY_PERMISSION_KEEP: "ação" }, permissions: { allow: ["Bash(relay-fixture-read version)"], deny: ["Bash(relay-fixture-remove *)"], ask: ["Bash(relay-fixture-read inspect)"] } };
  const updated = { ...initial, permissions: { ...initial.permissions, allow: [...initial.permissions.allow, rule] } };
  const userSettings = { env: { RELAY_PERMISSION_USER: "preserve" } }, localSettings = { env: { RELAY_PERMISSION_LOCAL: "preserve" } };
  let manager, store, gatewayServer, chat, failure, shutdown, expectedApproval, settingsFile, scanCommand, appState, appUrl;
  let step = -2, titles = 0, appStep = application ? 0 : null, stage = "before";
  const mainText = body => body.messages.flatMap(message => typeof message.content === "string" ? [message.content] : (message.content || []).map(block => block.text || "")).join("\n");
  const respond = async (request, response) => {
    if (request.url.includes("count_tokens")) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"input_tokens":100}'); return; }
    if (request.method !== "POST" || !/\/messages(?:\?|$)/.test(request.url)) { response.writeHead(404); response.end(); return; }
    assert.equal(request.headers["x-api-key"], "controller-only-permission-fixture");
    let raw = ""; for await (const part of request) raw += part;
    const body = JSON.parse(raw), text = mainText(body);
    let content;
    const done = text => [{ type: "text", text }];
    if (!body.tools?.length && text.includes("Write the title in the predominant language")) { titles++; content = done("Private permission fixture"); }
    else {
      requests.push(body); assert(requests.length <= 25, "Unexpected native permission inference loop");
      const result = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === "tool_result").at(-1);
      const check = pattern => { assert(result); assert(!result.is_error, JSON.stringify(result)); if (pattern) assert.match(JSON.stringify(result), pattern); };
      const tool = (name, input) => { assert(body.tools.some(tool => tool.name === name)); expectedApproval = { name, input }; return [{ type: "tool_use", id: `permission_${requests.length}`, name, input }]; };
      if (appStep === 0) { content = tool("Bash", { command: "node server.mjs", run_in_background: true, description: "Start the private fixture application" }); appStep++; }
      else if (appStep === 1) { check(); content = done("The private fixture application is running."); appStep = null; }
      else {
        if (step === -2) content = tool("Bash", { command: "relay-fixture-read version", description: "Verify the pre-existing exact project rule" });
        else if (step === -1) {
          if (untrusted) assert.equal(result?.is_error, true); else check(/fixture 1/);
          content = done(untrusted ? "The untrusted project's allow rule is not enabled." : "The pre-existing project rule is enforced without approval.");
        }
        else if (step === 0) content = tool("Bash", { command: readCommand, description: "Probe the exact read command before adding a rule" });
        else if (step === 1) { assert.equal(result?.is_error, true); content = done("The initial read command was denied; there is no allowlist entry yet."); }
        else if (step === 2) {
          assert.match(text, /# Fewer Permission Prompts/); assert.match(text, /Never allowlist a pattern that grants arbitrary code execution/);
          content = tool("Bash", { command: scanCommand, description: "Count actual tool calls in only this disposable profile's recent transcripts" });
        } else if (step === 3) {
          check(); const value = typeof result.content === "string" ? result.content : result.content.map(block => block.text || "").join("\n");
          const frequencies = JSON.parse(value.trim()); assert(frequencies[readCommand] >= 6); assert.equal(frequencies["relay-fixture-read version"], 5);
          assert.equal(frequencies["git status"], 5); assert.equal(frequencies["rm fixture.txt"], 4); assert.equal(frequencies["node -e fixture"], 5);
          content = tool("Read", { file_path: settingsFile });
        } else if (step === 4) {
          check(/RELAY_PERMISSION_KEEP/); check(/relay-fixture-read version/);
          content = tool("Write", { file_path: settingsFile, content: `${JSON.stringify(updated, null, 2)}\n` });
        } else if (step === 5) {
          if (deny) assert.equal(result?.is_error, true); else check();
          content = done(deny ? "The allowlist write was denied. Existing settings are unchanged." : `| Rank | Pattern | History count | Notes |\n| --- | --- | --- | --- |\n| 1 | ${rule} | at least 6 | Exact read-only fixture CLI |\n\nAdded one exact rule. The version rule already existed; skipped git status (auto-allowed), rm (mutation), node (arbitrary execution) and the rare command. Other settings were preserved.`);
        } else if (step === 6 || step === 8) content = tool("Bash", { command: readCommand, description: "Verify actual native permission enforcement without changing files" });
        else if (step === 7 || step === 9) {
          if (mustAsk) assert.equal(result?.is_error, true); else check(/Read-only fixture list: ação 7/);
          content = done(mustAsk ? "The exact read still requires approval; a saved rule is not a grant of workspace trust." : "The exact read ran through the native tool without another approval.");
        } else if (step === 10) content = tool("Bash", { command: extraCommand, description: "Verify the rule cannot authorize additional arguments" });
        else if (step === 11) {
          assert.equal(result?.is_error, true); content = tool("Bash", { command: askCommand, description: "Verify the existing ask rule remains enforced" });
        } else if (step === 12) {
          assert.equal(result?.is_error, true); content = tool("Bash", { command: deniedCommand, description: "Verify the existing deny rule blocks the tool without running it" });
        } else if (step === 13) {
          assert.equal(result?.is_error, true); assert.match(JSON.stringify(result), /denied/);
          content = done("Exact arguments, existing ask and existing deny rules remain enforced by the native permission engine.");
        } else throw Error(`Unexpected permission step ${step}`);
        step++;
      }
      if (trace) console.log("MODEL", JSON.stringify({ stage, step, tool: content[0].name, result: result ? JSON.stringify(result).slice(0, 450) : undefined }));
    }
    const block = content[0], isTool = block.type === "tool_use";
    const message = { id: `msg_permission_${requests.length}_${titles}`, type: "message", role: "assistant", model: body.model, content, stop_reason: isTool ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } };
    if (!body.stream) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(message)); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: isTool ? { ...block, input: {} } : { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: isTool ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  };
  const server = http.createServer((request, response) => { void respond(request, response).catch(error => {
    failure ||= error; if (!response.headersSent) response.writeHead(500); response.end(); shutdown ||= manager?.shutdown();
  }); });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const config = loadConfig({ AGENT_DATA_DIR: root, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", AGENT_IDLE_TIMEOUT_MS: "60000", CLAUDE_AUTH_MODE: "gateway", ANTHROPIC_API_KEY: "controller-only-permission-fixture" });
    store = new ChatStore(root); await store.initialize(); const broker = new CapabilityBroker({ ttlMs: 120000 });
    const gateway = new ProviderGateway({ config, broker, fetchImpl: (url, options) => fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}${new URL(url).search}`, options) });
    gatewayServer = http.createServer((request, response) => { void gateway.handle(request, response, new URL(request.url, "http://fixture")); });
    await new Promise(resolve => gatewayServer.listen(0, "127.0.0.1", resolve)); const gatewayOrigin = `http://127.0.0.1:${gatewayServer.address().port}`;
    await mkdir(`${root}/bin`, { mode: 0o700 });
    await writeFile(`${root}/bin/relay-fixture-read`, "#!/usr/bin/env node\nif(process.argv[2]==='list'&&process.argv.length===3)console.log('Read-only fixture list: ação 7');else if(process.argv[2]==='version')console.log('fixture 1');else process.exitCode=1;\n", { mode: 0o700 });
    const workerBackend = { sleep: async () => {}, shutdown: async () => {}, acquire: async current => ({
      workspace: current.workspace, runtimeHome: store.runtimeHome(current.id), metadata: { backend: "local" }, environmentPath: `${root}/bin:${process.env.PATH}`, mkdir: directory => mkdir(directory, { recursive: true, mode: 0o700 }),
      spawn(command, args, options) {
        assert(!JSON.stringify([args, options.env]).includes(config.claude.providerKey));
        const child = spawnWorker(command, args, options);
        if (command === config.claude.bin && args.includes("--print")) {
          owners.push(child);
          if (trace) {
            console.log("NATIVE_OWNER", JSON.stringify({ stage, count: owners.length, args }));
            child.stderr.on("data", chunk => { for (const line of String(chunk).split("\n")) if (/trusted|permission.*rule|Applying permission update|Ignoring \d+ permissions/.test(line)) console.log("NATIVE_DIAGNOSTIC", line); });
            let buffer = ""; child.stdout.on("data", chunk => {
              buffer += chunk; const lines = buffer.split("\n"); buffer = lines.pop();
              for (const line of lines) try {
                const event = JSON.parse(line), snapshot = event.response?.response;
                if (event.type === "control_request" && event.request?.subtype === "can_use_tool") console.log("NATIVE_PERMISSION", JSON.stringify(event.request));
                if (event.type === "control_response" && snapshot?.effective) console.log("NATIVE_SETTINGS", JSON.stringify({ permissions: snapshot.effective.permissions, sources: snapshot.sources?.map(source => ({ source: source.source, permissions: source.settings?.permissions })) }));
              } catch {}
            });
          }
        }
        return child;
      },
    }) };
    manager = new RuntimeManager({ store, config, broker, gatewayOrigin, workerBackend, adapterFactory: params => new ClaudeAdapter({ ...params, store, config, broker, gatewayOrigin }) });
    chat = await manager.createChat({ agent: "claude", title: "Native private allowlist fixture" }); await manager.setMode(chat.id, "default");
    const profile = `${store.runtimeHome(chat.id)}/claude`, initialWeb = store.get(chat.id);
    await mkdir(`${chat.workspace}/.claude`, { recursive: true, mode: 0o700 }); await mkdir(profile, { recursive: true, mode: 0o700 });
    settingsFile = `${chat.workspace}/.claude/settings.json`;
    await writeFile(settingsFile, JSON.stringify(initial)); await writeFile(`${profile}/settings.json`, JSON.stringify(userSettings)); await writeFile(`${chat.workspace}/.claude/settings.local.json`, JSON.stringify(localSettings));
    // Exercise the native consent protocol with an authored user decision,
    // never seed its private trust latch or disable the trust gate. A separate
    // idle consent session starts outside the target; set_cwd is a no-op when
    // already inside it. It receives no prompt or inference and is then closed.
    // Relay itself does not attest consent on the user's behalf.
    const consentDirectory = `${root}/consent`; await mkdir(consentDirectory, { mode: 0o700 });
    const consentCapability = broker.issue({ chatId: chat.id, provider: "anthropic" });
    const consentEnv = await buildWorkerEnvironment({ chat, store, provider: "anthropic", authMode: "gateway", capability: consentCapability, gatewayOrigin });
    const consentChild = spawnWorker(config.claude.bin, ["--print", "--verbose", "--output-format", "stream-json", "--input-format", "stream-json", "--permission-mode", "default"],
      { cwd: consentDirectory, env: consentEnv, stdio: ["pipe", "pipe", "pipe"] });
    const consentControl = new ClaudeControlChannel(consentChild, 15000), consentLines = readline.createInterface({ input: consentChild.stdout });
    consentLines.on("line", line => { try { consentControl.accept(JSON.parse(line)); } catch {} }); consentChild.stderr.resume();
    try {
      await consentControl.request("initialize");
      const offered = await consentControl.request("set_cwd", { path: chat.workspace });
      assert.deepEqual(offered, { status: "needs_trust", directory: chat.workspace });
      if (!untrusted) {
        const displayedConsent = { directory: offered.directory, decision: "accept" };
        const accepted = await consentControl.request("set_cwd", { path: chat.workspace, trust_accepted: displayedConsent.decision === "accept", trusted_directory: displayedConsent.directory });
        assert.deepEqual(accepted, { status: "ok", cwd: chat.workspace, changed: true, transcript_relocated: true });
      }
      assert.equal(requests.length, 0, "Workspace consent must not request inference");
    } finally { consentControl.close(); consentLines.close(); await terminateWorker(consentChild); broker.revoke(consentCapability); }
    const histories = [];
    for (let index = 0; index < 2; index++) {
      const directory = `${profile}/projects/authored-project-${index}`; await mkdir(directory, { recursive: true, mode: 0o700 });
      const commands = index === 0 ? Array(6).fill(readCommand).concat(Array(4).fill("relay-fixture-read version")) : Array(5).fill("git status").concat(Array(4).fill("rm fixture.txt"), Array(5).fill("node -e fixture"), ["relay-fixture-rare list"]);
      const contents = commands.map((command, id) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: `authored_${index}_${id}`, name: "Bash", input: { command } }] } })).join("\n") + "\n";
      const filename = `${directory}/authored-history.jsonl`; await writeFile(filename, contents); histories.push({ filename, contents });
    }
    const scan = `import fs from "node:fs/promises";const root=${JSON.stringify(`${profile}/projects`)},files=[];for(const project of await fs.readdir(root,{withFileTypes:true})){if(!project.isDirectory())continue;for(const name of await fs.readdir(root+"/"+project.name)){if(!name.endsWith(".jsonl"))continue;const file=root+"/"+project.name+"/"+name;files.push({file,time:(await fs.stat(file)).mtimeMs});}}files.sort((a,b)=>b.time-a.time);const counts={};for(const {file} of files.slice(0,50)){for(const line of (await fs.readFile(file,"utf8")).split("\\n")){if(!line)continue;let event;try{event=JSON.parse(line);}catch{continue;}if(event.type!=="assistant")continue;for(const block of event.message?.content||[]){if(block.type==="tool_use"&&block.name==="Bash"&&typeof block.input?.command==="string")counts[block.input.command]=(counts[block.input.command]||0)+1;}}}console.log(JSON.stringify(counts));`;
    scanCommand = `node --input-type=module -e '${scan.replaceAll("'", "'\\''")}'`;
    const other = await manager.createChat({ agent: "claude", title: "Unrelated permission fixture" });
    const submit = async text => {
      let finished = false;
      const sending = manager.send(chat.id, text).catch(error => { failure ||= error; }).finally(() => { finished = true; });
      const seen = new Set(), deadline = Date.now() + 40000;
      while (!finished && !failure && Date.now() < deadline) {
        const pending = store.get(chat.id).pendingRequest;
        if (pending && !seen.has(pending.requestId)) {
          seen.add(pending.requestId); const input = JSON.parse(pending.command);
          assert(expectedApproval && ["Bash", "Write"].includes(expectedApproval.name));
          if (expectedApproval.name === "Write") { assert.deepEqual(input, expectedApproval.input); assert.equal(input.file_path, settingsFile); }
          else assert.equal(input.command, expectedApproval.input.command);
          if (input.command === "relay-fixture-read version") assert(untrusted, "The pre-existing trusted project allowlist must already apply");
          assert.notEqual(input.command, deniedCommand, "The existing deny rule must block without offering approval");
          if (input.command === readCommand) assert(stage === "before" || mustAsk, "The native allowlist must authorize the exact command without another approval");
          const decline = [readCommand, "relay-fixture-read version", extraCommand, askCommand].includes(input.command) || deny && expectedApproval.name === "Write";
          decisions.push({ stage, tool: expectedApproval.name, command: input.command, decline });
          await manager.respond(chat.id, pending.requestId, { decision: decline ? "decline" : "accept" });
        }
        await delay(25);
      }
      if (failure) throw failure; assert(finished, "Native permission turn did not settle"); await sending;
    };
    if (application) {
      await writeFile(`${chat.workspace}/server.mjs`, "import http from 'node:http';import {writeFileSync} from 'node:fs';const state={pid:process.pid,value:'preserve-permission-app'};const server=http.createServer((req,res)=>res.end(JSON.stringify(state)));server.listen(0,'127.0.0.1',()=>writeFileSync('app.json',JSON.stringify({port:server.address().port})));\n");
      await submit("/run Start the private fixture server.mjs application.");
      const deadline = Date.now() + 10000;
      while (!appState && Date.now() < deadline) { try { appUrl = `http://127.0.0.1:${JSON.parse(await readFile(`${chat.workspace}/app.json`, "utf8")).port}`; appState = await (await fetch(appUrl, { signal: AbortSignal.timeout(1000) })).json(); } catch { await delay(25); } }
      assert(appState);
    }
    const checkApp = async () => { if (application) assert.deepEqual(await (await fetch(appUrl, { signal: AbortSignal.timeout(1000) })).json(), appState); };
    await submit("Verify the pre-existing project read rule."); assert.equal(step, 0);
    await submit("Probe the exact private read command before reviewing permissions."); assert.equal(step, 2);
    assert.equal(decisions.filter(decision => decision.command === readCommand).length, 1);
    stage = "review"; await submit("/fewer-permission-prompts Review only this private profile's history. Preserve existing settings and narrow read-only rules.\nKeep ação; no shared profiles."); assert.equal(step, 6);
    assert.deepEqual(JSON.parse(await readFile(settingsFile, "utf8")), deny ? initial : updated); await checkApp();
    const session = store.get(chat.id).agentSessionId;
    stage = "after"; await submit("Verify the exact read command after the permission review."); assert.equal(step, 8); await checkApp();
    if (application) assert.equal(owners.length, 1, "Permission changes must not replace a retained application's native owner");
    await manager.stop(chat.id); if (application) await assert.rejects(fetch(appUrl, { signal: AbortSignal.timeout(1000) }));
    stage = "resumed"; await submit("Verify the exact read command after Stop/resume."); assert.equal(step, 10); assert.equal(store.get(chat.id).agentSessionId, session);
    stage = "restrictions"; await submit("Verify extra arguments and the original ask/deny restrictions."); assert.equal(step, 14);
    assert.equal(decisions.filter(decision => decision.command === readCommand).length, mustAsk ? 3 : 1);
    for (const command of [extraCommand, askCommand]) assert.equal(decisions.filter(decision => decision.command === command && decision.decline).length, 1);
    assert.equal(decisions.filter(decision => decision.command === deniedCommand).length, 0);
    assert.equal(store.get(chat.id).mode, initialWeb.mode); assert.equal(store.get(chat.id).model, initialWeb.model);
    assert.deepEqual(JSON.parse(await readFile(`${profile}/settings.json`, "utf8")), userSettings);
    assert.deepEqual(JSON.parse(await readFile(`${chat.workspace}/.claude/settings.local.json`, "utf8")), localSettings);
    for (const history of histories) assert.equal(await readFile(history.filename, "utf8"), history.contents);
    assert.equal(store.get(other.id).messages.length, 0); await assert.rejects(readFile(`${other.workspace}/.claude/settings.json`), { code: "ENOENT" });
    assert(!store.get(chat.id).messages.some(message => message.kind === "error"));
    const trust = JSON.parse(await readFile(`${profile}/.claude.json`, "utf8"));
    assert.equal(trust.projects?.[chat.workspace]?.hasTrustDialogAccepted === true, !untrusted);
    const notices = store.get(chat.id).messages.filter(message => message.kind === "notice" && /workspace has not been trusted/.test(message.text));
    if (untrusted) assert(notices.length > 0, "The actual native trust warning must be visible in the chat, including startup");
    else assert.equal(notices.length, 0);
    assert(!notices.some(message => /hasTrustDialogAccepted|\.claude\.json|\/tmp\//.test(message.text)), "The notice must not publish raw private config paths or trust-latch edits");
    console.log(`PASS: native fewer-permission-prompts ${untrusted ? "untrusted workspace never gains implicit permission from saved rules" : deny ? "write refusal, unchanged rules and continued native approval requirements" : "private cross-project fixture-history scan, exact project-only allowlist merge, actual approval reduction and Stop/resume persistence"}${application ? "; existing HTTP app/PID/data retained until explicit Stop" : ""}; native workspace consent, deny/ask, user/local settings, original history and unrelated chat preserved; ${requests.length} authored replies, ${titles} titles, ${decisions.length} exact fixture tool decisions.`);
  } finally {
    await (shutdown ||= manager?.shutdown()); server.closeAllConnections(); gatewayServer?.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); if (gatewayServer) await new Promise(resolve => gatewayServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
