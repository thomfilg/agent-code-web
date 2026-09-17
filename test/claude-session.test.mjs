import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir } from "node:fs/promises";
import { ClaudeSession, claudeCallResult } from "../src/claude-session.mjs";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { mergeUsage } from "../src/session-info.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

// Protocol double only; smoke-real-claude-run verifies actual installed Claude,
// native background processes, HTTP requests, journal and control effects.
function transport(f) {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
  f.child = child; f.inputs ||= []; f.controls ||= []; f.signals ||= []; f.total = 0;
  f.emit = event => child.stdout.write(`${JSON.stringify(event)}\n`);
  const close = (code, signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code; child.signalCode = signal; child.stdout.end(); child.stderr.end();
    child.emit("exit", code, signal); child.emit("close", code, signal);
  };
  child.kill = signal => { f.signals.push(signal); setImmediate(() => close(null, signal)); };
  child.stdin.on("finish", () => setImmediate(() => close(0, null)));
  f.complete = (text = "Application turn completed.", failed = false) => {
    f.total++;
    f.emit({ type: "assistant", message: { id: `message_${f.total}`, model: "fixture", content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 10 } } });
    f.emit({ type: "result", subtype: failed ? "error_during_execution" : "success", is_error: failed, result: text, session_id: f.nativeSession,
      usage: { input_tokens: 100, output_tokens: 10 }, total_cost_usd: f.total / 10,
      modelUsage: { fixture: { inputTokens: f.total * 100, outputTokens: f.total * 10, costUSD: f.total / 10, contextWindow: 200000 } } });
  };
  f.respond = packet => {
    let response = {};
    if (f.mcp && packet.request.subtype === "mcp_toggle" && f.refuse !== "mcp_toggle") {
      f.mcp.find(server => server.name === packet.request.serverName).status = packet.request.enabled ? "connected" : "disabled";
    }
    if (f.mcp && packet.request.subtype === "mcp_status") response = { mcpServers: f.mcp.map(server => ({ ...server })) };
    f.emit({ type: "control_response", response: { request_id: packet.request_id,
      subtype: f.refuse === packet.request.subtype ? "error" : "success", response, error: "Fixture control rejected" } });
    if (packet.request.subtype === "interrupt" && !f.refuse) f.complete("Interrupted at native checkpoint.", f.failInterrupt);
  };
  let buffer = "";
  child.stdin.setEncoding("utf8"); child.stdin.on("data", chunk => {
    buffer += chunk; const lines = buffer.split("\n"); buffer = lines.pop();
    for (const line of lines) {
      const packet = JSON.parse(line);
      if (packet.type === "control_request") {
        f.controls.push(packet);
        if (f.hold !== packet.request.subtype) setImmediate(() => f.respond(packet));
      } else if (packet.type === "control_response") {
        (f.permissionReplies ||= []).push(packet);
      } else {
        f.inputs.push(packet);
        setImmediate(() => {
          f.emit({ type: "command_lifecycle", command_uuid: packet.uuid, state: "started" });
          if (!f.block) f.complete(f.reply, f.failResult);
        });
      }
    }
  });
  return child;
}

async function fixture(t, { interactive = false } = {}) {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const chat = await store.create({ agent: "claude", title: "Application transport" }), config = testConfig(root);
  const f = { launches: [], events: [], sessions: [], requests: [] }, broker = new CapabilityBroker({ ttlMs: 60000 });
  const executor = { workspace: chat.workspace, runtimeHome: store.runtimeHome(chat.id), metadata: { backend: "local" }, mkdir: directory => mkdir(directory, { recursive: true }),
    spawn(command, args, options) {
      if (f.spawnFailure) throw Error("Fixture spawn failure");
      f.launches.push({ command, args, env: options.env }); f.nativeSession = args[args.indexOf("--session-id") + 1]; return transport(f);
    } };
  const adapter = new ClaudeAdapter({ chat, store, config, executor, broker, gatewayOrigin: "http://127.0.0.1:9",
    hooks: { onSessionId: id => f.sessions.push(id), onEvent: event => f.events.push(event), ...(interactive ? { onRequest: request => f.requests.push(request) } : {}) } });
  t.after(() => adapter.stop());
  return Object.assign(f, { adapter, config, broker, chat, store });
}

test("private ordinary turns use live native approvals and close their transport after the reply", async t => {
  const f = await fixture(t, { interactive: true }); f.block = true;
  const running = f.adapter.send("Write the fixture recipe", { mode: "default" });
  await waitFor(() => f.inputs?.length);
  assert(f.launches[0].args.includes("--permission-prompt-tool"));
  assert.equal(f.launches[0].args[f.launches[0].args.indexOf("--permission-mode") + 1], "default");
  assert.equal(f.controls[0].request.subtype, "initialize");
  f.emit({ type: "control_request", request_id: "native-write", request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: "fixture.txt", content: "Original native input" } } });
  await waitFor(() => f.requests.length === 1);
  await f.adapter.respond(f.requests[0].requestId, { decision: "accept" });
  assert.deepEqual(f.permissionReplies[0].response.response, { behavior: "allow", updatedInput: { file_path: "fixture.txt", content: "Original native input" } });
  f.complete(); await running;
  assert.notEqual(f.child.exitCode ?? f.child.signalCode, null); assert.equal(f.adapter.turnSession, null); assert.equal(f.adapter.applicationSession, undefined);
  await assert.rejects(f.adapter.respond(f.requests[0].requestId, { decision: "accept" }), /no longer active/);
  const next = f.adapter.send("Ask again"), rejected = assert.rejects(next, /interrupted/);
  await waitFor(() => f.inputs.length === 2);
  f.emit({ type: "control_request", request_id: "native-again", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "node fixture.mjs" } } });
  await waitFor(() => f.requests.length === 2);
  await f.adapter.stop(); await rejected;
  assert.equal(f.permissionReplies.at(-1).response.response.behavior, "deny");
  await assert.rejects(f.adapter.respond(f.requests[1].requestId, { decision: "accept" }), /no longer active/);
});

test("Stop during private ordinary SDK initialization sends no user input and revokes the gateway capability", async t => {
  const f = await fixture(t, { interactive: true }); f.hold = "initialize";
  const running = f.adapter.send("Do not send this after Stop"), rejected = assert.rejects(running, /stopped|closed|interrupted/);
  await waitFor(() => f.controls?.length); const capability = f.adapter.capability;
  await f.adapter.stop(); await rejected;
  assert.deepEqual(f.inputs, []); assert.deepEqual(f.requests, []); assert.equal(f.adapter.turnSession, null);
  assert.equal(f.broker.validate(capability, "anthropic"), null);
});

test("native mode observations follow the current main session, survive retained replies and stop with interruption", async t => {
  const f = await fixture(t, { interactive: true }), first = [], second = [];
  f.block = true;
  const running = f.adapter.send("/run Start the fixture", { onPermissionMode: mode => first.push(mode) });
  await waitFor(() => f.inputs?.length);
  const status = permissionMode => ({ type: "system", subtype: "status", status: null, session_id: f.nativeSession, permissionMode });
  f.emit(status("plan")); await waitFor(() => first.length === 1);
  f.emit({ ...status("default"), session_id: "foreign-session" }); f.emit({ ...status("default"), parent_tool_use_id: "child" });
  f.complete(); await running;
  f.emit(status("acceptEdits")); await waitFor(() => first.length === 2);
  assert.deepEqual(first, ["plan", "accept_edits"]);
  const next = f.adapter.send("/verify Verify the fixture", { onPermissionMode: mode => second.push(mode) });
  const rejected = assert.rejects(next, /interrupted/); await waitFor(() => f.inputs.length === 2);
  f.emit(status("plan")); await waitFor(() => second.length === 1);
  await f.adapter.interrupt(); await rejected;
  f.emit(status("default")); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(second, ["plan"]); assert.deepEqual(first, ["plan", "accept_edits"]);
});

test("failed native-mode synchronization reaches the runtime fatal handler without an unhandled rejection", async t => {
  for (const asynchronous of [false, true]) {
    const f = await fixture(t, { interactive: true }), errors = []; f.block = true;
    f.adapter.hooks.onFatal = error => { errors.push(error.message); void f.adapter.stop(); };
    const onPermissionMode = () => { if (asynchronous) return Promise.reject(Error("Private persistence error")); throw Error("Private persistence error"); };
    const running = f.adapter.send("/run Start the fixture", { onPermissionMode }), rejected = assert.rejects(running, /interrupted/);
    await waitFor(() => f.inputs?.length);
    f.emit({ type: "system", subtype: "status", status: null, session_id: f.nativeSession, permissionMode: "plan" });
    await rejected; assert.equal(errors.length, 1); assert.match(errors[0], /could not be synchronized/);
    assert.doesNotMatch(errors[0], /Private persistence/);
  }
});

test("application replies retain one CLI and apply next-turn mode/model/effort without rewriting literal inputs", async t => {
  const f = await fixture(t), text = "/run Start ação\nand keep the server running";
  await f.adapter.send(text, { mode: "accept_edits", model: "sonnet", effort: "high" });
  const session = f.adapter.sessionId, capability = f.adapter.capability;
  assert.equal(f.child.exitCode, null); assert.equal(f.child.stdin.writable, true); assert.equal(f.adapter.child, null);
  await f.adapter.send("/verify Probe invalid input", { mode: "plan", model: "haiku", effort: "low" });
  assert.equal(f.launches.length, 1); assert.deepEqual(f.inputs.map(packet => packet.message.content), [text, "/verify Probe invalid input"]);
  assert.notEqual(f.inputs[0].uuid, f.inputs[1].uuid);
  assert.deepEqual(f.controls.map(packet => packet.request), [{ subtype: "initialize" }, { subtype: "set_permission_mode", mode: "plan" },
    { subtype: "set_model", model: "haiku" }, { subtype: "apply_flag_settings", settings: { effortLevel: "low" } }]);
  assert.deepEqual(f.sessions, [session]); assert.equal(f.adapter.capability, capability);
  assert(!JSON.stringify(f.launches).includes(f.config.claude.providerKey));
  await f.adapter.stop(); assert.equal(f.broker.validate(capability, "anthropic"), null);
  assert.notEqual(f.child.exitCode ?? f.child.signalCode, null);
});

test("native MCP controls preserve a retained application's CLI, session, capability and next user input", async t => {
  const f = await fixture(t); f.mcp = [{ name: "relay_one", status: "connected" }];
  await f.adapter.send("/run Keep this app"); const token = f.adapter.capability, session = f.adapter.sessionId;
  assert.equal((await f.adapter.send("/mcp reconnect relay_one")).text, 'Reconnected "relay_one".');
  assert.equal((await f.adapter.send("/mcp disable relay_one")).text, 'Disabled "relay_one".');
  assert.equal(f.mcp[0].status, "disabled");
  f.refuse = "mcp_toggle";
  await assert.rejects(f.adapter.send("/mcp enable relay_one"), /Native MCP control failed/);
  assert.equal(f.mcp[0].status, "disabled");
  f.refuse = null;
  assert.equal((await f.adapter.send("/mcp enable relay_one")).text, 'Enabled "relay_one".');
  await f.adapter.send("Continue with this literal prompt");
  assert.equal(f.inputs.at(-1).message.content, "Continue with this literal prompt");
  assert.equal(f.controls.filter(packet => packet.request.subtype === "initialize").length, 1);
  assert(!f.controls.some(packet => packet.request.subtype === "mcp_reconnect"));
  assert.equal(f.launches.length, 1); assert.equal(f.child.exitCode, null);
  assert.equal(f.adapter.sessionId, session); assert.equal(f.adapter.capability, token);
});

test("a retained application keeps gateway access past its initial capability lifetime without replacing the CLI", async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000000 });
  const f = await fixture(t);
  await f.adapter.send("/run Keep the application running");
  const token = f.adapter.capability, initial = f.broker.validate(token, "anthropic");
  for (let index = 0; index < 7; index++) t.mock.timers.tick(20000);
  assert(Date.now() > initial.expiresAt);
  await f.adapter.send("/verify Check the same application after two capability lifetimes");
  assert.equal(f.launches.length, 1); assert.equal(f.adapter.capability, token);
  assert(f.broker.validate(token, "anthropic"));
  await f.adapter.stop();
  t.mock.timers.tick(20000);
  assert.equal(f.broker.validate(token, "anthropic"), null);
});

test("application capabilities reject changed accounts, profiles, owners and companies before any more input", async t => {
  const changes = [
    f => { f.config.claude.providerKey = "different-private-key"; },
    f => { f.config.claude.upstreamBaseUrl = "https://different.invalid"; },
    f => { f.config.claude.authMode = "host"; },
    f => f.store.update(f.chat.id, { ownerId: "different-owner" }),
    f => f.store.update(f.chat.id, { environmentId: "different-profile" }),
    f => f.store.update(f.chat.id, { workspace: "/different/workspace" }),
    f => f.store.update(f.chat.id, { repositories: [{ fullName: "other-company/repository" }] }),
    f => f.store.update(f.chat.id, { archived: true }),
    f => { f.adapter.executor.runtimeHome = "/different/private-profile"; },
  ];
  for (const change of changes) {
    const f = await fixture(t); await f.adapter.send("/run Keep the application running");
    const token = f.adapter.capability, controls = f.controls.length;
    await change(f);
    assert.equal(f.broker.validate(token, "anthropic"), null);
    await assert.rejects(f.adapter.send("Do not cross the changed scope"), /account\/profile changed/);
    assert.equal(f.inputs.length, 1); assert.equal(f.controls.length, controls); assert.equal(f.launches.length, 1);
    assert.equal(f.child.exitCode, null); // No silent restart or destruction of the user's app.
  }
});

test("expiry during native settings rejects unsubmitted input without leaving a stuck logical application turn", async t => {
  const f = await fixture(t); await f.adapter.send("/run Keep the application running");
  const token = f.adapter.capability;
  f.hold = "set_model";
  const pending = f.adapter.send("Never submit this input"), rejected = assert.rejects(pending, /temporary gateway access expired/);
  await waitFor(() => f.controls.at(-1).request.subtype === "set_model");
  f.broker.revoke(token); f.respond(f.controls.at(-1)); await rejected;
  assert.equal(f.inputs.length, 1); assert.equal(f.adapter.applicationSession.active, null);
  assert.equal(f.child.exitCode, null); assert.equal(f.launches.length, 1);
  await f.adapter.stop(); f.hold = null;
  await f.adapter.send("Explicit retry after Stop");
  assert.equal(f.launches.length, 2); assert.notEqual(f.adapter.capability, token);
  assert.equal(f.broker.validate(token, "anthropic"), null);
});

test("Stop revokes before slow shutdown and cannot revoke a replacement capability when the old shutdown finishes", async t => {
  const f = await fixture(t); await f.adapter.send("/run Keep the application running");
  const token = f.adapter.capability, release = Promise.withResolvers();
  f.adapter.reviewInterruption = () => release.promise;
  const stopping = f.adapter.stop();
  assert.equal(f.broker.validate(token, "anthropic"), null);
  const replacement = f.broker.issue({ chatId: f.chat.id, provider: "anthropic" });
  release.resolve(); await stopping;
  assert(f.broker.validate(replacement, "anthropic")); f.broker.revoke(replacement);
});

test("background output is independent of a turn waiting for native controls and usage is not counted twice", async t => {
  const f = await fixture(t); await f.adapter.send("/run Launch app");
  f.hold = "apply_flag_settings";
  const running = f.adapter.send("/verify New user input");
  await waitFor(() => f.controls.some(packet => packet.request.subtype === f.hold));
  f.complete("A background task ended.");
  assert.equal(f.inputs.length, 1); assert.equal(f.events.filter(event => event.type === "background_response").length, 1);
  f.respond(f.controls.at(-1)); await running;
  const usage = f.events.filter(event => event.type === "usage").reduce((value, event) => mergeUsage(value, event.usage), null);
  assert.equal(usage.totals.inputTokens, 300); assert.equal(usage.totals.outputTokens, 30);
  assert(Math.abs(usage.costUsd - 0.3) < 1e-10);
  assert.equal(f.events.filter(event => event.type === "assistant_delta").map(event => event.delta).join(""), "Application turn completed.Application turn completed.");
  assert.equal(f.inputs.length, 2); assert.equal(f.launches.length, 1);
});

test("Auto uses the native effort reset before input and never pins later choices through the process environment", async t => {
  const f = await fixture(t);
  await f.adapter.send("/run Launch app", { model: "sonnet", resetEffort: true });
  assert.deepEqual(f.controls.map(packet => packet.request), [{ subtype: "initialize" }, { subtype: "apply_flag_settings", settings: { effortLevel: null } }]);
  assert.equal(f.launches[0].env.CLAUDE_CODE_EFFORT_LEVEL, undefined);
  for (const effort of ["high", "low", null, "medium"]) {
    await f.adapter.send(`Continue with ${effort || "Auto"}`, { model: "sonnet", effort, resetEffort: !effort });
    assert.deepEqual(f.controls.at(-1).request, { subtype: "apply_flag_settings", settings: { effortLevel: effort } });
  }
  assert.equal(f.launches.length, 1); assert.equal(f.child.exitCode, null); assert.equal(f.inputs.length, 5);
});

test("ordinary private Auto turns reset effort through the SDK rather than overriding the worker environment", async t => {
  const f = await fixture(t, { interactive: true });
  f.adapter.executor.environmentVariables = { CLAUDE_CODE_EFFORT_LEVEL: "medium" };
  await f.adapter.send("Use native Auto", { resetEffort: true });
  assert.equal(f.launches[0].env.CLAUDE_CODE_EFFORT_LEVEL, "medium");
  assert.deepEqual(f.controls.at(-1).request, { subtype: "apply_flag_settings", settings: { effortLevel: null } });
  assert.equal(f.events.filter(event => event.type === "notice" && /CLAUDE_CODE_EFFORT_LEVEL/.test(event.text)).length, 1);
  assert.notEqual(f.child.exitCode ?? f.child.signalCode, null);
});

test("changed effort environment requires explicit Stop without mutating controls, replaying input or killing the app", async t => {
  for (const initial of [undefined, "medium"]) {
    const f = await fixture(t);
    f.adapter.executor.environmentVariables = initial ? { CLAUDE_CODE_EFFORT_LEVEL: initial } : {};
    await f.adapter.send("/run Launch app", { resetEffort: true });
    assert.equal(f.launches[0].env.CLAUDE_CODE_EFFORT_LEVEL, initial);
    const controls = f.controls.length;
    f.adapter.executor.environmentVariables = { CLAUDE_CODE_EFFORT_LEVEL: "high" };
    await assert.rejects(f.adapter.send("Do not send with stale effort", { effort: "high" }), /effort environment changed/);
    assert.equal(f.controls.length, controls); assert.equal(f.inputs.length, 1); assert.equal(f.child.exitCode, null);
    f.adapter.executor.environmentVariables = initial ? { CLAUDE_CODE_EFFORT_LEVEL: initial } : {};
    await f.adapter.send("Explicit retry with original environment", { resetEffort: true });
    assert.equal(f.launches.length, 1); assert.equal(f.inputs.length, 2);
    if (initial) assert.equal(f.events.filter(event => event.type === "notice" && /CLAUDE_CODE_EFFORT_LEVEL/.test(event.text)).length, 1);
  }
});

test("Stop or rejection during the first native effort reset leaves no input, application process or resume ID", async t => {
  for (const stop of [false, true]) for (const ordinary of [false, true]) {
    const f = await fixture(t, { interactive: ordinary });
    if (stop) f.hold = "apply_flag_settings"; else f.refuse = "apply_flag_settings";
    const running = f.adapter.send(ordinary ? "Do not start yet" : "/run Do not start yet", { resetEffort: true });
    const rejected = assert.rejects(running, /control failed|closed|stopped|interrupted/);
    if (stop) { await waitFor(() => f.controls?.some(packet => packet.request.subtype === "apply_flag_settings")); await f.adapter.stop(); }
    await rejected;
    assert.deepEqual(f.inputs, []); assert.equal(f.adapter.sessionId, null); assert.deepEqual(f.sessions, []);
    assert.notEqual(f.child.exitCode ?? f.child.signalCode, null);
    f.hold = null; f.refuse = null;
    await f.adapter.send(ordinary ? "Explicit retry" : "/run Explicit retry", { resetEffort: true });
    assert.equal(f.inputs.length, 1); assert.equal(f.sessions.length, 1);
    assert(f.launches.at(-1).args.includes("--session-id")); assert(!f.launches.at(-1).args.includes("--resume"));
  }
});

test("Send now interruption checkpoints the first application turn and retains its CLI and capability", async t => {
  const f = await fixture(t); f.block = true; f.failInterrupt = true;
  const running = f.adapter.send("/run Launch app"), rejected = assert.rejects(running, /interrupted/);
  await waitFor(() => f.inputs?.length); const capability = f.adapter.capability;
  assert.deepEqual(f.sessions, []);
  await f.adapter.interrupt(); await rejected;
  assert.equal(f.child.exitCode, null); assert.deepEqual(f.signals, []); assert.equal(f.sessions.length, 1);
  assert.equal(f.adapter.capability, capability); f.block = false;
  await f.adapter.send("/verify Continue"); assert.equal(f.launches.length, 1);
});

test("Stop during initialization and failed startup leave no provisional journal or orphan native input", async t => {
  const f = await fixture(t); f.spawnFailure = true;
  await assert.rejects(f.adapter.send("/run Launch app"), /spawn failure/);
  assert.equal(f.adapter.sessionId, null); f.spawnFailure = false; f.hold = "initialize";
  const running = f.adapter.send("/run Launch app"), rejected = assert.rejects(running, /stopped/);
  await waitFor(() => f.controls?.length); await f.adapter.stop(); await rejected;
  assert.equal(f.adapter.sessionId, null); assert.deepEqual(f.sessions, []); assert.deepEqual(f.inputs, []);
  assert.equal(f.adapter.applicationSession, null);
  f.hold = null; await f.adapter.send("/run Retry explicitly"); assert.equal(f.sessions.length, 1);
  assert(f.launches[1].args.includes("--session-id")); assert(!f.launches[1].args.includes("--resume"));
});

test("rejected native settings preserve a running application and do not submit or replay user input", async t => {
  const f = await fixture(t); await f.adapter.send("/run Launch app"); const session = f.adapter.sessionId;
  f.refuse = "set_permission_mode";
  await assert.rejects(f.adapter.send("/verify Do not replay", { mode: "plan" }), /control failed/);
  assert.equal(f.inputs.length, 1); assert.equal(f.child.exitCode, null); assert.equal(f.adapter.sessionId, session);
  f.refuse = null; await f.adapter.send("/verify Explicit retry", { mode: "plan" }); assert.equal(f.launches.length, 1);
});

test("changed system instructions fail visibly before input instead of silently retaining a stale prompt", async t => {
  const f = await fixture(t); await f.adapter.send("/run Launch app", { systemPrompt: "First instructions" });
  await assert.rejects(f.adapter.send("Changed task", { systemPrompt: "New instructions" }), /system instructions changed/);
  assert.equal(f.inputs.length, 1); assert.equal(f.child.exitCode, null); assert.equal(f.launches.length, 1);
});

test("failed first application result closes its process and never retains a nonexistent journal", async t => {
  const f = await fixture(t); f.failResult = true;
  await assert.rejects(f.adapter.send("/run Fail"), /worker exited/);
  assert.equal(f.adapter.sessionId, null); assert.deepEqual(f.sessions, []); assert.equal(f.adapter.applicationSession, null);
});

test("Fast off immediately reaches a retained CLI without model input or account access", async t => {
  const f = await fixture(t); await f.adapter.send("/run Launch app");
  f.adapter.fetchImpl = () => { throw Error("Fast off must not inspect an account"); };
  const result = await f.adapter.send("/fast off");
  assert.equal(result.fastPreference, false); assert.equal(result.nativeFast.state, "off");
  assert.deepEqual(f.controls.at(-1).request, { subtype: "apply_flag_settings", settings: { fastMode: false } });
  assert.equal(f.inputs.length, 1); assert.equal(f.child.exitCode, null);
  f.refuse = "apply_flag_settings";
  await assert.rejects(f.adapter.send("/fast off"), /control failed/);
  assert.equal(f.inputs.length, 1);
});

test("a native process exiting cleanly without a result cannot report a successful run", async t => {
  const f = await fixture(t); f.block = true;
  const running = f.adapter.send("/run Launch app"), rejected = assert.rejects(running, /worker exited 1/);
  await waitFor(() => f.inputs?.length); f.child.stdin.end(); await rejected;
  assert.equal(f.adapter.sessionId, null); assert.deepEqual(f.sessions, []);
});

test("session accepts split UTF-8 input, handles native SDK controls and excludes an unrelated background result", async t => {
  const f = {}, background = [], session = new ClaudeSession(transport(f), [], {}, event => background.push(event));
  t.after(() => session.stop());
  const turn = await session.open([], {}), closed = once(turn, "close");
  f.complete("Unrelated result before the user input");
  assert.equal(turn.exitCode, null); assert.equal(background.at(-1).result, "Unrelated result before the user input");
  const bytes = Buffer.from("/run ação"); for (const byte of bytes) turn.stdin.write(Buffer.from([byte])); turn.stdin.end();
  await closed; assert.equal(f.inputs[0].message.content, "/run ação");
  const next = await session.open(["--input-format", "stream-json"], {}), nextClosed = once(next, "close");
  next.stdin.end(JSON.stringify({ type: "user", message: { role: "user", content: "/verify" } }));
  await nextClosed; assert.equal(f.inputs.length, 2); assert.equal(f.controls.filter(packet => packet.request.subtype === "initialize").length, 1);
});

test("cumulative model usage becomes per-result deltas, including model changes, resets and missing fields", () => {
  const previous = { modelUsage: { one: { inputTokens: 100, outputTokens: 10, costUSD: 0.1 } }, total_cost_usd: 0.1 };
  const current = { usage: { input_tokens: 50 }, modelUsage: { one: { inputTokens: 150, outputTokens: 15, costUSD: 0.15, contextWindow: 200000 }, two: { inputTokens: 20 } }, total_cost_usd: 0.2 };
  const delta = claudeCallResult(current, previous);
  assert.equal(delta.modelUsage.one.inputTokens, 50); assert.equal(delta.modelUsage.one.outputTokens, 5);
  assert.equal(delta.modelUsage.two.inputTokens, 20); assert.equal(delta.modelUsage.one.contextWindow, 200000);
  assert.deepEqual(delta.usage, current.usage); assert.equal(delta.total_cost_usd, 0.1);
  assert.equal(claudeCallResult(previous, current).modelUsage.one.inputTokens, 100);
  assert.equal(claudeCallResult(previous, current).total_cost_usd, 0.1);
  assert.deepEqual(claudeCallResult({ modelUsage: { broken: null } }, {}).modelUsage, {});
  assert.equal(claudeCallResult({}, {}).total_cost_usd, undefined);
  assert.equal(current.modelUsage.one.inputTokens, 150, "Do not mutate the native baseline");
});
