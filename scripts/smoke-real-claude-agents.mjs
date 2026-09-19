import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { spawnWorker, terminateWorker } from "../src/worker-process.mjs";
import { ClaudeControlChannel } from "../src/claude-mcp.mjs";
import { ClaudeAgentThreads } from "../src/claude-agent-threads.mjs";

// Actual native Agent invocations; no copied/fabricated descendant journals,
// extra agent CLI, personal profile or external model/provider connection.
const exec = promisify(execFile);
assert(process.argv.slice(2).every(arg => arg === "--network-isolated"));
if (!process.argv.includes("--network-isolated")) {
  const result = await exec("/usr/bin/unshare", ["--user", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL", "--", process.execPath, process.argv[1], "--network-isolated"], { timeout: 90000, maxBuffer: 20000 }).catch(error => {
    process.stdout.write(error.stdout || ""); process.stderr.write(error.stderr || "Isolated native-agent fixture failed\n"); process.exit(1);
  });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); assert.match(result.stdout, /^PASS:/m);
} else {
  await exec("/usr/bin/ip", ["link", "set", "lo", "up"]);
  assert.deepEqual(JSON.parse((await exec("/usr/bin/ip", ["-j", "link", "show"])).stdout).map(item => item.ifname), ["lo"]);
  assert.equal((await exec("/usr/bin/ip", ["route", "show"])).stdout.trim(), "");
  const root = await mkdtemp("/tmp/relay-claude-agents-"), frames = [], heldResponses = new Set();
  const sessionId = randomUUID(), release = Promise.withResolvers();
  let child, control, observer, close, failure, phase = "initialize", calls = 0, approvals = 0, stopCalls = 0;
  let completedSpawned = false, heldSpawned = false, heldRequested = false;
  const until = async (predicate, label, timeout = 20000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (failure) throw failure; const value = predicate(); if (value) return value; await delay(25); }
    throw Error(`Native-agent fixture timed out: ${label}`);
  };
  const respond = async (request, response) => {
    if (request.url.includes("count_tokens")) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"input_tokens":100}'); return; }
    // Native startup may probe the configured loopback origin with HEAD.
    // Only Messages POSTs are authored inference; unknown/probe routes receive
    // the same 404 as the existing isolated Claude fixture, not fake success.
    if (request.method !== "POST" || !/^\/v1\/messages(?:\?|$)/.test(request.url)) { response.writeHead(404); response.end(); return; }
    let raw = ""; for await (const chunk of request) { raw += chunk; assert(raw.length <= 2_000_000); }
    const body = JSON.parse(raw), index = ++calls; assert(index <= 20, "Unexpected native model request loop");
    const lastUser = body.messages.filter(item => item.role === "user").at(-1);
    const text = typeof lastUser?.content === "string" ? lastUser.content : (lastUser?.content || []).filter(block => block.type === "text").map(block => block.text).join("\n");
    let content;
    if (text.includes("RELAY_CHILD_FINISH")) content = [{ type: "text", text: "RELAY_CHILD_PUBLIC_ANSWER" }];
    else if (text.includes("RELAY_CHILD_HOLD")) {
      heldRequested = true; heldResponses.add(response); await release.promise; heldResponses.delete(response);
      if (!response.destroyed) response.end(); return;
    } else if (text.includes("RELAY_PARENT_COMPLETE") && !completedSpawned) {
      assert(body.tools.some(tool => tool.name === "Agent"), "Actual native Agent tool must be exposed"); completedSpawned = true;
      content = [{ type: "tool_use", id: `fixture_agent_call_${index}`, name: "Agent", input: { description: "Native child fixture", prompt: "RELAY_CHILD_FINISH: return the public fixture answer.", subagent_type: "general-purpose", name: "same-visible-name", run_in_background: false } }];
    } else if (text.includes("RELAY_PARENT_BACKGROUND") && !heldSpawned) {
      assert(body.tools.some(tool => tool.name === "Agent")); heldSpawned = true;
      content = [{ type: "tool_use", id: `fixture_agent_call_${index}`, name: "Agent", input: { description: "Native child fixture", prompt: "RELAY_CHILD_HOLD: wait for the local provider response.", subagent_type: "general-purpose", name: "same-visible-name", run_in_background: true } }];
    } else content = [{ type: "text", text: text.includes("RELAY_PARENT_CONTINUE") ? "RELAY_PARENT_STILL_ALIVE" : "RELAY_PARENT_REPLY" }];
    const block = content[0], tool = block.type === "tool_use";
    const message = { id: `fixture_message_${index}`, type: "message", role: "assistant", model: body.model, content, stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } };
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
  const server = http.createServer((request, response) => { void respond(request, response).catch(error => { failure ||= error; if (!response.headersSent) response.writeHead(500); response.end(); }); });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    await mkdir(path.join(root, "config"), { mode: 0o700 }); await mkdir(path.join(root, "workspace"), { mode: 0o700 });
    child = spawnWorker(process.env.CLAUDE_NATIVE_BINARY || "claude", ["--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--permission-prompt-tool", "stdio", "--permission-mode", "acceptEdits", "--prompt-suggestions", "false", "--model", "sonnet", "--session-id", sessionId], {
      cwd: path.join(root, "workspace"), stdio: ["pipe", "pipe", "pipe"], env: { HOME: root, CLAUDE_CONFIG_DIR: path.join(root, "config"), PATH: process.env.PATH, LANG: "C.UTF-8", CI: "1", NO_COLOR: "1", ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: "disposable-local-fixture", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    });
    close = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    child.on("error", () => { failure ||= Error("Owned native process failed to start"); }); child.stderr.resume();
    control = new ClaudeControlChannel(child, 10000);
    observer = new ClaudeAgentThreads({ root: () => sessionId, current: () => child.exitCode === null && child.signalCode === null,
      control: { request: (subtype, fields) => { assert.equal(subtype, "stop_task"); stopCalls++; return control.request(subtype, fields); } } });
    readline.createInterface({ input: child.stdout }).on("line", line => {
      if (line.length > 1_000_000 || frames.length >= 1000) { failure ||= Error("Native frame bounds exceeded"); return; }
      let event; try { event = JSON.parse(line); } catch { return; }
      control.accept(event); frames.push(event); observer.observe(event);
      if (event.type === "control_request") {
        const allowed = event.request?.subtype === "can_use_tool" && event.request.tool_name === "Agent" && /^RELAY_CHILD_(FINISH|HOLD):/.test(event.request.input?.prompt || "");
        if (allowed) approvals++;
        child.stdin.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: event.request_id, response: allowed ? { behavior: "allow", updatedInput: event.request.input } : { behavior: "deny", message: "Only the exact fixture Agent call is permitted" } } })}\n`);
      }
    });
    const initialized = await control.request("initialize", { forwardSubagentText: true });
    assert(Array.isArray(initialized.agents), "Native initialization must expose definitions, not invented children");
    const send = async (text, expectedResult = "RELAY_PARENT_REPLY") => {
      const after = frames.length;
      child.stdin.write(`${JSON.stringify({ type: "user", uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null, message: { role: "user", content: text } })}\n`);
      return until(() => frames.slice(after).find(event => event.type === "result" && event.session_id === sessionId && !event.parent_tool_use_id && event.is_error === false && event.result === expectedResult), `parent result (${phase})`);
    };
    phase = "completed-child"; await send("RELAY_PARENT_COMPLETE: create the native child and wait for it.");
    const completed = await until(() => frames.find(event => event.type === "user" && event.session_id === sessionId && event.tool_use_result?.status === "completed" && event.tool_use_result?.agentId), "native completed child result");
    const firstId = completed.tool_use_result.agentId;
    assert(!firstId.startsWith("fixture_"));
    const firstCall = completed.message.content.find(block => block.type === "tool_result").tool_use_id;
    assert(frames.some(event => event.type === "assistant" && event.parent_tool_use_id === firstCall && event.message?.content?.some(block => block.type === "text" && block.text.includes("RELAY_CHILD_PUBLIC_ANSWER"))), "Actual forwarded child text must correlate to its native Agent invocation");
    const observedFirst = observer.snapshot().threads.find(entry => entry.id === firstId);
    assert.equal(observedFirst?.status, "idle"); assert(observedFirst.messages.some(entry => entry.role === "assistant" && entry.text.includes("RELAY_CHILD_PUBLIC_ANSWER")));
    phase = "background-child"; const parent = await send("RELAY_PARENT_BACKGROUND: create the background native child and keep the main conversation independent.");
    assert.equal(parent.subtype, "success"); await until(() => heldRequested, "actual held child provider request");
    const started = await until(() => frames.find(event => event.type === "system" && event.subtype === "task_started" && event.session_id === sessionId && event.task_type === "local_agent" && event.task_id !== firstId), "native running child identity");
    const secondId = started.task_id; assert.notEqual(firstId, secondId); assert(!secondId.startsWith("fixture_")); assert(started.tool_use_id);
    const heldResult = await until(() => frames.find(event => event.type === "user" && event.tool_use_result?.agentId === secondId), "Agent result and task identity correlation");
    assert.equal(heldResult.message.content.find(block => block.type === "tool_result").tool_use_id, started.tool_use_id);
    assert.equal(observer.snapshot().threads.find(entry => entry.id === secondId)?.status, "active");
    phase = "stop-child"; await observer.interrupt(secondId);
    await until(() => frames.find(event => event.type === "system" && event.session_id === sessionId && event.task_id === secondId && (event.subtype === "task_notification" && ["stopped", "failed"].includes(event.status) || event.subtype === "task_updated" && ["killed", "failed"].includes(event.patch?.status))), "confirmed child terminal, not merely stop acknowledgement");
    assert.equal(stopCalls, 1); assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
    assert.equal(observer.snapshot().threads.find(entry => entry.id === firstId)?.status, "idle");
    assert(["failed", "stopped"].includes(observer.snapshot().threads.find(entry => entry.id === secondId)?.status));
    assert(!frames.some(event => event.type === "system" && event.task_id === firstId && event.subtype === "task_notification" && event.status === "stopped"), "Stopping the same-named second child must not stop the first");
    phase = "parent-continue"; const continued = await send("RELAY_PARENT_CONTINUE: continue this exact main session after child-only Stop.", "RELAY_PARENT_STILL_ALIVE");
    assert.equal(continued.result, "RELAY_PARENT_STILL_ALIVE"); assert.equal(continued.session_id, sessionId); assert.equal(completed.tool_use_result.agentId, firstId); assert.ifError(failure);
    console.log(`PASS: one installed Claude process created two real native child IDs, forwarded correlated public child text, completed main reply while second child was active, confirmed exactly one child-only stop, and continued the same parent session; ${calls} authored loopback requests, ${approvals} exact Agent approvals. No direct child-send/steer capability or live-provider acceptance claimed.`);
  } catch (error) {
    console.error(JSON.stringify({ fixture: "native-agent-diagnostic", phase, requests: calls, completedSpawned, heldSpawned, heldRequested,
      rootResults: frames.filter(event => event.type === "result" && event.session_id === sessionId && !event.parent_tool_use_id).length,
      childTextFrames: frames.filter(event => event.type === "assistant" && event.parent_tool_use_id && event.message?.content?.some(block => block.type === "text")).length,
      taskStarts: frames.filter(event => event.type === "system" && event.subtype === "task_started").length,
      agentResults: frames.filter(event => event.type === "user" && event.tool_use_result?.agentId).map(event => ["completed", "async_launched"].includes(event.tool_use_result.status) ? event.tool_use_result.status : "other"), stopCalls }));
    console.error(`FAIL native-agent fixture phase=${phase}: ${error.message.slice(0, 500)}`); process.exitCode = 1;
  } finally {
    observer?.close();
    release.resolve(); for (const response of heldResponses) response.destroy();
    control?.close(); await terminateWorker(child);
    if (close) await Promise.race([close, delay(5000).then(() => { throw Error("Owned native process cleanup unconfirmed"); })]);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
