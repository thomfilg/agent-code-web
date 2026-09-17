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
import { CommandCatalog } from "../src/command-catalog.mjs";
import { doctorExtensions } from "./fixtures/claude-doctor-extensions.mjs";

// Real installed native prompt, tools and questions; authored model responses.
// All work/config/history is disposable and networking is loopback-only. Never
// run doctor against the user's installation, personal profile or live chat.
const exec = promisify(execFile);
const options = new Set(process.argv.slice(2));
for (const option of options) assert(["--network-isolated", "--trace", "--alias", "--deny-cleanup", "--deny-permissions", "--skip", "--stop-cleanup", "--application", "--broken-user", "--broken-project", "--extensions"].includes(option));
assert(!options.has("--extensions") || !options.has("--broken-user") && !options.has("--broken-project"));
if (!options.has("--network-isolated")) {
  // The extended one-shot scenario performs eleven native query startups,
  // including independent Skill probes before and after Stop. Only its total
  // fixture budget grows; every query retains the same 40-second deadline.
  const timeout = options.has("--extensions") && !options.has("--application") ? 300000 : 120000;
  const result = await exec("/usr/bin/unshare", ["--user", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL", "--", process.execPath, process.argv[1], ...options, "--network-isolated"], { timeout, killSignal: "SIGKILL", maxBuffer: 40000 }).catch(error => {
    process.stdout.write(error.stdout || ""); process.stderr.write(error.stderr || error.message); process.exit(1);
  });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); assert.match(result.stdout, /^PASS:/m);
} else {
  await exec("/usr/bin/ip", ["link", "set", "lo", "up"]);
  assert.deepEqual(JSON.parse((await exec("/usr/bin/ip", ["-j", "link", "show"])).stdout).map(item => item.ifname), ["lo"]);
  assert.equal((await exec("/usr/bin/ip", ["route", "show"])).stdout.trim(), "");
  const root = await mkdtemp("/tmp/relay-claude-doctor-"), requests = [], decisions = [], owners = [], controls = [], reloads = [];
  const trace = options.has("--trace"), skip = options.has("--skip"), cleanup = !skip && !options.has("--deny-cleanup"), permissions = !skip && !options.has("--deny-permissions");
  const application = options.has("--application"), broken = options.has("--broken-user") || options.has("--broken-project");
  const stopCleanup = options.has("--stop-cleanup"); let cancelled = false;
  const userSettings = { env: { RELAY_DOCTOR_KEEP: "ação" } }, localSettings = { env: { RELAY_DOCTOR_LOCAL: "preserve" }, permissions: { deny: ["Bash(relay-doctor-delete *)"], ask: ["Bash(relay-doctor-read inspect)"] } };
  const rule = "Bash(relay-doctor-read list)", updatedLocal = { ...localSettings, permissions: { ...localSettings.permissions, allow: [rule] } };
  const originalMemory = "# Local notes\n\nUse npm test.\nNever publish fixture credentials.\n", cleanedMemory = "# Local notes\n\nNever publish fixture credentials.\n";
  let manager, store, gatewayServer, failure, shutdown, chat, profile, localFile, auditCommand, expectedTool, appState, appUrl, extensions, activeProbe;
  let extensionStep = 0;
  const cleanedLocal = () => extensions && cleanup && !cancelled ? extensions.disabledLocal : localSettings;
  const finalLocal = () => ({ ...cleanedLocal(), ...(permissions && !cancelled ? { permissions: updatedLocal.permissions } : {}) });
  let phase = application ? "application" : "doctor", step = 0, titles = 0;
  const mainText = body => body.messages.flatMap(message => typeof message.content === "string" ? [message.content] : (message.content || []).map(block => block.text || "")).join("\n");
  const question = (header, text, choices) => ({ questions: [{ header, question: text, multiSelect: false, options: choices.map(label => ({ label, description: label })) }] });
  const cleanupChoices = ["Clean up everything (recommended)", "Let me pick", "No, keep everything"];
  const permissionChoices = ["Allow the exact read command", "Keep current permissions"];
  const respond = async (request, response) => {
    if (request.url.includes("count_tokens")) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"input_tokens":100}'); return; }
    if (request.method !== "POST" || !/\/messages(?:\?|$)/.test(request.url)) { response.writeHead(404); response.end(); return; }
    assert.equal(request.headers["x-api-key"], "controller-only-doctor-fixture");
    let raw = ""; for await (const part of request) raw += part;
    const body = JSON.parse(raw), text = mainText(body);
    let content;
    const done = text => [{ type: "text", text }];
    if (!body.tools?.length && text.includes("Write the title in the predominant language")) { titles++; content = done("Private doctor fixture"); }
    else {
      requests.push(body); assert(requests.length <= 40, "Unexpected doctor inference loop");
      const result = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === "tool_result").at(-1);
      const check = pattern => { assert(result); assert(!result.is_error, JSON.stringify(result)); if (pattern) assert.match(JSON.stringify(result), pattern); };
      const tool = (name, input) => { assert(body.tools.some(tool => tool.name === name)); expectedTool = { name, input }; return [{ type: "tool_use", id: `doctor_${requests.length}`, name, input }]; };
      if (phase === "application") {
        if (!step++) content = tool("Bash", { command: "node server.mjs", run_in_background: true, description: "Start the disposable fixture app" });
        else { check(); content = done("Private fixture app is running."); }
      } else if (phase === "doctor") {
        if (step === 0) {
          assert(text.includes("# Claude Code Doctor"), "The actual native doctor prompt must expand"); assert(/separate permission/i.test(text), "The native prompt must require independent permission consent");
          assert.match(text, /Only inspect this disposable workspace/); assert.match(text, /Preserve ação/);
          content = tool("Bash", { command: auditCommand, description: "Read-only fixture configuration and memory audit; no setting values printed" }); step++;
        } else if (step === 1) {
          check(/duplicateMemory/); check(broken ? /invalidJson.*true/ : /invalidJson.*false/);
          content = tool("AskUserQuestion", question("Cleanup", `Audit: one duplicated local instruction; ${broken ? "one invalid settings JSON (reported only; repair was not requested)" : "settings JSON parses"}. Remove only the duplicate 'Use npm test.' line from CLAUDE.local.md, retaining the safety rule?${extensions?.proposal || ""}`, cleanupChoices)); step++;
        } else if (step === 2) {
          if (skip) assert(result.is_error); else check(cleanup ? /Clean up everything/ : /No, keep everything/);
          if (cleanup) { content = tool("Read", { file_path: `${chat.workspace}/CLAUDE.local.md` }); step = 2.5; }
          else step = 4;
        } else if (step === 2.5) { check(/Never publish fixture credentials/); content = tool("Write", { file_path: `${chat.workspace}/CLAUDE.local.md`, content: cleanedMemory }); step = 3; }
        else if (step === 3) { check(); step = extensions ? "extensions" : 4; }
        else if (step === "extensions") { check(); extensionStep++; if (extensionStep === extensions.changes.length) step = 4; }
        if (step === "extensions" && !content) {
          const change = extensions.changes[extensionStep]; content = tool(change.name, change.input);
        }
        if (step === 4 && !content) {
          content = tool("AskUserQuestion", question("Permissions", `Separate permission proposal: add only ${rule} to this project's .claude/settings.local.json. Cleanup approval does not grant this permission. Keep all existing ask/deny rules.`, permissionChoices)); step++;
        } else if (step === 5 && !content) {
          if (skip) assert(result.is_error); else check(permissions ? /Allow the exact read command/ : /Keep current permissions/);
          if (permissions) { content = tool("Read", { file_path: localFile }); step = 5.5; }
          else step = 7;
        } else if (step === 5.5 && !content) { check(/RELAY_DOCTOR_LOCAL/); content = tool("Write", { file_path: localFile, content: `${JSON.stringify(finalLocal(), null, 2)}\n` }); step = 6; }
        else if (step === 6 && !content) { check(); step = 7; }
        if (step === 7 && !content) {
          content = done(`Doctor audit finished. ${cleanup ? "Removed only the duplicate instruction; undo by restoring that line." : "Cleanup declined; memory unchanged."} ${permissions ? "Added one exact project-local read rule; undo by removing that entry." : "Permission change declined; existing rules unchanged."}${broken ? " Invalid JSON remains; no repair was requested." : ""} No installation, account, network update or other workspace was changed.`); step++;
        }
        assert(content, `Missing doctor step ${step}`);
      } else if (phase === "permission") {
        if (!step++) content = tool("Bash", { command: "relay-doctor-read list", description: "Verify the actual native permission effect" });
        else { if (permissions) check(/Doctor fixture read: ação/); else assert(result.is_error); content = done("Native permission check complete."); }
      } else if (phase === "resume") {
        assert.match(text, cancelled ? /# Claude Code Doctor/ : /Doctor audit finished/); content = done("Doctor journal retained after Stop; no application restarted.");
      } else if (phase === "extension-probe") {
        if (!step++) content = tool("Skill", { skill: activeProbe.name });
        else {
          const disabled = cleanup && !cancelled && !activeProbe.keep;
          if (disabled) { assert.equal(result?.is_error, true, `Disabled extension ${activeProbe.name} must not execute`); assert(!text.includes(activeProbe.marker), "A disabled native skill must not expand"); }
          else { check(); assert(text.includes(activeProbe.marker), `Enabled extension ${activeProbe.name} must expand its actual body`); }
          content = done(`Native extension ${activeProbe.name} ${disabled ? "cannot execute" : "still executes"}.`);
        }
      } else throw Error("Unexpected fixture phase");
      if (trace) console.log("MODEL", JSON.stringify({ phase, step, tool: content[0].name, result: result ? JSON.stringify(result).slice(0, 300) : undefined }));
    }
    const block = content[0], isTool = block.type === "tool_use";
    const message = { id: `msg_doctor_${requests.length}_${titles}`, type: "message", role: "assistant", model: body.model, content, stop_reason: isTool ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } };
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
    const config = loadConfig({ AGENT_DATA_DIR: root, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", AGENT_IDLE_TIMEOUT_MS: "60000", CLAUDE_AUTH_MODE: "gateway", ANTHROPIC_API_KEY: "controller-only-doctor-fixture" });
    store = new ChatStore(root); await store.initialize(); const broker = new CapabilityBroker({ ttlMs: 120000 }), commands = new CommandCatalog(config);
    const gateway = new ProviderGateway({ config, broker, fetchImpl: (url, options) => fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}${new URL(url).search}`, options) });
    gatewayServer = http.createServer((request, response) => { void gateway.handle(request, response, new URL(request.url, "http://fixture")); });
    await new Promise(resolve => gatewayServer.listen(0, "127.0.0.1", resolve)); const gatewayOrigin = `http://127.0.0.1:${gatewayServer.address().port}`;
    await mkdir(`${root}/bin`, { mode: 0o700 });
    await writeFile(`${root}/bin/relay-doctor-read`, "#!/usr/bin/env node\nif(process.argv[2]==='list'&&process.argv.length===3)console.log('Doctor fixture read: ação');else process.exitCode=1;\n", { mode: 0o700 });
    const workerBackend = { sleep: async () => {}, shutdown: async () => {}, acquire: async current => ({
      workspace: current.workspace, runtimeHome: store.runtimeHome(current.id), metadata: { backend: "local" }, environmentPath: `${root}/bin:${process.env.PATH}`, mkdir: directory => mkdir(directory, { recursive: true, mode: 0o700 }),
      spawn(command, args, options) {
        assert(!JSON.stringify([args, options.env]).includes(config.claude.providerKey));
        const child = spawnWorker(command, args, options);
        if (command === config.claude.bin && args.includes("--print") && options.cwd === current.workspace) {
          owners.push(child); let buffer = "";
          child.stdout.on("data", chunk => { buffer += chunk; const lines = buffer.split("\n"); buffer = lines.pop(); for (const line of lines) try {
            const event = JSON.parse(line), receipt = event.response?.response;
            if (event.type === "control_response" && receipt?.effective) controls.push(receipt);
            if (event.type === "control_response" && Array.isArray(receipt?.plugins) && Number.isSafeInteger(receipt.error_count)) reloads.push(receipt);
          } catch {} });
        }
        return child;
      },
    }) };
    manager = new RuntimeManager({ store, config, broker, gatewayOrigin, commands, workerBackend, adapterFactory: params => new ClaudeAdapter({ ...params, store, config, broker, gatewayOrigin }) });
    chat = await manager.createChat({ agent: "claude", title: "Native doctor fixture" }); await manager.setMode(chat.id, "default");
    profile = `${store.runtimeHome(chat.id)}/claude`; localFile = `${chat.workspace}/.claude/settings.local.json`;
    await mkdir(`${chat.workspace}/.claude`, { recursive: true, mode: 0o700 }); await mkdir(profile, { recursive: true, mode: 0o700 });
    await writeFile(`${profile}/settings.json`, JSON.stringify(userSettings)); await writeFile(localFile, JSON.stringify(localSettings));
    await writeFile(`${chat.workspace}/CLAUDE.md`, "# Project\n\nUse npm test.\n"); await writeFile(`${chat.workspace}/CLAUDE.local.md`, originalMemory);
    const offered = await manager.nativeWorkspaceTrust(chat.id, "inspect");
    await manager.nativeWorkspaceTrust(chat.id, "confirm", { reviewId: offered.reviewId, confirm: true });
    if (options.has("--extensions")) extensions = await doctorExtensions({ root, chat, profile, config, commands, exec, userSettings, localSettings });
    const originalWeb = store.get(chat.id), other = await manager.createChat({ agent: "claude", title: "Unrelated doctor fixture" });
    if (extensions) await commands.list(other);
    const otherCatalog = extensions ? [...commands.cache].find(([key]) => key.startsWith(`${other.id}:`)) : null;
    const submit = async text => {
      let finished = false;
      const sending = manager.send(chat.id, text).catch(error => { failure ||= error; }).finally(() => { finished = true; });
      const seen = new Set(), deadline = Date.now() + 40000;
      while (!finished && !failure && Date.now() < deadline) {
        const pending = store.get(chat.id).pendingRequest;
        if (pending && !seen.has(pending.requestId)) {
          seen.add(pending.requestId); assert(expectedTool);
          if (expectedTool.name === "AskUserQuestion") {
            assert.equal(pending.questions.length, 1); const isCleanup = pending.questions[0].header === "Cleanup";
            assert.equal(await readFile(`${chat.workspace}/CLAUDE.local.md`, "utf8"), isCleanup || !cleanup ? originalMemory : cleanedMemory);
            assert.deepEqual(JSON.parse(await readFile(localFile, "utf8")), isCleanup ? localSettings : cleanedLocal(), "No permission write before separate consent");
            if (stopCleanup) {
              assert(isCleanup); cancelled = true;
              await manager.enqueue(chat.id, "Keep this input queued after doctor cancellation");
              await manager.stop(chat.id); await sending;
              assert.equal(store.get(chat.id).pendingRequest, null);
              await assert.rejects(manager.respond(chat.id, pending.requestId, { answers: { question_1: [cleanupChoices[0]] } }), /chat runtime is not active/);
              break;
            }
            const answer = isCleanup ? cleanupChoices[cleanup ? 0 : 2] : permissionChoices[permissions ? 0 : 1];
            decisions.push({ question: isCleanup ? "cleanup" : "permissions", answer: skip ? null : answer });
            await manager.respond(chat.id, pending.requestId, { answers: skip ? {} : { question_1: [answer] } });
          } else {
            const input = JSON.parse(pending.command); assert.deepEqual(input, expectedTool.input);
            assert(["Bash", "Read", "Write", "Skill"].includes(expectedTool.name));
            if (["Read", "Write"].includes(expectedTool.name)) assert([localFile, `${chat.workspace}/CLAUDE.local.md`, extensions?.userFile].includes(input.file_path));
            if (expectedTool.name === "Skill") assert.equal(input.skill, activeProbe.name);
            if (input.command === "relay-doctor-read list") assert(!permissions, "Granted exact rule should not prompt again");
            decisions.push({ tool: expectedTool.name, command: input.command });
            await manager.respond(chat.id, pending.requestId, { decision: input.command === "relay-doctor-read list" ? "decline" : "accept" });
          }
        }
        await delay(25);
      }
      if (failure) throw failure; assert(finished, "Native doctor did not settle"); await sending;
    };
    if (application) {
      await writeFile(`${chat.workspace}/server.mjs`, "import http from 'node:http';import {writeFileSync} from 'node:fs';const state={pid:process.pid,value:'preserve-doctor-app'};http.createServer((req,res)=>res.end(JSON.stringify(state))).listen(0,'127.0.0.1',function(){writeFileSync('app.json',JSON.stringify({port:this.address().port}));});\n");
      await submit("/run Start the private fixture server.mjs application.");
      appUrl = `http://127.0.0.1:${JSON.parse(await readFile(`${chat.workspace}/app.json`, "utf8")).port}`;
      appState = await (await fetch(appUrl, { signal: AbortSignal.timeout(1000) })).json();
    }
    const configFile = options.has("--broken-project") ? `${chat.workspace}/.claude/settings.json` : `${profile}/settings.json`;
    if (broken) await writeFile(configFile, '{"env": {"RELAY_INVALID": ');
    const audit = `import fs from "node:fs";let invalidJson=false;try{JSON.parse(fs.readFileSync(${JSON.stringify(configFile)},"utf8"));}catch{invalidJson=true;}console.log(JSON.stringify({invalidJson,duplicateMemory:fs.readFileSync("CLAUDE.local.md","utf8").includes("Use npm test.")}));`;
    auditCommand = `node --input-type=module -e '${audit.replaceAll("'", "'\\''")}'`;
    phase = "doctor"; step = 0;
    const command = `${options.has("--alias") ? "/checkup" : "/doctor"} Only inspect this disposable workspace. Diagnose invalid JSON without repairing it. Do not install, uninstall, update, access accounts or access the network. Preserve ação.`;
    await submit(command); assert.equal(step, cancelled ? 2 : 8);
    assert(controls.length >= (cancelled ? 1 : 2), "Doctor must inspect native settings, without late readback after Stop");
    assert.deepEqual(decisions.filter(item => item.question).map(item => item.question), cancelled ? [] : ["cleanup", "permissions"]);
    assert.equal(await readFile(`${chat.workspace}/CLAUDE.local.md`, "utf8"), cleanup && !cancelled ? cleanedMemory : originalMemory);
    assert.deepEqual(JSON.parse(await readFile(localFile, "utf8")), finalLocal());
    if (broken) assert.equal(await readFile(configFile, "utf8"), '{"env": {"RELAY_INVALID": ');
    else assert.deepEqual(JSON.parse(await readFile(`${profile}/settings.json`, "utf8")), extensions ? cleanup && !cancelled ? extensions.disabledUser : extensions.installedUser : userSettings);
    if (extensions) {
      await extensions.verifyFiles(cleanup && !cancelled);
      assert.equal(reloads.length, cleanup && !cancelled ? 1 : 0, "Only an applied plugin change requires native reload");
      assert.equal(commands.cache.get(otherCatalog[0]), otherCatalog[1], "Doctor cannot invalidate another chat's catalog (independent of its TTL)");
      if (!cancelled) {
        // Inspect immediately after doctor: later native init events must not
        // mask an obsolete web catalog. Model-off skills can still be offered
        // for explicit user invocation, so compare the actual native catalog.
        const visible = (await commands.list(store.get(chat.id))).commands.map(command => command.name);
        const native = (await commands.claude(store.get(chat.id))).map(command => command.name);
        for (const target of extensions.targets) assert.equal(visible.includes(target.name), native.includes(target.name), `Web catalog must match ${target.name}'s native availability`);
        for (const target of extensions.targets) { activeProbe = target; phase = "extension-probe"; step = 0; await submit(`Probe only the native skill ${target.name}; do not edit files.`); }
      }
    }
    if (application) { assert.equal(owners.length, 1); if (!cancelled) assert.deepEqual(await (await fetch(appUrl)).json(), appState); }
    if (!cancelled) { phase = "permission"; step = 0; await submit("Verify the exact read command's native permission."); }
    else {
      assert.equal(store.get(chat.id).queuePaused, true);
      assert.deepEqual(store.get(chat.id).queuedMessages.map(item => item.text), ["Keep this input queued after doctor cancellation"]);
    }
    const session = store.get(chat.id).agentSessionId;
    await manager.stop(chat.id); if (application) await assert.rejects(fetch(appUrl, { signal: AbortSignal.timeout(1000) }));
    phase = "resume"; await submit("Confirm the doctor journal remains, without restarting any application.");
    if (extensions) {
      for (const target of extensions.targets) { activeProbe = target; phase = "extension-probe"; step = 0; await submit(`After Stop, probe only the native skill ${target.name}; do not edit files.`); }
      await extensions.verifyFiles(cleanup && !cancelled);
    }
    assert.equal(store.get(chat.id).agentSessionId, session); assert.equal(store.get(other.id).messages.length, 0);
    assert.equal(store.get(chat.id).mode, originalWeb.mode); assert.equal(store.get(chat.id).model, originalWeb.model);
    assert(!store.get(chat.id).messages.some(message => message.kind === "error"));
    console.log(`PASS: actual native ${options.has("--alias") ? "checkup alias" : "doctor"} expansion, read-only audit, ${cancelled ? "Stop during cleanup consent preserves files, denies late answers and keeps queued input paused" : `independent cleanup/permission ${skip ? "skips" : "consent/refusal"}, exact file and permission effects`}, journal after Stop${application ? ", HTTP app/PID/data retained until Stop" : ""}${broken ? ", invalid JSON reported without repair" : ""}${extensions ? `, real skill/plugin effects and preserved sources across Stop (${reloads.length} native reloads)` : ""}; ${requests.length} authored replies; ${controls.length} effective-settings snapshots.`);
  } finally {
    await (shutdown ||= manager?.shutdown()); server.closeAllConnections(); gatewayServer?.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); if (gatewayServer) await new Promise(resolve => gatewayServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
