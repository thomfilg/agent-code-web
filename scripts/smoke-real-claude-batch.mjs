import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { loadConfig } from "../src/config.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { ProviderGateway } from "../src/provider-gateway.mjs";
import { spawnWorker } from "../src/worker-process.mjs";

// Native /batch, plan approval, foreground research and background worktrees.
// All inference is authored. These are deterministic software-under-test
// agents, not delegates for implementing Relay. No remote Git/PR operations,
// personal profiles, real accounts or external network are used.
const exec = promisify(execFile);
for (const option of process.argv.slice(2)) assert(["--network-isolated", "--trace", "--deny-plan", "--send-now", "--stop", "--report", "--application", "--retry-launch"].includes(option));
assert(!(process.argv.includes("--send-now") && process.argv.includes("--stop")));
if (!process.argv.includes("--network-isolated")) {
  const result = await exec("/usr/bin/unshare", ["--user", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL", "--", process.execPath, process.argv[1], ...process.argv.slice(2), "--network-isolated"], { timeout: 120000, killSignal: "SIGKILL", maxBuffer: 50000 }).catch(error => {
    process.stdout.write(error.stdout || ""); process.stderr.write(error.stderr || error.message); process.exit(1);
  });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); assert.match(result.stdout, /^PASS:/m);
} else {
  await exec("/usr/bin/ip", ["link", "set", "lo", "up"]);
  assert.deepEqual(JSON.parse((await exec("/usr/bin/ip", ["-j", "link", "show"])).stdout).map(item => item.ifname), ["lo"]);
  assert.equal((await exec("/usr/bin/ip", ["route", "show"])).stdout.trim(), "");
  const root = await mkdtemp("/tmp/relay-claude-batch-"), requests = [], nativeEvents = [], owners = [], release = Promise.withResolvers(), releaseReport = Promise.withResolvers();
  const units = Array.from({ length: 5 }, (_, index) => ({ id: index + 1, step: 0, held: false }));
  const deliveredUnits = new Set();
  const trace = process.argv.includes("--trace"), deny = process.argv.includes("--deny-plan");
  const sendNow = process.argv.includes("--send-now"), stop = process.argv.includes("--stop"), report = process.argv.includes("--report"), application = process.argv.includes("--application");
  const retryLaunch = process.argv.includes("--retry-launch");
  const interrupt = sendNow || stop; assert(!report || interrupt); assert(!deny || !interrupt);
  let manager, store, gatewayServer, chat, failure, shutdown, phase = 0, research = 0, reports = 0, titles = 0, queued = false, reportHeld = false, appReplies = 0, appState, launchRecoveries = 0;
  const launchCalls = new Map();
  const userText = body => body.messages.filter(message => message.role === "user").flatMap(message => typeof message.content === "string" ? [message.content] : (message.content || []).filter(block => block.type === "text").map(block => block.text));
  const allText = body => body.messages.flatMap(message => typeof message.content === "string" ? [message.content] : (message.content || []).map(block => block.text || "")).join("\n");
  const respond = async (request, response) => {
    if (request.url.includes("count_tokens")) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"input_tokens":100}'); return; }
    if (request.method !== "POST" || !/\/messages(?:\?|$)/.test(request.url)) { response.writeHead(404); response.end(); return; }
    assert.equal(request.headers["x-api-key"], "controller-only-batch-fixture");
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw), text = allText(body), inputs = userText(body);
    const results = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === "tool_result");
    const result = results.at(-1), check = pattern => { assert(result); assert(!result.is_error, JSON.stringify(result)); if (pattern) assert.match(JSON.stringify(result), pattern); };
    const tool = (name, input, suffix = "") => {
      assert(body.tools.some(tool => tool.name === name), `Native tool missing: ${name}`);
      return { type: "tool_use", id: `batch_${requests.length}_${suffix}`, name, input };
    };
    const done = text => [{ type: "text", text }];
    const launch = unit => {
      unit.launchAttempts = (unit.launchAttempts || 0) + 1;
      const subagent_type = retryLaunch && unit.id === 1 && unit.launchAttempts === 1 ? "relay-batch-missing-fixture" : "general-purpose";
      const call = tool("Agent", { subagent_type, description: `Migrate fixture unit ${unit.id}`, isolation: "worktree", ...(unit.id === 1 ? {} : { run_in_background: true }),
        prompt: `RELAY_BATCH_UNIT_${unit.id}\nUse only this unit's native isolated worktree. Read pwd, then unit-${unit.id}.mjs; replace before-${unit.id} with after-${unit.id}. Run node --test test/unit-${unit.id}.test.mjs and node unit-${unit.id}.mjs to verify actual behavior. Preserve every other file. Do not commit, push or create PRs: the user explicitly restricted this acceptance fixture to local effects. Finish with PR: none — local-only fixture.` }, unit.id);
      launchCalls.set(call.id, unit); return call;
    };
    const unitMatch = inputs.map(text => /^RELAY_BATCH_UNIT_(\d)\b/.exec(text)).find(Boolean), unit = unitMatch ? units[Number(unitMatch[1]) - 1] : null;
    const isResearch = inputs.some(text => text.startsWith("RELAY_BATCH_RESEARCH\n"));
    let content;
    if (!body.tools?.length && text.includes("Write the title in the predominant language")) { titles++; content = done("Private native batch fixture"); }
    else {
      requests.push(body); assert(requests.length <= 75, "Unexpected native batch inference loop");
      if (trace) console.log("QUERY", JSON.stringify({ count: requests.length, phase, research: isResearch ? research : undefined, unit: unit?.id, step: unit?.step, tools: body.tools?.map(tool => tool.name).slice(0, 7) }));
      if (isResearch) {
        if (research === 0) content = [tool("Read", { file_path: `${chat.workspace}/README.md` })];
        else if (research === 1) { check(/Five independent CLI fixtures/); content = done("Five independent units: unit-1.mjs through unit-5.mjs. Each has one isolated test and a direct CLI output check. No remote operations are allowed."); }
        else throw Error("Unexpected research continuation");
        research++;
      } else if (unit) {
        const filename = `unit-${unit.id}.mjs`;
        if (unit.step === 0) {
          unit.held = true; await release.promise;
          if (response.destroyed) return;
          content = [tool("Bash", { command: "pwd", description: "Read this native worktree's actual path" })];
        } else if (unit.step === 1) {
          check();
          const output = typeof result.content === "string" ? result.content : result.content.map(block => block.text || "").join("\n");
          unit.workspace = output.trim().split("\n").find(line => line.startsWith("/"));
          assert(unit.workspace?.startsWith(`${chat.workspace}/.claude/worktrees/`), `Unexpected private worktree: ${unit.workspace}`);
          assert.equal(await realpath(unit.workspace), unit.workspace);
          content = [tool("Read", { file_path: `${unit.workspace}/${filename}` })];
        } else if (unit.step === 2) { check(new RegExp(`before-${unit.id}`)); content = [tool("Edit", { file_path: `${unit.workspace}/${filename}`, old_string: `before-${unit.id}`, new_string: `after-${unit.id}` })]; }
        else if (unit.step === 3) { check(); content = [tool("Bash", { command: `node --test test/unit-${unit.id}.test.mjs`, description: "Run this work unit's actual regression test" })]; }
        else if (unit.step === 4) { check(/pass 1/); content = [tool("Bash", { command: `node ${filename}`, description: "Exercise the changed CLI end to end" })]; }
        else if (unit.step === 5) { check(new RegExp(`after-${unit.id}`)); content = done(`Unit ${unit.id}: native edit, test and CLI execution passed.\nPR: none — this local acceptance fixture explicitly prohibits remote publication.`); }
        else throw Error(`Unexpected unit ${unit.id} continuation`);
        unit.step++;
      } else if (text.includes("AFTER_BATCH_INTERRUPT")) {
        assert(interrupt); assert.match(text, /# Batch: Parallel Work Orchestration/);
        content = done("Saved native batch context retained after interruption.");
      } else if (text.includes("AFTER_BATCH_KEEP_ORDER")) {
        assert(units.every(unit => unit.step === 6)); assert.equal(deliveredUnits.size, 5, "Every native report must precede queued input");
        queued = true; content = done("The queued input ran after all native batch work and report delivery.");
      } else if (application && appReplies < 2) {
        if (appReplies++ === 0) content = [tool("Bash", { command: "node batch-server.mjs", run_in_background: true, description: "Start this disposable chat's local HTTP app" })];
        else { check(); content = done("The private fixture application is running."); }
      } else if (phase === 0) {
        assert.match(text, /# Batch: Parallel Work Orchestration/); content = [tool("EnterPlanMode", {})]; phase++;
      } else if (phase === 1) {
        check(); content = [tool("Agent", { subagent_type: "Explore", run_in_background: false, description: "Research disposable batch units", prompt: "RELAY_BATCH_RESEARCH\nRead README.md only and identify the five independent fixture units and their actual test/CLI recipe. Do not modify anything." })]; phase++;
      } else if (phase === 2) {
        check(/Five independent units/);
        content = [tool("ExitPlanMode", { plan: "Migrate the five independent unit-N.mjs CLI outputs from before-N to after-N. Each unit runs node --test test/unit-N.test.mjs and node unit-N.mjs in its own native worktree. Use five background general-purpose agents. Preserve the main workspace and sibling files. Do not commit, push or create PRs in this local acceptance fixture; report PR: none." })]; phase++;
      } else if (phase === 3) {
        if (deny) { assert(result.is_error); content = done("The plan was denied. No worktrees or edits were started."); }
        else {
          check();
          content = units.map(launch);
        }
        phase++;
      } else if (phase === 4) {
        const retries = [];
        for (const result of results) {
          const unit = launchCalls.get(result.tool_use_id); if (!unit || unit.launched) continue;
          launchCalls.delete(result.tool_use_id);
          if (result.is_error) {
            // This is an authored agent response to a real native tool error,
            // not a Relay transport replay or a Git/CLI replacement. Only the
            // observed pre-launch Git race (or the explicitly seeded invalid
            // agent type) is safe to retry in this fixture.
            if (retryLaunch && unit.id === 1 && unit.launchAttempts === 1) assert.match(JSON.stringify(result.content), /relay-batch-missing-fixture/);
            else assert.match(JSON.stringify(result.content), /Failed to create worktree:.*failed to read .*commondir/);
            assert.equal(unit.step, 0); assert.equal(unit.held, false);
            assert(++launchRecoveries <= 3, "Native worktree setup failed repeatedly");
            console.log(`Native unit ${unit.id} did not launch: ${JSON.stringify(result.content)}. Authored coordinator retries only that unstarted unit.`);
            retries.push(unit);
          } else unit.launched = true;
        }
        if (retries.length) content = retries.map(launch);
        else { assert(units.every(unit => unit.launched)); content = done("Five isolated native worktree agents are running. Waiting for their completion reports."); phase++; }
      } else {
        assert.match(text, /task-notification/); reports++;
        if (report && reports === 1) { reportHeld = true; await releaseReport.promise; if (response.destroyed) return; }
        for (const text of inputs) for (const match of text.matchAll(/Unit (\d): native edit, test and CLI execution passed/g)) deliveredUnits.add(Number(match[1]));
        const count = deliveredUnits.size;
        content = done(`${count}/5 native fixture units completed locally. No pull requests were created.${count === 5 ? " FINAL_BATCH_REPORT" : ""}`);
      }
    }
    const message = { id: `msg_batch_${requests.length}_${titles}`, type: "message", role: "assistant", model: body.model, content, stop_reason: content.some(block => block.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } };
    if (response.destroyed) return;
    if (!body.stream) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(message)); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = value => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
    event({ type: "message_start", message: { ...message, content: [], stop_reason: null } });
    content.forEach((block, index) => {
      const tool = block.type === "tool_use";
      event({ type: "content_block_start", index, content_block: tool ? { ...block, input: {} } : { type: "text", text: "" } });
      event({ type: "content_block_delta", index, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } });
      event({ type: "content_block_stop", index });
    });
    event({ type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } }); event({ type: "message_stop" }); response.end();
  };
  const server = http.createServer((request, response) => { void respond(request, response).catch(error => {
    failure ||= error; if (!response.headersSent) response.writeHead(500); response.end(); release.resolve(); shutdown ||= manager?.shutdown();
  }); });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const config = loadConfig({ AGENT_DATA_DIR: root, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", AGENT_IDLE_TIMEOUT_MS: "60000", CLAUDE_AUTH_MODE: "gateway", ANTHROPIC_API_KEY: "controller-only-batch-fixture" });
    store = new ChatStore(root); await store.initialize(); const broker = new CapabilityBroker({ ttlMs: 120000 });
    const gateway = new ProviderGateway({ config, broker, fetchImpl: (url, options) => fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}${new URL(url).search}`, options) });
    gatewayServer = http.createServer((request, response) => { void gateway.handle(request, response, new URL(request.url, "http://fixture")); });
    await new Promise(resolve => gatewayServer.listen(0, "127.0.0.1", resolve)); const gatewayOrigin = `http://127.0.0.1:${gatewayServer.address().port}`;
    const workerBackend = { sleep: async () => {}, shutdown: async () => {}, acquire: async current => ({ workspace: current.workspace, runtimeHome: store.runtimeHome(current.id), metadata: { backend: "local" }, mkdir: directory => mkdir(directory, { recursive: true, mode: 0o700 }),
      spawn(command, args, options) {
        const child = spawnWorker(command, args, options); if (command === config.claude.bin && args.includes("--print")) owners.push(child);
        let buffer = ""; child.stdout.on("data", chunk => {
          buffer += chunk; const lines = buffer.split("\n"); buffer = lines.pop();
          for (const line of lines) try {
            const event = JSON.parse(line);
            if (trace && event.type === "result") console.log("NATIVE_RESULT", JSON.stringify({ origin: event.origin, parent_tool_use_id: event.parent_tool_use_id }));
            if (event.type === "system" && ["task_started", "task_notification"].includes(event.subtype)) {
              nativeEvents.push(event); if (trace) console.log("NATIVE", JSON.stringify({ subtype: event.subtype, task_type: event.task_type, task_id: event.task_id, tool_use_id: event.tool_use_id, parent_tool_use_id: event.parent_tool_use_id, status: event.status }));
            }
          } catch {}
        }); return child;
      },
    }) };
    manager = new RuntimeManager({ store, config, broker, gatewayOrigin, workerBackend, adapterFactory: params => new ClaudeAdapter({ ...params, store, config, broker, gatewayOrigin }) });
    chat = await manager.createChat({ agent: "claude", title: "Native isolated batch fixture" }); await manager.setMode(chat.id, "accept_edits");
    const runtime = store.runtimeHome(chat.id), env = { PATH: process.env.PATH, HOME: runtime, LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    await mkdir(`${runtime}/claude`, { recursive: true, mode: 0o700 }); await mkdir(`${chat.workspace}/test`);
    await writeFile(`${chat.workspace}/README.md`, "Five independent CLI fixtures: unit-1.mjs through unit-5.mjs. Each must print after-N. Verify each with node --test test/unit-N.test.mjs and node unit-N.mjs. All work is local; no remote publication.\n");
    for (const unit of units) {
      await writeFile(`${chat.workspace}/unit-${unit.id}.mjs`, `export const value = 'before-${unit.id}';\nconsole.log(value);\n`);
      await writeFile(`${chat.workspace}/test/unit-${unit.id}.test.mjs`, `import test from 'node:test';import assert from 'node:assert/strict';import {value} from '../unit-${unit.id}.mjs';test('unit ${unit.id}',()=>assert.equal(value,'after-${unit.id}'));\n`);
    }
    if (application) await writeFile(`${chat.workspace}/batch-server.mjs`, `import http from 'node:http';import {writeFileSync} from 'node:fs';const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({pid:process.pid,value:'saved-batch-app'}));});server.listen(0,'127.0.0.1',()=>writeFileSync('batch-app.json',JSON.stringify({url:'http://127.0.0.1:'+server.address().port})));\n`);
    await writeFile(`${runtime}/claude/settings.json`, JSON.stringify({ permissions: { allow: ["Bash(pwd)", ...(application ? ["Bash(node batch-server.mjs)"] : []), ...units.flatMap(unit => [`Bash(node unit-${unit.id}.mjs)`, `Bash(node --test test/unit-${unit.id}.test.mjs)`])] } }));
    for (const args of [["init", "-b", "main"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Seed isolated batch fixture"]]) await exec("git", args, { cwd: chat.workspace, env });
    const other = await manager.createChat({ agent: "claude", title: "Unrelated batch fixture" });
    let appUrl;
    if (application) {
      await manager.send(chat.id, "/run Start the private batch-server.mjs fixture application.");
      const deadline = Date.now() + 10000;
      while (!appState && Date.now() < deadline) {
        try { appUrl = JSON.parse(await readFile(`${chat.workspace}/batch-app.json`, "utf8")).url; appState = await (await fetch(appUrl, { signal: AbortSignal.timeout(1000) })).json(); }
        catch { await delay(25); }
      }
      assert(appState); assert.equal(appState.value, "saved-batch-app");
    }
    const checkApp = async () => { if (application) assert.deepEqual(await (await fetch(appUrl, { signal: AbortSignal.timeout(1000) })).json(), appState); };
    let finished = false;
    const sending = manager.send(chat.id, "/batch Migrate the five fixture CLIs from before-N to after-N. Require plan approval, isolated native worktrees, real tests and CLI checks. Local effects only: no commit, push or PR publication. Preserve ação.").catch(error => { failure ||= error; }).finally(() => { finished = true; });
    const seen = new Set(); const deadline = Date.now() + 70000;
    while (!finished && !failure && Date.now() < deadline) {
      const pending = store.get(chat.id).pendingRequest;
      if (pending && !seen.has(pending.requestId)) {
        seen.add(pending.requestId); assert.match(pending.prompt, /ExitPlanMode/, "Only the explicit fixture plan may be approved");
        assert.match(pending.command, /five independent/); assert.equal(store.get(chat.id).mode, "plan");
        await manager.respond(chat.id, pending.requestId, { decision: deny ? "decline" : "accept" });
      }
      await delay(25);
    }
    if (failure) throw failure;
    assert(finished, "The native batch launching turn did not settle"); await sending;
    if (deny) {
      assert.equal(phase, 4); assert(units.every(unit => unit.step === 0)); assert.equal(store.get(chat.id).mode, "plan");
    } else {
      const readyDeadline = Date.now() + 10000;
      while (!units.every(unit => unit.held) && !failure && Date.now() < readyDeadline) await delay(25);
      if (failure) throw failure;
      assert(units.every(unit => unit.held), "All five native background worktree agents must reach their query");
      const workers = nativeEvents.filter(event => event.subtype === "task_started" && event.task_type === "local_agent" && /^batch_\d+_[1-5]$/.test(event.tool_use_id));
      assert.equal(workers.length, 5); assert.equal(new Set(workers.map(event => event.task_id)).size, 5);
      assert.equal(owners[0].exitCode, null, "The native batch owner must not exit with its launch reply");
      assert(manager.isBusy(chat.id), "Batch work stays busy until actual native child reports are delivered");
      await checkApp();
      const sessionId = store.get(chat.id).agentSessionId;
      if (interrupt) {
        await store.update(chat.id, { queuePaused: true }); await manager.enqueue(chat.id, "Keep this other queued message");
        if (report) { release.resolve(); while (!reportHeld && !failure && Date.now() < deadline) await delay(25); if (failure) throw failure; assert(reportHeld); }
        if (sendNow) {
          const pending = await manager.enqueue(chat.id, "AFTER_BATCH_INTERRUPT"); await manager.sendQueuedNow(chat.id, pending.queuedMessages.at(-1).id);
          assert.equal(owners.length, 1, "Send now must cancel native tasks, not replace the owning worker"); await checkApp();
        } else {
          await manager.stop(chat.id);
          assert.notEqual(owners[0].exitCode ?? owners[0].signalCode, null);
          if (application) await assert.rejects(fetch(appUrl, { signal: AbortSignal.timeout(1000) }));
          await manager.send(chat.id, "AFTER_BATCH_INTERRUPT"); assert.equal(owners.length, 2);
        }
        while (manager.isBusy(chat.id) && !failure && Date.now() < deadline) await delay(25);
        if (failure) throw failure; assert.equal(manager.isBusy(chat.id), false);
        assert(store.get(chat.id).messages.some(message => message.text === "Saved native batch context retained after interruption."));
        assert.equal(store.get(chat.id).agentSessionId, sessionId);
        assert.deepEqual(store.get(chat.id).queuedMessages.map(message => message.text), ["Keep this other queued message"]);
        if (!report) {
          assert(units.every(unit => unit.step === 0), "Cancelled native agents must not perform held edits");
          if (sendNow) for (const worker of workers) assert(nativeEvents.some(event => event.subtype === "task_notification" && event.task_id === worker.task_id && event.status === "stopped"));
        }
      } else {
        await manager.enqueue(chat.id, "AFTER_BATCH_KEEP_ORDER"); assert.equal(queued, false); release.resolve();
        while (!queued && !failure && Date.now() < deadline) await delay(25);
        if (failure) throw failure;
        assert(queued, "The retained native batch must finish and release the queued input");
        assert.equal(new Set(units.map(unit => unit.workspace)).size, 5);
        for (const unit of units) {
          assert.match(await readFile(`${unit.workspace}/unit-${unit.id}.mjs`, "utf8"), new RegExp(`after-${unit.id}`));
          assert.equal((await exec("git", ["diff", "--name-only"], { cwd: unit.workspace, env })).stdout.trim(), `unit-${unit.id}.mjs`);
          for (const sibling of units.filter(other => other !== unit)) assert.match(await readFile(`${unit.workspace}/unit-${sibling.id}.mjs`, "utf8"), new RegExp(`before-${sibling.id}`));
        }
        const messages = store.get(chat.id).messages, reportIndex = messages.findIndex(message => message.text?.includes("FINAL_BATCH_REPORT")), after = messages.findIndex(message => message.role === "user" && message.text === "AFTER_BATCH_KEEP_ORDER");
        assert(reportIndex >= 0 && after > reportIndex); assert.equal(owners.length, 1);
        await checkApp();
      }
    }
    for (const unit of units) assert.match(await readFile(`${chat.workspace}/unit-${unit.id}.mjs`, "utf8"), new RegExp(`before-${unit.id}`));
    if (retryLaunch && !deny) assert(launchRecoveries >= 1);
    assert.equal(store.get(other.id).messages.length, 0);
    assert(!store.get(chat.id).messages.some(message => message.kind === "error"));
    console.log(`PASS: native batch ${deny ? "plan denial without worktree writes" : interrupt ? `${report ? "in-flight report " : "five live agents "}${sendNow ? "Send now" : "Stop/resume"}, same native history and unrelated queue preservation` : "plan approval, foreground research, five background isolated worktrees, actual per-unit edits/tests/CLI effects, final reports and FIFO"}${application ? "; existing HTTP app/PID/data preserved until explicit Stop" : ""}; main and unrelated chats preserved; no remote Git/PR operations; ${requests.length} authored replies, ${titles} titles, ${launchRecoveries} native launch recoveries.`);
  } finally {
    release.resolve(); releaseReport.resolve(); await (shutdown ||= manager?.shutdown()); server.closeAllConnections(); gatewayServer?.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); if (gatewayServer) await new Promise(resolve => gatewayServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
